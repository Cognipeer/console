import { getConfig } from '@/lib/core/config';

/**
 * The rules of the route-declaration check, in one place. The registration hook
 * (server/api/plugin.ts, through assertRouteDeclared in routeRegistry.ts) and the
 * CI audit (src/__tests__/helpers/routeDeclarations.ts) both read them, so there
 * is a single list to review.
 */

/**
 * Service-resolving routes that are intentionally NOT wrapped by the permission
 * gate because they authenticate and authorize the caller themselves (HMAC links,
 * opener-bound cookies, static installers, websockets). Matched against
 * `METHOD /api/pattern`. Adding an entry needs a reason a reviewer can check.
 */
export const UNGATED_SERVICE_ROUTES: Array<{ match: RegExp; reason: string }> = [
  { match: /^[A-Z]+ \/api\/sandbox\/preview\//, reason: 'sandbox preview: HMAC-signed link verified by the handler' },
  { match: /^[A-Z]+ \/api\/gpu-fleet\/installer\.sh$/, reason: 'static agent installer script (no tenant data)' },
  { match: /^[A-Z]+ \/api\/gpu-fleet\/agent-bundle/, reason: 'static agent bundle download (no tenant data)' },
  { match: /^[A-Z]+ \/api\/(gpu-fleet|sandbox)\/terminal\/:[A-Za-z]+\/browser$/, reason: 'browser terminal websocket: cookie session + opener-bound token verified by the handler' },
  { match: /^[A-Z]+ \/api\/client\/v1\/realtime$/, reason: 'realtime websocket: authenticates and authorizes the token / session itself (assertRealtimeRbac, through the policy engine)' },
  { match: /^[A-Z]+ \/api\/client\/v1\/realtime\/twilio\//, reason: 'telephony webhook/stream: Twilio signature + stream token verified by the handler' },
];

/**
 * Paths that may resolve to "undeclared" without that being a defect: the global
 * session hook returns before any gate for them (public health probes, the
 * slug-addressed public endpoints, the machine endpoints that verify their own
 * bearer tokens), so no declaration is ever consulted. The registration check
 * skips them; the CI audit does not (it wants every /api route stated). The
 * predicates of plugin.ts (public path list, self-auth prefixes, which include
 * what an enterprise build contributes) are applied on top of this list.
 */
export const UNDECLARED_ROUTE_EXCEPTIONS: Array<{ match: RegExp; reason: string }> = [
  { match: /^\/api\/health\//, reason: 'liveness / readiness probes: public, no session' },
  { match: /^\/api\/public\//, reason: 'slug-addressed public endpoints: the handler checks the access mode of the target' },
  { match: /^\/api\/(gpu|sandbox)\/agent\//, reason: 'machine endpoints: the handler verifies its own agent bearer token' },
];

/**
 * Whether an undeclared route must stop the server from registering it. On under
 * test (NODE_ENV=test) and when AUTHZ_STRICT_REGISTRATION=1 (config.iam.strictRegistration);
 * elsewhere the check only logs, because the request-time gate already refuses an
 * undeclared route (403 route_not_declared) and a production server must never fail
 * to boot over it. A configuration that cannot be read counts as "not strict".
 */
export function isStrictRouteRegistration(
  config: { nodeEnv?: string; iam?: { strictRegistration?: boolean } } | undefined = readConfig(),
): boolean {
  return config?.nodeEnv === 'test' || config?.iam?.strictRegistration === true;
}

function readConfig(): { nodeEnv?: string; iam?: { strictRegistration?: boolean } } | undefined {
  try {
    return getConfig();
  } catch {
    return undefined;
  }
}
