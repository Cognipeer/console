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
 *
 * `buildServicePrincipal` is the same principal as an engine principal, for the
 * decisions about a RESOURCE (resourceAuthz.ts: answering an approval, session
 * access) that must see exactly what the gate saw.
 */

import type { IGroup } from '@/lib/database';
import type { ServiceOff } from '@/lib/services/availability/serviceAvailability';
import {
  getRequiredPermissionLevel,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { authorize, describeTenantPolicySet } from './engine';
import { managedLevel, probeServiceLevel, type EffectiveLevel } from './effective';
import { buildEnforcePrincipal, decideEnforced } from './enforce';
import type { IamPrincipal } from './entities';
import { serviceActionId } from './actions';
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
  /**
   * Set when the service is switched off for the tenant (environment or license): nobody may use it, so no
   * decision is asked. A handler filtering by service only reads `allowed`; a route refusing the request answers
   * it as `service_disabled` / `service_not_licensed` (serviceRefusalError).
   */
  off?: ServiceOff;
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

/**
 * The engine principal of a request the handler already resolved: the person or the
 * token's owner, the groups' grants, the project narrowing and the token scope as a cap -
 * built by the very function the gate decides with. Throws when it cannot be built (the
 * HTTP wrapper answers 503, as the gate does).
 */
export async function buildServicePrincipal(
  principal: ServiceAuthzPrincipal,
  options: ServiceAuthzOptions & { service?: PermissionService } = {},
): Promise<IamPrincipal> {
  return buildEnforcePrincipal({
    subject: principal.subject,
    tenantDbName: principal.tenantDbName,
    tenantId: principal.tenantId,
    requestId: options.requestId ?? 'unknown',
    method: options.method ?? 'POST',
    route: options.route ?? 'handler:resource',
    userId: principal.userId,
    user: principal.user,
    groupGrants: principal.groupGrants,
    groups: principal.groups,
    tokenId: principal.tokenId,
    tokenScope: principal.tokenScope,
    requestedProjectId: principal.projectId ?? null,
    projectFromPath: principal.projectFromPath,
    service: options.service ?? 'agents',
    level: options.level,
    ip: principal.ip,
    path: principal.path,
  });
}

/**
 * The level the caller holds on `service`, as the engine decides it - asked QUIETLY: no decision counter, no
 * log line, no audit row, no decision id. For a handler that has to know what a person may do in order to
 * shape its answer (which rows to include, which controls the page shows), where a "no" is not a refusal.
 *
 * `workspace: true` asks about the WORKSPACE ITSELF: the level the person holds outside any project, before a
 * project's own limits narrow it. A token never answers that question (`none`): it is bound to one project and
 * acts only there, whoever owns it. Custom rules that name a project do not apply to a workspace-level answer
 * (there is no project in its context). Throws when the engine cannot decide; the HTTP wrapper answers 503.
 */
export async function quietServiceLevel(
  principal: ServiceAuthzPrincipal,
  service: PermissionService,
  options: { workspace?: boolean } = {},
): Promise<EffectiveLevel> {
  const workspace = options.workspace === true;
  if (workspace && principal.subject === 'token') return 'none';
  const engine = await quietEnginePrincipal(principal, service, workspace);
  const policySet = await describeTenantPolicySet(principal.tenantDbName);
  // No custom policy in force: the managed rules are arithmetic over the principal's own level sets (effective.ts).
  if (policySet.custom === 0) return managedLevel(engine, service);
  const { level } = await probeServiceLevel(principal.tenantDbName, engine, service, quietContext(principal, engine, workspace));
  return level;
}

/**
 * Whether the engine allows ONE action of a service - `<service>.<level>` and only that - asked quietly like
 * `quietServiceLevel` (same principal, same workspace rule: a token never answers a workspace question). The
 * level ladder (`quietServiceLevel`) counts a level only when every lower one is allowed; this does not, so it
 * answers exactly what a route gate that asks for `<service>.<level>` would: a deny rule that names Write leaves
 * Admin allowed, and the other way round. For a handler that shows or hides what such a route lets the caller do.
 */
export async function quietServiceAllows(
  principal: ServiceAuthzPrincipal,
  service: PermissionService,
  level: RouteAuthzLevel,
  options: { workspace?: boolean } = {},
): Promise<boolean> {
  const workspace = options.workspace === true;
  if (workspace && principal.subject === 'token') return false;
  const engine = await quietEnginePrincipal(principal, service, workspace);
  const policySet = await describeTenantPolicySet(principal.tenantDbName);
  // Nothing custom in force: the managed rules give one level per service, and no rule can deny a lower level on its own.
  if (policySet.custom === 0) {
    const held = managedLevel(engine, service);
    return level === 'read' ? held !== 'none' : level === 'write' ? held === 'write' || held === 'admin' : held === 'admin';
  }
  const res = await authorize({
    tenant: principal.tenantDbName,
    principal: engine,
    action: serviceActionId(service, level),
    resource: { kind: 'service', service },
    context: quietContext(principal, engine, workspace),
  });
  if (res.failed) throw new Error(res.errors.join('; ') || 'the engine could not decide');
  return res.allowed;
}

function quietEnginePrincipal(principal: ServiceAuthzPrincipal, service: PermissionService, workspace: boolean): Promise<IamPrincipal> {
  return buildEnforcePrincipal({
    subject: principal.subject,
    tenantDbName: principal.tenantDbName,
    tenantId: principal.tenantId,
    requestId: 'handler-level',
    method: 'GET',
    route: `handler:${service}`,
    userId: principal.userId,
    user: principal.user,
    groupGrants: principal.groupGrants,
    groups: principal.groups,
    tokenId: principal.tokenId,
    tokenScope: principal.tokenScope,
    requestedProjectId: workspace ? null : principal.projectId ?? null,
    projectFromPath: workspace ? false : principal.projectFromPath,
    skipProjectNarrowing: workspace,
    service,
    ip: principal.ip,
    path: principal.path,
  });
}

function quietContext(principal: ServiceAuthzPrincipal, engine: IamPrincipal, workspace: boolean) {
  return {
    ...(workspace ? {} : { projectId: engine.contextProjectId }),
    channel: principal.subject === 'token' ? ('api' as const) : ('dashboard' as const),
    ip: principal.ip,
    path: principal.path,
  };
}
