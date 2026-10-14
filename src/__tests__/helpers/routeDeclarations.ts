/**
 * Route-declaration audit used by the CI guard (unit/iam-route-declarations).
 *
 * `collectApiRoutes()` builds the real API (fastifyApiPlugin: every community
 * plugin plus, in an enterprise build tree, the overlay's plugins) and records
 * each route through an `onRoute` hook. `auditRouteDeclarations()` returns the
 * list of problems; an empty list is the CI contract:
 *
 *   - every /api route has an explicit `config.authz` or resolves through
 *     ROUTE_PREFIXES / the path resolvers (no UNDECLARED route);
 *   - `public` routes are covered by the global public path list (where the
 *     global hook skips authentication, so no gate can run for them anyway);
 *   - `authenticated` routes are not prefix-mapped (that would widen access: any
 *     signed-in caller would pass instead of the service's level) and are not under
 *     a public / self-auth prefix;
 *   - a `service` declaration that disagrees with the prefix map is a conflict;
 *   - routes under a SELF-AUTH prefix (machine endpoints that verify their own
 *     bearer tokens: plugin.ts SELF_AUTH_API_PREFIXES) are declared `self` or
 *     `public`, never left to the prefix map;
 *   - a `public` / `self` declaration on a prefix-mapped path is refused: the gate
 *     honours the explicit declaration and skips the service check, so it would
 *     widen access (machine endpoints under a self-auth prefix are the legitimate
 *     exception: nothing gates them);
 *   - every route that resolves to a SERVICE runs the permission gate, i.e. its
 *     handler comes from withApiRequestContext / withClientApiRequestContext
 *     (tagged with GATED_HANDLER). A service-mapped route registered with a bare
 *     handler is decided by nothing; the ones that legitimately authenticate and
 *     authorize themselves are listed in UNGATED_SERVICE_ROUTES with the reason.
 *
 * NOT checked, on purpose: a route that merely resolves through the prefix map
 * while its path sits in the public list (e.g. token-authenticated realtime
 * routes under a public prefix). Those are gated by the token wrapper and must
 * stay service-mapped; declaring them public or self would WIDEN access.
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { classifyRoute, concretePath, type RegisteredRoute } from '@/lib/iam/routeRegistry';
import { isGatedHandler, resolveRouteAuthz } from '@/lib/iam/routeAuthz';
import { fastifyApiPlugin, isPublicApiPath, isSelfAuthApiPath } from '@/server/api/plugin';

export interface CollectedRoute extends RegisteredRoute {
  /** Raw `config.authz` of the route, when present. */
  authz?: unknown;
  /** The handler (or a preHandler / onRequest hook) is wrapped by the permission gate. */
  gated?: boolean;
  /** WebSocket upgrade route (the HTTP handler wrappers do not apply). */
  websocket?: boolean;
}

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

export async function collectApiRoutes(): Promise<CollectedRoute[]> {
  const app = Fastify({ logger: false });
  const routes: CollectedRoute[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const hooks = [route.handler, route.preHandler, route.onRequest, route.preValidation]
      .flatMap((h) => (Array.isArray(h) ? h : [h]));
    const gated = hooks.some((h) => isGatedHandler(h));
    const websocket = Boolean((route as { websocket?: boolean }).websocket)
      || typeof (route as { wsHandler?: unknown }).wsHandler === 'function';
    for (const method of methods) {
      routes.push({
        method,
        url: route.url,
        ...classifyRoute(route.url, route.config),
        authz: (route.config as { authz?: unknown } | undefined)?.authz,
        gated,
        websocket,
      });
    }
  });
  await app.register(cookie);
  await app.register(fastifyApiPlugin, { prefix: '/api' });
  await app.ready();
  await app.close();
  return routes.filter((r) => r.url.startsWith('/api'));
}

export function auditRouteDeclarations(routes: CollectedRoute[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.url}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const path = concretePath(route.url);
    const resolution = resolveRouteAuthz(route.authz === undefined ? undefined : { authz: route.authz }, path);
    const { declaration, prefixService, effective } = resolution;
    const publicPath = isPublicApiPath(path);
    const selfAuthPath = isSelfAuthApiPath(path);

    if (route.authz !== undefined && !declaration) {
      problems.push(`${key}: malformed config.authz ${JSON.stringify(route.authz)}`);
      continue;
    }
    if (effective.kind === 'undeclared') {
      problems.push(`${key}: UNDECLARED (add config: authz.<kind>(...) or map its prefix in ROUTE_PREFIXES)`);
      continue;
    }

    if (declaration?.kind === 'public') {
      if (!publicPath) problems.push(`${key}: declared public but not covered by the global public path list (plugin.ts PUBLIC_API_PATHS / PUBLIC_API_PREFIXES)`);
    }
    if (declaration?.kind === 'authenticated') {
      if (prefixService) problems.push(`${key}: declared authenticated but its path is mapped to the "${prefixService}" service (that would widen access: any signed-in caller would pass)`);
      if (publicPath || selfAuthPath) problems.push(`${key}: declared authenticated but sits under a public / self-auth prefix, where no session or token is checked`);
    }
    if ((declaration?.kind === 'public' || declaration?.kind === 'self') && prefixService
      && !selfAuthPath && (!publicPath || route.gated === true)) {
      problems.push(`${key}: declared ${declaration.kind} but its path is mapped to the "${prefixService}" service (the gate would skip the service check: access widens)`);
    }
    if (effective.kind === 'service' && route.gated === false) {
      const allowed = UNGATED_SERVICE_ROUTES.some((entry) => entry.match.test(key));
      if (!allowed) {
        problems.push(`${key}: resolves to the "${effective.service}" service but its handler is not wrapped by withApiRequestContext / withClientApiRequestContext, so NO gate decides it (wrap it, or list it in UNGATED_SERVICE_ROUTES with the reason it authorizes itself)`);
      }
    }
    if (declaration?.kind === 'service' && prefixService && declaration.service !== prefixService) {
      problems.push(`${key}: declares service "${declaration.service}" but its path prefix maps to "${prefixService}"`);
    }
    if (selfAuthPath && declaration?.kind !== 'self' && declaration?.kind !== 'public') {
      problems.push(`${key}: sits under a self-auth prefix (machine endpoint) so it must be declared self (or public), not left to the prefix map`);
    }
  }
  return problems;
}
