/**
 * Handler-level service checks.
 *
 * The route gate (fastify-utils.ts) decides whether a request may reach a route.
 * Some handlers make a SECOND, finer decision after the gate: "which dashboards
 * may this user see", "may this caller run a realtime session with its own
 * generator", "may this member create a subprocess MCP server". They ask the
 * same engine, with the same principal as the gate (the owner's group grants for
 * tokens, the project narrowing, custom policies, the token scope as a cap), so a
 * service the gate would have refused cannot be reached through them.
 *
 * `authorizeServiceAccess` is that decision for a principal the caller already
 * resolved. When the engine cannot decide, the answer is a refusal with
 * `unavailable: true` (the HTTP wrapper `authorizeServiceForRequest` turns it
 * into the 503 the gate would have sent) - never an allow.
 */

import type { IGroup } from '@/lib/database';
import {
  getRequiredPermissionLevel,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { decideEnforced } from './enforce';
import type { RouteAuthzLevel } from './routeAuthz';

export interface ServiceAuthzPrincipal {
  subject: 'session' | 'token';
  tenantDbName: string;
  tenantId: string;
  /** Session user, or the token OWNER. */
  userId: string;
  user: RbacUserLike & { projectIds?: string[] };
  /** Session: the grants of the user (omitted = the cached principal context's). Token: ignored (the owner's groups are read). */
  groupGrants?: GroupTenantGrant[];
  /** Session: the groups behind `groupGrants`, when the caller has them. */
  groups?: IGroup[];
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
}

export interface ServiceAuthzResult {
  allowed: boolean;
  service: PermissionService;
  required: ServicePermissionLevel;
  /** Present on a refusal: the id of the decision (also in the audit trail) the caller can quote. */
  decisionId?: string;
  /**
   * True when the engine could not decide (so `allowed` is false, and the caller
   * should answer 503 `authorization_unavailable`, not 403).
   */
  unavailable?: true;
}

export async function authorizeServiceAccess(
  principal: ServiceAuthzPrincipal,
  service: PermissionService,
  options: ServiceAuthzOptions = {},
): Promise<ServiceAuthzResult> {
  const method = options.method ?? 'GET';
  const verdict = await decideEnforced({
    subject: principal.subject,
    tenantDbName: principal.tenantDbName,
    tenantId: principal.tenantId,
    requestId: options.requestId ?? 'unknown',
    method,
    route: options.route ?? `handler:${service}`,
    userId: principal.userId,
    user: principal.user,
    groupGrants: principal.groupGrants,
    groups: principal.groups,
    tokenId: principal.tokenId,
    tokenScope: principal.tokenScope,
    requestedProjectId: principal.projectId ?? null,
    projectFromPath: principal.projectFromPath,
    service,
    level: options.level,
    ip: principal.ip,
    path: principal.path,
  });
  if (verdict.allowed) {
    return { allowed: true, service, required: options.level ?? getRequiredPermissionLevel(method, service) };
  }
  return {
    allowed: false,
    service,
    required: verdict.required,
    decisionId: verdict.decisionId,
    ...(verdict.unavailable ? { unavailable: true as const } : {}),
  };
}
