/**
 * Handler-level service checks that follow the tenant's authorization mode.
 *
 * The route gate (fastify-utils.ts) decides whether a request may reach a route.
 * Some handlers make a SECOND, finer decision after the gate: "which dashboards
 * may this user see", "may this caller run a realtime session with its own
 * generator", "may this member create a subprocess MCP server". Those used to
 * call rbac.ts directly, which is the legacy answer only: in enforce mode they
 * ignored the policy engine (custom forbid policies), the project-level
 * narrowing and (for tokens) the owner's group grants, so a service the gate
 * would have refused could still be reached through them.
 *
 * `authorizeServiceAccess` is that decision for a principal the caller already
 * resolved. Legacy / shadow tenants (and IAM_ENFORCE_DISABLED) get exactly the
 * rbac.ts answer they always got; enforce tenants get the engine's, with the
 * same never-fail-open-beyond-legacy fallback as the gate.
 */

import {
  authorizeService,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import type { RouteAuthzLevel } from './routeAuthz';
import { resolveEnforcement } from './shadow/mode';

export interface ServiceAuthzPrincipal {
  subject: 'session' | 'token';
  tenantDbName: string;
  tenantId: string;
  /** Session user, or the token OWNER. */
  userId: string;
  user: RbacUserLike & { projectIds?: string[] };
  /** Session: the grants of the user. Token: ignored in enforce mode (the owner's groups are read), legacy tokens have none. */
  groupGrants?: GroupTenantGrant[];
  tokenId?: string;
  tokenScope?: UserServicePermissions | null;
  /** The project the route path names, else cookie `active_project_id` (session) or the token's project: the project the request runs in. */
  projectId?: string | null;
  /** `projectId` came from the route path: the request acts on that project. */
  projectFromPath?: boolean;
  /** Caller address (`request.ip`, trust-proxy aware) and request path: policy context `ip` / `path`. */
  ip?: string | null;
  path?: string;
}

export interface ServiceAuthzOptions {
  /** HTTP method the capability behaves like (default GET => read). Ignored when `level` is given. */
  method?: string;
  /** Required level, overriding the method-derived one. */
  level?: RouteAuthzLevel;
  requestId?: string;
  /** Route label for logs. */
  route?: string;
  /**
   * The legacy (rbac.ts) verdict, when the caller already computed it with
   * authorizeServiceRequest. Otherwise it is computed here.
   */
  legacy?: { allowed: boolean; required?: ServicePermissionLevel };
}

export interface ServiceAuthzResult {
  allowed: boolean;
  service: PermissionService;
  required: ServicePermissionLevel;
  /** Present on an enforce-mode (engine) denial. */
  decisionId?: string;
  /** True when the policy engine (enforce mode) made the decision. */
  enforced: boolean;
}

export async function authorizeServiceAccess(
  principal: ServiceAuthzPrincipal,
  service: PermissionService,
  options: ServiceAuthzOptions = {},
): Promise<ServiceAuthzResult> {
  const method = options.method ?? 'GET';
  const legacyGrants = principal.subject === 'session' ? (principal.groupGrants ?? []) : [];
  const legacy = options.legacy
    ? { allowed: options.legacy.allowed, required: options.legacy.required ?? options.level ?? 'read' }
    : authorizeService(principal.user, method, service, legacyGrants, principal.tokenScope, options.level);

  if (!(await resolveEnforcement(principal.tenantDbName))) {
    return { allowed: legacy.allowed, service, required: legacy.required, enforced: false };
  }

  const { decideEnforced } = await import('./enforce');
  const verdict = await decideEnforced({
    subject: principal.subject,
    tenantDbName: principal.tenantDbName,
    tenantId: principal.tenantId,
    requestId: options.requestId ?? 'unknown',
    method,
    route: options.route ?? `handler:${service}`,
    userId: principal.userId,
    user: principal.user,
    groupGrants: principal.groupGrants ?? [],
    tokenId: principal.tokenId,
    tokenScope: principal.tokenScope,
    requestedProjectId: principal.projectId ?? null,
    projectFromPath: principal.projectFromPath,
    service,
    level: options.level,
    legacyAllowed: legacy.allowed,
    ip: principal.ip,
    path: principal.path,
  });
  return verdict.allowed
    ? { allowed: true, service, required: legacy.required, enforced: verdict.source === 'engine' }
    : {
        allowed: false,
        service,
        required: verdict.required,
        decisionId: verdict.decisionId,
        enforced: verdict.source === 'engine',
      };
}
