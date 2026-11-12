import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { IGroup, IUser } from '@/lib/database';
import {
  getRequiredPermissionLevel,
  type GroupTenantGrant,
  type PermissionService,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';
import {
  decideEnforced,
  forbiddenBody,
  recordAuthorizationUnavailable,
  recordEnforcedDenial,
  recordUndeclaredDenial,
  undeclaredRouteBody,
  unavailableBody,
  type EnforceDecision,
  type EnforceDenial,
  type EnforceGateInput,
  type EnforceUnavailable,
  type EnforceUnavailableReason,
} from '@/lib/iam/enforce';
import { resolveRouteAuthz, type EffectiveRouteAuthz, type RouteAuthzLevel, type RouteAuthzResolution } from '@/lib/iam/routeAuthz';
import {
  authorizeServiceAccess,
  buildServicePrincipal,
  quietServiceAllows,
  quietServiceLevel,
  type ServiceAuthzOptions,
  type ServiceAuthzPrincipal,
  type ServiceAuthzResult,
} from '@/lib/iam/requestAuthz';
import type { EffectiveLevel } from '@/lib/iam/effective';
import {
  authorizeResourceForPrincipal,
  type ResourceAuthzAction,
  type ResourceAuthzResult,
  type ResourceAuthzSubject,
} from '@/lib/iam/resourceAuthz';
import { auditLevelOf } from '@/lib/iam/denialAudit';
import { serviceDenialReason } from '@/lib/iam/denialReason';
import type { IamResource } from '@/lib/iam/entities';
import { canonicalRoute } from '@/lib/iam/routePattern';
import { getEnterpriseModuleForPath } from '@/lib/license/enterprise-access';
import { ServiceDisabledError, serviceOffReason } from '@/lib/services/availability/serviceAvailability';
import { isTenantRole } from '@/lib/iam/identity';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { getAuthzClientIp, getRequestPathname } from './request';
import { RbacAuthorizationError, AUTHORIZATION_RETRY_AFTER_SECONDS } from './rbacError';
import { type ApiSessionContext, getSessionContext, requireSessionContext, loadSessionAuthz, resolveSessionRbacContext } from './session';
import { requireApiTokenContext } from './apiToken';

/** What a handler-level check may carry along so the user row and the groups are not read twice. */
type SessionRbacHint = { user: IUser; groupGrants: GroupTenantGrant[]; groups?: IGroup[] };

/**
 * A second, handler-level service check (after the route gate): the policy
 * engine decides, exactly as it does for the gate (the owner's group grants for
 * tokens, the project narrowing, custom policies, the token scope as a cap).
 * Use it instead of calling rbac.ts directly whenever a handler decides on a
 * permission service itself (per-item filtering, an extra "admin only" switch).
 * Works for dashboard sessions and for API-token requests.
 *
 * A refusal resolves `{ allowed: false, decisionId }` (the handler's 403 then
 * carries the decision as X-Decision-Id). When the engine cannot decide at all it
 * THROWS the 503 `authorization_unavailable` refusal the gate would have sent -
 * which `withApiRequestContext` / `withClientApiRequestContext` turn into the
 * response - so a handler that merely tests `.allowed` can never read an outage
 * as an answer.
 *
 * A service switched off for the tenant resolves `{ allowed: false, off }` before
 * any permission is asked: a handler filtering by service hides it like one the
 * caller may not read, and serviceRefusalError answers it as `service_disabled`.
 */
export async function authorizeServiceForRequest(
  request: FastifyRequest,
  service: PermissionService,
  options: ServiceAuthzOptions & { rbac?: SessionRbacHint } = {},
): Promise<ServiceAuthzResult> {
  // The resource a route serves can belong to a switched-off service even when the route's own service is on
  // (`/responses` with an agent while agents are off).
  const off = await serviceOffRefusal(request, service, options);
  if (off) return off;
  const result = await decideServiceForRequest(request, service, options);
  if (!result.allowed && result.decisionId) {
    if (result.unavailable) {
      throw unavailableError(request, { decisionId: result.decisionId, service, required: result.required });
    }
    // A refusal the handler turns into a 403 names its decision (X-Decision-Id).
    request.iamDecisionId = result.decisionId;
  }
  return result;
}

/**
 * The refusal a handler-level check resolves when `service` is switched off for the request's tenant, or null
 * when it is on. Also for a service the gate admitted the caller on (`request.iamGateService`): that skips the
 * second permission question, but the gate refuses an `anyOf` route only when all of its services are off.
 */
export async function serviceOffRefusal(
  request: FastifyRequest,
  service: PermissionService,
  options: Pick<ServiceAuthzOptions, 'level' | 'method'> = {},
): Promise<ServiceAuthzResult | null> {
  const tenantId = request.apiTokenContext?.tenantId ?? getSessionContext(request)?.tenantId;
  if (!tenantId) return null;
  const off = await serviceOffReason({ tenantId }, service);
  if (!off) return null;
  return { allowed: false, service, required: options.level ?? getRequiredPermissionLevel(options.method ?? 'GET', service), off };
}

async function decideServiceForRequest(
  request: FastifyRequest,
  service: PermissionService,
  options: ServiceAuthzOptions & { rbac?: SessionRbacHint },
): Promise<ServiceAuthzResult> {
  const requestId = request.apiRequestId ?? 'unknown';
  const route = routeLabel(request, getRequestPathname(request));
  const common = { requestId, route, method: options.method, level: options.level };

  const principal = await requestPrincipal(request, service, {
    rbac: options.rbac,
    required: options.level ?? getRequiredPermissionLevel(options.method ?? 'GET', service),
  });
  if (!principal) {
    return { allowed: false, service, required: options.level ?? 'read' };
  }
  return authorizeServiceAccess(principal, service, common);
}

/**
 * Who is asking, as the engine is told: the token's owner with the token's scope, or the session
 * user with their groups - the same description the gate decides with. Null for a token whose owner
 * could not be loaded (nothing to decide for; the handler answers 403). Throws the 503 when a
 * session's authorization context cannot be loaded.
 */
/** The session's user row and groups, read once per request however many handler-level questions it asks. */
const sessionRbacOfRequest = new WeakMap<FastifyRequest, Promise<SessionRbacHint>>();

function sessionRbacFor(request: FastifyRequest, session: ApiSessionContext): Promise<SessionRbacHint> {
  let loading = sessionRbacOfRequest.get(request);
  if (!loading) {
    loading = resolveSessionRbacContext(session);
    sessionRbacOfRequest.set(request, loading);
    // A failed read is not remembered: the next question tries again.
    loading.catch(() => sessionRbacOfRequest.delete(request));
  }
  return loading;
}

/**
 * For a request that outlives its first check - an event stream followed for as long as an hour: forget what was
 * loaded about the caller when it started, so the next handler-level decision reads them again (their role and
 * groups for a session; the token itself - revoked, expired, no longer allowed from this address - for a token,
 * which throws like the first authentication did). The policy set and the engine's own caches are read fresh by
 * every decision already.
 */
export async function refreshRequestPrincipal(request: FastifyRequest): Promise<void> {
  sessionRbacOfRequest.delete(request);
  if (request.apiTokenContext) request.apiTokenContext = await requireApiTokenContext(request);
}

async function requestPrincipal(
  request: FastifyRequest,
  service: PermissionService,
  options: { rbac?: SessionRbacHint; required: ServicePermissionLevel; projectId?: string | null },
): Promise<ServiceAuthzPrincipal | null> {
  const tokenContext = request.apiTokenContext;
  if (tokenContext) {
    if (!tokenContext.user) return null;
    return {
      subject: 'token',
      tenantDbName: tokenContext.tenantDbName,
      tenantId: tokenContext.tenantId,
      userId: String(tokenContext.user._id),
      user: tokenContext.user,
      tokenId: tokenContext.tokenRecord._id ? String(tokenContext.tokenRecord._id) : undefined,
      tokenScope: tokenContext.tokenRecord.servicePermissions,
      projectId: tokenContext.projectId ? String(tokenContext.projectId) : null,
      ip: getAuthzClientIp(request),
      path: getRequestPathname(request),
    };
  }

  const session = requireSessionContext(request);
  let rbac: SessionRbacHint;
  try {
    rbac = options.rbac ?? await sessionRbacFor(request, session);
  } catch (error) {
    if (error instanceof RbacAuthorizationError) throw error;
    throw authorizationUnavailable(request, session.tenantDbName, 'principal_unavailable', error, {
      service,
      required: options.required,
    });
  }
  const project = options.projectId
    ? { projectId: options.projectId, fromPath: true }
    : sessionProject(request);
  return {
    subject: 'session',
    tenantDbName: session.tenantDbName,
    tenantId: session.tenantId,
    userId: String(rbac.user._id),
    user: rbac.user,
    groupGrants: rbac.groupGrants,
    groups: rbac.groups,
    projectId: project.projectId,
    projectFromPath: project.fromPath,
    ip: getAuthzClientIp(request),
    path: getRequestPathname(request),
  };
}

/**
 * What the caller holds on `service`, asked QUIETLY (no counter, log or audit row: a "no" here shapes an answer, it
 * is not a refusal). `workspace: true` asks about the workspace itself, outside any project; a token never answers
 * that (see `quietServiceLevel`). When the engine cannot decide it throws the 503 the gate would have sent.
 */
export async function serviceLevelForRequest(
  request: FastifyRequest,
  service: PermissionService,
  /** `projectId`: the project the question is about, when the handler has already checked it is the request's (else the cookie's, or the token's). */
  options: { workspace?: boolean; rbac?: SessionRbacHint; projectId?: string | null } = {},
): Promise<EffectiveLevel> {
  const principal = await requestPrincipal(request, service, { rbac: options.rbac, required: 'read', projectId: options.projectId });
  if (!principal) return 'none';
  try {
    return await quietServiceLevel(principal, service, { workspace: options.workspace });
  } catch (error) {
    throw authorizationUnavailable(request, principal.tenantDbName, 'evaluation_error', error, { service, required: 'read' });
  }
}

/**
 * Does the engine allow the caller exactly `<service>.<level>` (and nothing else is asked), QUIETLY - the question a
 * route that declares `authz.service(service, level)` puts to its gate - so a page can show or hide what that route
 * would let the caller do. Unlike `serviceLevelForRequest` it does not climb the read -> write -> admin ladder: a deny
 * rule that names one action leaves the others as they are. `workspace: true` asks about the workspace itself (a
 * token never answers that: false). When the engine cannot decide it throws the 503 the gate would have sent.
 */
export async function serviceActionAllowedForRequest(
  request: FastifyRequest,
  service: PermissionService,
  level: RouteAuthzLevel,
  options: { workspace?: boolean; rbac?: SessionRbacHint; projectId?: string | null } = {},
): Promise<boolean> {
  const principal = await requestPrincipal(request, service, { rbac: options.rbac, required: level, projectId: options.projectId });
  if (!principal) return false;
  try {
    return await quietServiceAllows(principal, service, level, { workspace: options.workspace });
  } catch (error) {
    throw authorizationUnavailable(request, principal.tenantDbName, 'evaluation_error', error, { service, required: level });
  }
}

export interface ResourceRequestAuthzInput {
  /** The service whose principal the decision is made with. Default `agents` (the session verbs); a portal's verbs pass `portals`. */
  service?: PermissionService;
  /** A session action of an agent (`agent.approve`, `agent.session_view_others`, `agent.session_manage_others`). */
  action: ResourceAuthzAction;
  /** The agent together with the session it is asked about (agentSessionResource). */
  resource: IamResource;
  subject?: ResourceAuthzSubject;
  /**
   * The project the session belongs to, when the handler has already checked it is the request's:
   * a SESSION request is then decided in exactly that project (narrowing and `context.projectId`),
   * not in whichever one the caller's cookie names. A token always runs in its own project.
   */
  projectId?: string | null;
  rbac?: SessionRbacHint;
  /** The answer shapes a response (a list's scope) rather than refuses a request: a "no" leaves no decision id, log or audit row. */
  quiet?: boolean;
}

/**
 * A handler-level decision about a RESOURCE (after the route gate): the policy engine
 * decides, with the very principal the gate used - the person or the token's owner, the
 * project narrowing, the token scope as a cap - so a rule that names a project, a channel
 * or a group sees what the gate saw. Works for dashboard sessions and API tokens.
 *
 * Like `authorizeServiceForRequest`: a refusal resolves `{ allowed: false, decisionId }` (the
 * handler's 403 then carries it as X-Decision-Id; the refusal is audited with what decided it),
 * and when the engine cannot decide at all it THROWS the 503 `authorization_unavailable` the gate
 * would have sent, so a handler that merely tests `.allowed` can never read an outage as an answer.
 * A token whose owner cannot be loaded is refused without a decision id (403).
 */
export async function authorizeResourceForRequest(
  request: FastifyRequest,
  input: ResourceRequestAuthzInput,
): Promise<ResourceAuthzResult> {
  const required = auditLevelOf(input.action);
  const service: PermissionService = input.service ?? 'agents';
  const requestId = request.apiRequestId ?? 'unknown';
  const route = routeLabel(request, getRequestPathname(request));
  const principal = await requestPrincipal(request, service, { rbac: input.rbac, required, projectId: input.projectId });
  if (!principal) return { allowed: false, source: 'engine', reasons: [], policyIds: [] };

  let engine;
  try {
    engine = await buildServicePrincipal(principal, { service, requestId, route, method: 'POST' });
  } catch (error) {
    throw authorizationUnavailable(request, principal.tenantDbName, 'principal_unavailable', error, { service, required });
  }
  const userAgent = request.headers['user-agent'];
  const result = await authorizeResourceForPrincipal({
    tenantDbName: principal.tenantDbName,
    tenantId: principal.tenantId,
    userId: principal.userId,
    principal: engine,
    channel: principal.subject === 'token' ? 'api' : 'dashboard',
    action: input.action,
    resource: input.resource,
    subject: input.subject,
    client: {
      ip: principal.ip,
      requestId,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      method: request.method,
      path: principal.path,
    },
    // The 503 below is audited by the response hook with the same decision id.
    auditUnavailable: false,
    quiet: input.quiet,
  });
  if (!result.allowed && result.decisionId) {
    if (result.unavailable) {
      throw unavailableError(request, { decisionId: result.decisionId, service, required, action: input.action, projectId: engine.contextProjectId });
    }
    request.iamDecisionId = result.decisionId;
  }
  return result;
}

/**
 * What a thrown handler-level refusal (`authorizeResourceForRequest`, `authorizeServiceForRequest`) says:
 * the HTTP status (403 / 503) and, when it names one, the decision. Null for any other error. For a handler
 * that catches broadly and must not read the engine's outage as a failure of its own.
 */
export function authorizationRefusalOf(error: unknown): { status: number; decisionId?: string } | null {
  if (!(error instanceof RbacAuthorizationError)) return null;
  const decisionId = typeof error.body?.decisionId === 'string' ? error.body.decisionId : undefined;
  return { status: error.status, ...(decisionId ? { decisionId } : {}) };
}

export interface ResourceRefusalInput {
  /** The engine action that was asked (`agent.session_view_others`...): it rides on the audit row of a 503. */
  action: string;
  /** The service level the question stands for (Read = 'read', Write = 'write'). */
  level: ServicePermissionLevel;
  /** The decision the refusal carries (the engine's); a 503 without one gets a fresh id. */
  decisionId?: string;
  /** The engine could not decide: a 503 with `Retry-After`, never a 403. */
  unavailable?: boolean;
  /** The 403 sentence (default: the generic one). */
  message?: string;
  /** The project the question was decided in. */
  projectId?: string | null;
}

/**
 * The error a handler throws (or turns into a reply) for a RESOURCE the engine refused (403, with the decision
 * id) or could not decide (503, `Retry-After`), in the very shape the gates use - so the same dialect mappers
 * (`sendProjectContextError`, `sendClientApiError`) answer it, and the audit hook records the 503.
 */
export function resourceRefusalError(request: FastifyRequest, input: ResourceRefusalInput): Error {
  if (input.unavailable) {
    return unavailableError(request, {
      decisionId: input.decisionId ?? randomUUID(),
      service: 'agents',
      required: input.level,
      action: input.action,
      projectId: input.projectId,
    });
  }
  const message = input.message ?? serviceDenialReason('agents', input.level);
  if (input.decisionId) request.iamDecisionId = input.decisionId;
  return new RbacAuthorizationError(message, 403, {
    error: message,
    code: 'forbidden',
    message,
    service: 'agents',
    required: input.level,
    ...(input.decisionId ? { decisionId: input.decisionId } : {}),
  });
}

/**
 * What a handler throws when the engine refused a SERVICE it asked about itself (`authorizeServiceForRequest`
 * resolved `allowed: false`): the gate's 403, so the dialect mappers answer it as they answer the gate. A switched-off
 * service answers as the gate does for one: 403 `service_disabled` / 402 `service_not_licensed`.
 */
export function serviceRefusalError(request: FastifyRequest, refusal: ServiceAuthzResult): RbacAuthorizationError {
  if (refusal.off) return serviceDisabledRefusal(new ServiceDisabledError(refusal.off));
  const decisionId = refusal.decisionId ?? randomUUID();
  request.iamDecisionId = decisionId;
  const body = forbiddenBody({ service: refusal.service, required: refusal.required, decisionId });
  return new RbacAuthorizationError(String(body.message), 403, body);
}

/**
 * The project a route is ABOUT when its path names one (`/projects/:projectId/...`).
 * Policies that name a project must see that project, not whichever one the
 * caller's `active_project_id` cookie happens to hold - the cookie is chosen by
 * the caller and a request about project A can carry a cookie for project B.
 */
function routeProjectId(request: FastifyRequest): string | null {
  const id = (request.params as Record<string, unknown> | undefined)?.projectId;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null;
}

/** The project a SESSION request runs in as far as the policy engine is concerned: the path's, else the cookie's. */
function sessionProject(request: FastifyRequest): { projectId: string | null; fromPath: boolean } {
  const fromPath = routeProjectId(request);
  return { projectId: fromPath ?? (request.cookies?.active_project_id || null), fromPath: fromPath !== null };
}

function routeLabel(request: FastifyRequest, pathname: string): string {
  return canonicalRoute(request.routeOptions?.url, pathname);
}

/** The declaration of the matched route (explicit `config.authz`, else the path map). */
function resolveRequestAuthz(request: FastifyRequest, pathname: string): RouteAuthzResolution {
  return resolveRouteAuthz(request.routeOptions?.config, pathname);
}

// ── refusals ─────────────────────────────────────────────────────────────

/**
 * The 503 refusal for a request the engine could not decide: the audit hook
 * records it (`request.iamDenial`), the response carries the decision id, and
 * the client is told when to retry.
 */
function unavailableError(
  request: FastifyRequest,
  decision: { decisionId: string; service: PermissionService; required: ServicePermissionLevel; action?: string; projectId?: string | null },
): RbacAuthorizationError {
  request.iamDenial = {
    code: 'authorization_unavailable',
    decisionId: decision.decisionId,
    service: decision.service,
    required: decision.required,
    action: decision.action,
    projectId: decision.projectId,
    ip: getAuthzClientIp(request),
  };
  const body = unavailableBody(decision.decisionId);
  return new RbacAuthorizationError(body.error, 503, body, { 'Retry-After': AUTHORIZATION_RETRY_AFTER_SECONDS });
}

/** Count, log and build the 503 for a failure that happened BEFORE the engine could be asked (loading the caller). */
function authorizationUnavailable(
  request: FastifyRequest,
  tenantDbName: string,
  reason: EnforceUnavailableReason,
  error: unknown,
  info: { service: PermissionService; required: ServicePermissionLevel },
): RbacAuthorizationError {
  const decisionId = recordAuthorizationUnavailable(tenantDbName, reason, error, {
    requestId: request.apiRequestId ?? 'unknown',
    route: routeLabel(request, getRequestPathname(request)),
    service: info.service,
  });
  return unavailableError(request, { decisionId, ...info });
}

/** The error that answers a request the engine refused (403) or could not decide (503). */
function refusalError(request: FastifyRequest, verdict: EnforceDenial | EnforceUnavailable): RbacAuthorizationError {
  if (verdict.unavailable) return unavailableError(request, verdict);
  const body = forbiddenBody(verdict);
  request.iamDenial = {
    code: 'forbidden',
    decisionId: verdict.decisionId,
    service: verdict.service,
    required: verdict.required,
    action: verdict.action,
    projectId: verdict.projectId,
    reasons: verdict.reasons,
    policyIds: verdict.policyIds,
    ip: getAuthzClientIp(request),
  };
  return new RbacAuthorizationError(String(body.message), 403, body);
}

/**
 * A request that does not resolve to a service. `public` / `self` /
 * `authenticated` declarations let it through (the handler, the global hook or
 * the token wrapper authenticated the caller); an undeclared route is refused
 * with 403 `route_not_declared`.
 */
function applyNonServiceDeclaration(
  request: FastifyRequest,
  resolution: RouteAuthzResolution,
  tenantDbName: string,
  log: Record<string, unknown>,
): void {
  if (resolution.effective.kind !== 'undeclared') {
    // public / self: the handler is responsible. authenticated: the caller is a
    // signed-in principal of the tenant (the global hook / token auth ran).
    return;
  }
  recordUndeclaredDenial(tenantDbName, log);
  const body = undeclaredRouteBody();
  request.iamDenial = { code: 'route_not_declared' };
  throw new RbacAuthorizationError(body.message, 403, body);
}

// ── the live role ────────────────────────────────────────────────────────

/**
 * For a route that runs the permission gate the context is settled once more with
 * the row the gate has just read - not a cached answer - so a role change applies
 * to a gated route on the very next request (the hook above already corrects every
 * request to the cached role, at most 30 s behind).
 */
export function applyGateLoadedRole(request: FastifyRequest, session: ApiSessionContext): void {
  const headers = request.apiContextHeaders;
  const loaded = request.rbacUser;
  if (!headers || !loaded || String(loaded._id) !== String(session.userId)) return;
  if (isTenantRole(loaded.role) && headers['x-user-role'] !== loaded.role) headers['x-user-role'] = loaded.role;
}

// ── the gates ────────────────────────────────────────────────────────────

/**
 * The gate's decision for a service route. A route declared for several services (`anyOf`, routeAuthz.ts) admits
 * a holder of any of them, asked in order with the owner first; only the denial it answers with is counted and
 * logged. An engine that cannot decide refuses at once (503), whichever service it was asked about.
 */
async function decideRouteService(
  request: FastifyRequest,
  input: Omit<EnforceGateInput, 'service' | 'level' | 'quiet'>,
  target: Extract<EffectiveRouteAuthz, { kind: 'service' }>,
): Promise<EnforceDecision> {
  const services = [target.service, ...(target.anyOf ?? [])];
  let refused: { verdict: EnforceDenial; asked: EnforceGateInput } | undefined;
  for (const service of services) {
    const asked: EnforceGateInput = { ...input, service, level: target.level, quiet: services.length > 1 };
    const verdict = await decideEnforced(asked);
    if (verdict.allowed) {
      request.iamGateService = service;
      return verdict;
    }
    if (verdict.unavailable) return verdict;
    refused ??= { verdict, asked };
  }
  if (services.length > 1) recordEnforcedDenial(refused!.asked, refused!.verdict);
  return refused!.verdict;
}

export async function enforceSessionRbac(request: FastifyRequest, session: ApiSessionContext): Promise<void> {
  const pathname = getRequestPathname(request);
  const resolution = resolveRequestAuthz(request, pathname);
  const target = resolution.effective;

  if (target.kind !== 'service') {
    applyNonServiceDeclaration(request, resolution, session.tenantDbName, {
      subject: 'session',
      requestId: request.apiRequestId ?? session.requestId,
      method: request.method,
      route: routeLabel(request, pathname),
      userId: session.userId,
    });
    return;
  }

  let loaded: Awaited<ReturnType<typeof loadSessionAuthz>>;
  try {
    loaded = await loadSessionAuthz(session);
  } catch (error) {
    if (error instanceof RbacAuthorizationError) throw error;
    throw authorizationUnavailable(request, session.tenantDbName, 'principal_unavailable', error, {
      service: target.service,
      required: target.level ?? getRequiredPermissionLevel(request.method, target.service),
    });
  }
  const { user, groups, groupGrants } = loaded;
  request.rbacUser = user;

  const verdict = await decideRouteService(request, {
    subject: 'session',
    tenantDbName: session.tenantDbName,
    tenantId: session.tenantId,
    requestId: request.apiRequestId ?? session.requestId,
    method: request.method,
    route: routeLabel(request, pathname),
    userId: String(user._id),
    user,
    groupGrants,
    groups,
    requestedProjectId: sessionProject(request).projectId,
    projectFromPath: sessionProject(request).fromPath,
    ip: getAuthzClientIp(request),
    path: pathname,
  }, target);
  if (!verdict.allowed) throw refusalError(request, verdict);
}

/** A switched-off service refuses like the gate does, so every API surface and dialect renders it the same way. */
function serviceDisabledRefusal(error: ServiceDisabledError): RbacAuthorizationError {
  return new RbacAuthorizationError(error.message, error.status, error.toBody());
}

/**
 * Refuses a request whose service is switched off for the tenant (environment
 * or license, see serviceAvailability.ts). It runs for every declared service
 * route, whatever the RBAC settings of the wrapper, and also checks the
 * enterprise module that owns the path, so a module such as `mcp-hub` can be
 * off while `mcp` stays on. A route open to several services (`anyOf`) is
 * refused here only when all of them are off; otherwise its handler checks the
 * one it resolved (authorizeServiceForRequest).
 */
export async function enforceServiceAvailability(request: FastifyRequest, tenantId: string): Promise<void> {
  const pathname = getRequestPathname(request);
  const target = resolveRequestAuthz(request, pathname).effective;
  const scope = { tenantId };

  const enterpriseModule = getEnterpriseModuleForPath(pathname);
  if (enterpriseModule) {
    const off = await serviceOffReason(scope, enterpriseModule);
    if (off) throw serviceDisabledRefusal(new ServiceDisabledError(off));
  }
  if (target.kind !== 'service') return;

  const services = [target.service, ...(target.anyOf ?? [])];
  let first: Awaited<ReturnType<typeof serviceOffReason>> = null;
  for (const service of services) {
    const off = await serviceOffReason(scope, service);
    if (!off) return;
    first ??= off;
  }
  if (first) throw serviceDisabledRefusal(new ServiceDisabledError(first));
}

export async function enforceApiTokenRbac(
  request: FastifyRequest,
  context: ApiTokenContext,
): Promise<void> {
  const pathname = getRequestPathname(request);
  const resolution = resolveRequestAuthz(request, pathname);
  const target = resolution.effective;

  if (target.kind !== 'service') {
    applyNonServiceDeclaration(request, resolution, context.tenantDbName, {
      subject: 'token',
      requestId: request.apiRequestId ?? 'unknown',
      method: request.method,
      route: routeLabel(request, pathname),
      tokenId: context.tokenRecord._id ? String(context.tokenRecord._id) : undefined,
    });
    return;
  }

  if (!context.user) {
    throw new RbacAuthorizationError('API token owner is not available', 403);
  }

  request.rbacUser = context.user;
  const owner = context.user;
  const verdict = await decideRouteService(request, {
    subject: 'token',
    tenantDbName: context.tenantDbName,
    tenantId: context.tenantId,
    requestId: request.apiRequestId ?? 'unknown',
    method: request.method,
    route: routeLabel(request, pathname),
    userId: String(owner._id),
    user: owner,
    tokenId: context.tokenRecord._id ? String(context.tokenRecord._id) : undefined,
    // Least-privilege token scope: when the token carries its own
    // servicePermissions allowlist, it caps the owner-derived permission.
    // Unscoped tokens (null) inherit the owner's permissions unchanged.
    tokenScope: context.tokenRecord.servicePermissions,
    // The project the handler will run in (the token's own, else the default one).
    requestedProjectId: context.projectId ? String(context.projectId) : null,
    ip: getAuthzClientIp(request),
    path: pathname,
  }, target);
  if (!verdict.allowed) throw refusalError(request, verdict);
}
