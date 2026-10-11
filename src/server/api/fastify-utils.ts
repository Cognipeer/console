import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { trustsEveryHop } from '@/lib/security/trustedProxy';
import { getDatabase, runWithTenantScope, type IGroup, type IUser } from '@/lib/database';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import { patchRequestContext, runWithRequestContext } from '@/lib/core/requestContext';
import {
  getRequiredPermissionLevel,
  type GroupTenantGrant,
  type PermissionService,
  type ServicePermissionLevel,
} from '@/lib/security/rbac';
import { canonicalizeRequestPathname } from '@/lib/security/requestPath';
import {
  decideEnforced,
  forbiddenBody,
  recordAuthorizationUnavailable,
  recordUndeclaredDenial,
  undeclaredRouteBody,
  unavailableBody,
  type EnforceDenial,
  type EnforceUnavailable,
  type EnforceUnavailableReason,
} from '@/lib/iam/enforce';
import { fetchGroupsByIds, grantsOf, listUserGroupIds } from '@/lib/iam/groupGrants';
import { markGated, resolveRouteAuthz, type RouteAuthzResolution } from '@/lib/iam/routeAuthz';
import { authorizeServiceAccess, buildServicePrincipal, quietServiceLevel, type ServiceAuthzOptions, type ServiceAuthzPrincipal, type ServiceAuthzResult } from '@/lib/iam/requestAuthz';
import type { EffectiveLevel } from '@/lib/iam/effective';
import { authorizeResourceForPrincipal, type ResourceAuthzAction, type ResourceAuthzResult, type ResourceAuthzSubject } from '@/lib/iam/resourceAuthz';
import { auditLevelOf } from '@/lib/iam/denialAudit';
import { serviceDenialReason } from '@/lib/iam/denialReason';
import type { IamResource } from '@/lib/iam/entities';
import { canonicalRoute } from '@/lib/iam/routePattern';
import { getUserAuthState, getUserIdentity, isUserDisabled } from '@/lib/services/users/userAuthState';
import { isTenantRole } from '@/lib/iam/identity';
import {
  ApiTokenAuthError,
  requireApiTokenFromHeader,
  type ApiTokenContext,
} from '@/lib/services/apiTokenAuth';
import {
  ProjectContextError,
  resolveProjectContext,
  type ProjectContext,
} from '@/lib/services/projects/projectContext';

const logger = createLogger('api:session-account-state');

export interface ApiSessionContext {
  requestId: string;
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
  userEmail?: string;
  userId: string;
  userRole: string;
  licenseType: LicenseType | string;
}

/** A handler-level refusal (403) or outage (503) of the policy engine, thrown so the dialect mappers answer it. */
export class RbacAuthorizationError extends Error {
  status: number;
  /**
   * Structured refusal: `{ error, code, ... }`, where `error` is the same reason
   * sentence the plain-text clients show (`error.message` of this error). Session
   * routes send it as is; the client-API error styles embed `code` in their
   * envelope and keep `error.message` as the reason.
   */
  body?: Record<string, unknown>;
  /** Response headers that belong to the refusal (`Retry-After` on a 503). */
  headers?: Record<string, string>;

  constructor(message: string, status = 403, body?: Record<string, unknown>, headers?: Record<string, string>) {
    super(message);
    this.name = 'RbacAuthorizationError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Seconds a client is told to wait before retrying a request refused because authorization was unavailable. */
const AUTHORIZATION_RETRY_AFTER_SECONDS = '5';

export function getHeaderValue(
  request: FastifyRequest,
  name: string,
): string | null {
  const value = request.headers[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return null;
}

export function readJsonBody<T>(request: FastifyRequest): T {
  const { body } = request;

  if (body === undefined || body === null || body === '') {
    throw new SyntaxError('Unexpected end of JSON input');
  }

  if (typeof body === 'string') {
    return JSON.parse(body) as T;
  }

  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString('utf8')) as T;
  }

  return body as T;
}

/**
 * Same as readJsonBody but never throws — returns `{}` on missing or malformed
 * payload. Use when the handler validates field-by-field and prefers to reply
 * with a domain-specific 400 rather than letting JSON parse errors leak out.
 *
 * IMPORTANT: every Fastify plugin route in this app MUST use this (or
 * readJsonBody) instead of accessing `request.body` directly. The global
 * JSON content-type parser keeps the body as the raw string for Next.js
 * compatibility, so a direct `body.fleetToken` access reads from a string
 * and silently returns undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeReadJsonBody<T = Record<string, any>>(request: FastifyRequest): T {
  try {
    return readJsonBody<T>(request);
  } catch {
    return {} as T;
  }
}

/**
 * The caller's IP as resolved through the server's configured proxy trust
 * boundary (`config.network.trustedProxies` → Fastify's `trustProxy`).
 *
 * There is deliberately no X-Forwarded-For / X-Real-IP fallback here any
 * more. Fastify already derives `request.ip` from X-Forwarded-For when — and
 * only when — the immediate peer is trusted; re-reading those headers here
 * did the opposite, taking a caller-settable header at face value no matter
 * what `trustProxy` said, which is exactly the spoof F-09 reported. Since
 * `request.ip` falls back to the raw socket address on its own, the old
 * branches were also unreachable in practice.
 *
 * Deployment note: a proxy that sets ONLY `X-Real-IP` and not
 * `X-Forwarded-For` will now show up as the proxy's own address. Set
 * `X-Forwarded-For` on it (nginx's `proxy_set_header X-Forwarded-For
 * $proxy_add_x_forwarded_for`) and list the proxy in `TRUSTED_PROXIES`.
 */
export function getClientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

export { trustsEveryHop };

/**
 * The caller's address for AUTHORIZATION decisions: a token's IP allowlist and a
 * policy's `ip` condition. Unlike `getClientIp` (audit, rate limiting) this never
 * takes a header at face value:
 *
 *  - With trusted proxies configured it is `request.ip`: Fastify walks the
 *    forwarded-for chain from the right and stops at the first hop that is not
 *    one of them, so what the caller wrote to the left of the proxy is ignored.
 *  - With none configured Fastify trusts every hop, which makes `request.ip`
 *    the leftmost forwarded-for entry - a value the caller chooses, even behind
 *    a proxy that appends to the header. The only address nobody can forge is
 *    then the connection's own peer, so that is the one rules are checked
 *    against. (Behind a reverse proxy every caller then looks like the proxy
 *    until `TRUSTED_PROXIES` names it - the IAM settings and the token form say
 *    so. A rule that cannot be evaluated safely errs on the side of not matching
 *    a spoofed address, never of matching it.)
 */
export function getAuthzClientIp(request: FastifyRequest): string {
  if (trustsEveryHop()) {
    return request.raw?.socket?.remoteAddress || request.socket?.remoteAddress || 'unknown';
  }
  return request.ip || 'unknown';
}

export function getSessionContext(
  request: FastifyRequest,
): ApiSessionContext | null {
  const headers = request.apiContextHeaders;
  if (!headers) {
    return null;
  }

  const tenantDbName = headers['x-tenant-db-name'];
  const tenantId = headers['x-tenant-id'];
  const tenantSlug = headers['x-tenant-slug'];
  const userEmail = headers['x-user-email'];
  const userId = headers['x-user-id'];
  const userRole = headers['x-user-role'];
  const licenseType = headers['x-license-type'];

  if (
    !tenantDbName
    || !tenantId
    || !tenantSlug
    || !userId
    || !userRole
    || !licenseType
  ) {
    return null;
  }

  return {
    requestId: request.apiRequestId ?? headers['x-request-id'] ?? 'unknown',
    tenantDbName,
    tenantId,
    tenantSlug,
    userEmail,
    userId,
    userRole,
    licenseType,
  };
}

export function requireSessionContext(
  request: FastifyRequest,
): ApiSessionContext {
  const session = getSessionContext(request);
  if (!session) {
    throw new Error('Unauthorized');
  }
  return session;
}

function getRequestPathname(request: FastifyRequest): string {
  // RBAC must map the path the router actually matched: Fastify decodes
  // percent-escapes, so the raw '/api/to%6Fls' reaches the /api/tools handler
  // while mapping to no service (= no authorization).
  return canonicalizeRequestPathname(request.raw.url);
}

/**
 * What the gate knows about the signed-in user: the user row and the groups
 * (with their tenant-level grants), both read fresh for every request so that
 * a role, permission or membership change applies at once, without a re-login.
 * Group grants can only ever RAISE a user's access. The groups come with one
 * batched read (groupGrants.ts) and travel on to the principal load, so a cold
 * principal does not read them again.
 *
 * Bound to the session's tenant with a real scope (never the process-global
 * binding, which a concurrent request for another tenant can overwrite).
 */
async function loadSessionAuthz(
  session: ApiSessionContext,
): Promise<{ user: IUser; groups: IGroup[]; groupGrants: GroupTenantGrant[] }> {
  return runWithTenantScope(session.tenantDbName, async (db) => {
    // Defense-in-depth: verify the active tenant context matches the session.
    // Real providers always implement assertTenantContext; test mocks may not.
    if (typeof db.assertTenantContext === 'function') {
      db.assertTenantContext(session.tenantDbName);
    }
    // The memberships need only the user id the session already carries, so they are
    // read together with the user row; the group documents follow in ONE batched read.
    const [user, groupIds] = await Promise.all([
      db.findUserById(session.userId),
      listUserGroupIds(db, session.userId),
    ]);
    if (!user) {
      throw new RbacAuthorizationError('Unauthorized', 401);
    }
    // Defense-in-depth: ensure the loaded user record actually belongs to the
    // session's tenant. (DB partitioning already enforces this, but a mis-bound
    // mock or future refactor could break the invariant - fail loudly here.)
    if (user.tenantId && String(user.tenantId) !== String(session.tenantId)) {
      throw new RbacAuthorizationError('Tenant mismatch', 403);
    }
    // Defense-in-depth: the global session hook already rejects disabled
    // accounts, but this is also the entry point for callers that bypass it
    // (e.g. realtime cookie auth via resolveSessionRbacContext).
    if (isUserDisabled(user)) {
      throw new RbacAuthorizationError('Account is disabled', 401);
    }
    const groups = await fetchGroupsByIds(db, session.tenantId, groupIds);
    return { user, groups, groupGrants: grantsOf(groups) };
  });
}

/**
 * Cookie sessions are stateless JWTs, so a disabled or deleted account is
 * only caught by re-checking the user row (cached ~30s, invalidated on
 * disable/delete). Runs for EVERY cookie-authenticated request, mapped to an
 * RBAC service or not. Returns true when it sent a rejection; fail closed:
 * if the state cannot be read the request is refused with a 503.
 *
 * It also settles which ROLE the request carries. A session holds the role the
 * account had when the session was issued, but a role can be changed afterwards,
 * and the handlers decide on the role in the session context (who may administer
 * people, manage projects, mint tokens for others...). For an account in good
 * standing the context is therefore corrected to the role the account has now
 * (the same briefly cached read, dropped when the account is written). When that
 * cannot be read the request is refused (503) like an unreadable account state.
 */
export async function rejectInactiveSessionAccount(
  reply: FastifyReply,
  session: { tenantDbName: string; tenantId: string; userId: string },
): Promise<boolean> {
  let state: Awaited<ReturnType<typeof getUserAuthState>>;
  try {
    state = await getUserAuthState(session.tenantDbName, session.tenantId, session.userId);
  } catch (error) {
    logger.warn('Could not verify session account state; refusing the request', {
      userId: session.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    reply.code(503).send({
      error: 'Service Unavailable',
      message: 'Unable to verify session',
    });
    return true;
  }

  if (state === 'active') {
    return applyCurrentRole(reply, session);
  }

  clearSessionCookies(reply);
  reply.code(401).send(
    state === 'disabled'
      ? { error: 'Unauthorized', message: 'Account is disabled', code: 'account_disabled' }
      : { error: 'Unauthorized', message: 'Account no longer exists', code: 'account_missing' },
  );
  return true;
}

/** Sets the role of the request's session context to the one the account has now; true when it refused the request. */
async function applyCurrentRole(
  reply: FastifyReply,
  session: { tenantDbName: string; tenantId: string; userId: string },
): Promise<boolean> {
  const headers = reply.request?.apiContextHeaders;
  if (!headers) return false;
  try {
    const identity = await getUserIdentity(session.tenantDbName, session.tenantId, session.userId);
    // A role this version does not know leaves the session's role as it is.
    if (identity.role && headers['x-user-role'] !== identity.role) headers['x-user-role'] = identity.role;
    return false;
  } catch (error) {
    logger.warn('Could not read the current role of the session account; refusing the request', {
      userId: session.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    reply.code(503).send({
      error: 'Service Unavailable',
      message: 'Unable to verify session',
    });
    return true;
  }
}

/**
 * Resolves the user row + group grants for routes that are not covered by the
 * route-prefix map (e.g. /api/dashboard) but still need per-item permission
 * filtering inside the handler. Reuses the exact loader of the route gate, so
 * both paths can never diverge.
 */
export async function resolveSessionRbacContext(
  session: ApiSessionContext,
): Promise<{ user: IUser; groupGrants: GroupTenantGrant[]; groups: IGroup[] }> {
  const { user, groups, groupGrants } = await loadSessionAuthz(session);
  return { user, groupGrants, groups };
}

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
 */
export async function authorizeServiceForRequest(
  request: FastifyRequest,
  service: PermissionService,
  options: ServiceAuthzOptions & { rbac?: SessionRbacHint } = {},
): Promise<ServiceAuthzResult> {
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

export interface ResourceRequestAuthzInput {
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
  const requestId = request.apiRequestId ?? 'unknown';
  const route = routeLabel(request, getRequestPathname(request));
  const principal = await requestPrincipal(request, 'agents', { rbac: input.rbac, required, projectId: input.projectId });
  if (!principal) return { allowed: false, source: 'engine', reasons: [], policyIds: [] };

  let engine;
  try {
    engine = await buildServicePrincipal(principal, { service: 'agents', requestId, route, method: 'POST' });
  } catch (error) {
    throw authorizationUnavailable(request, principal.tenantDbName, 'principal_unavailable', error, { service: 'agents', required });
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
      throw unavailableError(request, { decisionId: result.decisionId, service: 'agents', required, action: input.action, projectId: engine.contextProjectId });
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
function applyGateLoadedRole(request: FastifyRequest, session: ApiSessionContext): void {
  const headers = request.apiContextHeaders;
  const loaded = request.rbacUser;
  if (!headers || !loaded || String(loaded._id) !== String(session.userId)) return;
  if (isTenantRole(loaded.role) && headers['x-user-role'] !== loaded.role) headers['x-user-role'] = loaded.role;
}

// ── the gates ────────────────────────────────────────────────────────────

async function enforceSessionRbac(request: FastifyRequest, session: ApiSessionContext): Promise<void> {
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

  const verdict = await decideEnforced({
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
    service: target.service,
    level: target.level,
    ip: getAuthzClientIp(request),
    path: pathname,
  });
  if (!verdict.allowed) throw refusalError(request, verdict);
}

async function enforceApiTokenRbac(
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
  const verdict = await decideEnforced({
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
    service: target.service,
    level: target.level,
    ip: getAuthzClientIp(request),
    path: pathname,
  });
  if (!verdict.allowed) throw refusalError(request, verdict);
}

export function sendProjectContextError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof ProjectContextError) {
    return reply.code(error.status).send({ error: error.message });
  }

  if (error instanceof Error && error.message === 'Unauthorized') {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  // A handler-level authorization check (authorizeServiceForRequest) refuses by
  // throwing - the 503 when the engine could not decide: the handlers that catch
  // broadly and end here answer it as the gate would.
  return sendRbacError(reply, error);
}

function sendRbacError(reply: FastifyReply, error: unknown) {
  if (error instanceof RbacAuthorizationError) {
    for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
    return reply.code(error.status).send(error.body ?? { error: error.message });
  }
  return null;
}

/**
 * Response headers every SSE endpoint needs. `X-Accel-Buffering: no` is the one
 * that is easy to forget and expensive to miss: nginx (and most ingress
 * controllers) default to `proxy_buffering on`, which holds the whole event
 * stream until the response completes — the client sees nothing, then
 * everything, which reads exactly like "streaming does not work".
 */
export function applyStreamHeaders(reply: FastifyReply, requestId?: string): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  if (requestId) {
    reply.raw.setHeader('X-Request-Id', requestId);
  }
}

export function parseBooleanQuery(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

export function parseCsvQuery(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function withApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (request: TRequest, reply: FastifyReply) => Promise<unknown> | unknown,
) {
  return markGated(async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: 'Service is shutting down' });
    }

    const session = getSessionContext(request);

    try {
      if (session) {
        await enforceSessionRbac(request, session);
        applyGateLoadedRole(request, session);
      }
    } catch (error) {
      return sendRbacError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }

    try {
      return await runWithRequestContext(
        {
          requestId: request.apiRequestId,
          tenantId: session?.tenantId,
          tenantSlug: session?.tenantSlug,
          userId: session?.userId,
          actorType: session ? 'user' : undefined,
          source: 'dashboard',
        },
        async () => {
          // Bind the tenant DB for the whole handler execution so every nested
          // query resolves to this session's tenant. Without this, cookie/RBAC
          // (dashboard) requests never establish a tenant scope at request top
          // and fall back to the process-global tenant binding, which a
          // concurrent request for another tenant can overwrite — causing
          // cross-tenant reads/writes (e.g. a provider/model landing in the
          // wrong tenant DB). Mirrors the client-API (token) path above.
          const db = await getDatabase();
          if (session?.tenantDbName && typeof db.runWithTenant === 'function') {
            return db.runWithTenant(session.tenantDbName, () =>
              handler(request as TRequest, reply),
            );
          }
          return handler(request as TRequest, reply);
        },
      );
    } catch (error) {
      // A handler-level authorization check (authorizeServiceForRequest) refuses
      // by throwing, exactly as the gate does; anything else is the handler's own
      // error and goes to the framework's error handler, as it always did.
      const refused = sendRbacError(reply, error);
      if (refused) return refused;
      throw error;
    }
  });
}

export async function requireApiTokenContext(
  request: FastifyRequest,
): Promise<ApiTokenContext> {
  try {
    return await requireApiTokenFromHeader(getHeaderValue(request, 'authorization'), {
      // The token's IP allowlist is matched against the address the server can
      // vouch for (getAuthzClientIp: the connection peer, or the forwarded address
      // only through the configured trusted proxies), never against a header the
      // caller can set.
      clientIp: getAuthzClientIp(request),
    });
  } catch (error) {
    if (error instanceof ApiTokenAuthError && error.code === 'ip_not_allowed' && error.denial) {
      const { denial } = error;
      // Authentication refused the call before any tenant context existed, so the
      // response-time audit hook would write nothing; record the refusal itself.
      void import('@/lib/services/apiTokens/ipDenialAudit')
        .then(({ recordTokenIpDenial }) => recordTokenIpDenial({
          ...denial,
          requestId: request.apiRequestId,
          method: request.method,
          path: getRequestPathname(request),
          userAgent: getHeaderValue(request, 'user-agent') ?? undefined,
        }))
        .catch((auditError: unknown) => {
          logger.warn('Could not audit a token IP refusal', {
            error: auditError instanceof Error ? auditError.message : String(auditError),
          });
        });
    }
    throw error;
  }
}

export async function getApiTokenContextForRequest(
  request: FastifyRequest,
): Promise<ApiTokenContext> {
  if (request.apiTokenContext) {
    return request.apiTokenContext;
  }

  const context = await requireApiTokenContext(request);
  request.apiTokenContext = context;
  return context;
}

export function sendApiTokenError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof ApiTokenAuthError) {
    return reply.code(error.status).send(error.code ? { error: error.message, code: error.code } : { error: error.message });
  }

  return null;
}

/** Error envelope styles for the client (token) API. */
export type ClientApiErrorStyle = 'json' | 'openai' | 'anthropic';

export interface ClientApiContextOptions {
  /**
   * Response envelope on error. `'json'` → `{ error: string }` (the default,
   * used by most client routes). `'openai'` → `{ error: { message, type } }`
   * for OpenAI-SDK-compatible routes (chat/completions, embeddings, audio).
   */
  errorStyle?: ClientApiErrorStyle;
  /**
   * Enforce API-token RBAC for paths that map to a permission service. Defaults
   * to `true`. Only set `false` for routes that are intentionally open to any
   * valid token regardless of the token owner's service permissions. (RBAC is a
   * no-op for paths with no permission-service mapping, so leaving it on is
   * safe and is what closes accidental bypasses.)
   */
  rbac?: boolean;
}

function openAiErrorBody(message: string, type: string) {
  return { error: { message, type } };
}

/**
 * Anthropic's envelope. Different enough from OpenAI's that an SDK cannot read
 * the other one: it is `{type:'error', error:{type, message}}`, and the error
 * `type` vocabulary is its own (`authentication_error`, `permission_error`,
 * `invalid_request_error`, `api_error`).
 */
function anthropicErrorEnvelope(message: string, type: string) {
  return { type: 'error', error: { type, message } };
}

/**
 * Single error responder for the client (token) API. Maps the well-known error
 * types to the right status + envelope so every token route reports failures
 * identically. Returns the reply (never null) so callers can `return` it.
 */
function sendClientApiError(
  reply: FastifyReply,
  error: unknown,
  style: ClientApiErrorStyle,
) {
  if (error instanceof ApiTokenAuthError) {
    // A refusal that carries a code (`ip_not_allowed`) is "authenticated but not
    // permitted from here": a 403 permission error in every dialect, with the
    // code visible, so a client can tell it apart from a bad or expired token.
    if (error.code) {
      if (style === 'anthropic') {
        return reply.code(error.status).send(anthropicErrorEnvelope(error.message, 'permission_error'));
      }
      if (style === 'openai') {
        const body = openAiErrorBody(error.message, 'permission_error');
        return reply.code(error.status).send({ error: { ...body.error, code: error.code } });
      }
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    if (style === 'anthropic') {
      return reply.code(401).send(anthropicErrorEnvelope(error.message, 'authentication_error'));
    }
    if (style === 'openai') {
      // OpenAI SDKs treat auth failures as 401 regardless of the finer status.
      return reply.code(401).send(openAiErrorBody(error.message, 'invalid_request_error'));
    }
    return reply.code(error.status).send({ error: error.message });
  }

  if (error instanceof RbacAuthorizationError) {
    const code = typeof error.body?.code === 'string' ? error.body.code : undefined;
    // A refusal names its decision in every dialect, so an API caller can hand it to
    // IAM center > Access check (403) or to support (503) like a dashboard user can.
    const decisionId = typeof error.body?.decisionId === 'string' ? error.body.decisionId : undefined;
    const extra = decisionId ? { decision_id: decisionId } : {};
    // 503 = authorization was unavailable (nobody was refused on merit): a server
    // error in every dialect, one the SDKs retry - not a permission error.
    const unavailable = error.status === 503;
    for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
    if (style === 'anthropic') {
      const envelope = anthropicErrorEnvelope(error.message, unavailable ? 'api_error' : 'permission_error');
      return reply.code(error.status).send({ ...envelope, error: { ...envelope.error, ...extra } });
    }
    if (style === 'openai') {
      const body = openAiErrorBody(error.message, unavailable ? 'server_error' : 'permission_error');
      return reply.code(error.status).send({ error: { ...body.error, ...(code ? { code } : {}), ...extra } });
    }
    return reply.code(error.status).send(error.body ?? { error: error.message });
  }

  if (style === 'anthropic') {
    return reply.code(500).send(anthropicErrorEnvelope('Internal server error', 'api_error'));
  }
  if (style === 'openai') {
    return reply.code(500).send(openAiErrorBody('Internal server error', 'server_error'));
  }
  return reply
    .code(500)
    .send({ error: error instanceof Error ? error.message : 'Internal server error' });
}

/**
 * THE canonical wrapper for every API-token ("client") route. It is the single
 * source of truth for the token request lifecycle:
 *   1. shutdown guard (503),
 *   2. authenticate the Bearer token → ApiTokenContext (stored on the request),
 *   3. enforce API-token RBAC (unless `rbac: false`; no-op for unmapped paths),
 *   4. bind the tenant DB for the WHOLE handler via `runWithTenant` (immune to
 *      the cross-tenant process-global race under concurrent load),
 *   5. uniform error responses (`errorStyle`).
 * The resolved `auth` context is passed as the handler's third argument.
 *
 * Do not hand-roll this per plugin — pass options instead. Local clones drift
 * (e.g. silently skipping RBAC on chat/embeddings/ocr-jobs).
 */
export function withClientApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: ClientApiContextOptions = {},
) {
  const errorStyle: ClientApiErrorStyle = options.errorStyle ?? 'json';
  const enforceRbac = options.rbac ?? true;

  const run = async (request: FastifyRequest, reply: FastifyReply) => {
    if (isShuttingDown()) {
      if (errorStyle === 'openai') {
        return reply
          .code(503)
          .header('Retry-After', '5')
          .send(openAiErrorBody('Service is shutting down', 'server_error'));
      }
      if (errorStyle === 'anthropic') {
        // `overloaded_error` is the Messages type the SDKs treat as retryable,
        // which is exactly what a draining instance wants them to do.
        return reply
          .code(503)
          .header('Retry-After', '5')
          .send(anthropicErrorEnvelope('Service is shutting down', 'overloaded_error'));
      }
      return reply
        .code(503)
        .header('Retry-After', '5')
        .send({ error: 'Service is shutting down' });
    }

    let apiToken: ApiTokenContext;
    try {
      apiToken = await requireApiTokenContext(request);
      request.apiTokenContext = apiToken;
      if (enforceRbac) {
        await enforceApiTokenRbac(request, apiToken);
      }
    } catch (error) {
      return sendClientApiError(reply, error, errorStyle);
    }

    try {
      return await runWithRequestContext(
        {
          requestId: request.apiRequestId,
          tenantId: apiToken.tenantId,
          tenantSlug: apiToken.tenantSlug,
          userId: apiToken.tokenRecord.userId
            ? String(apiToken.tokenRecord.userId)
            : apiToken.user?._id
              ? String(apiToken.user._id)
              : undefined,
          projectId: apiToken.projectId ?? undefined,
          apiTokenId: apiToken.tokenRecord._id ? String(apiToken.tokenRecord._id) : undefined,
          actorType: 'api_token',
          source: 'api',
        },
        async () => {
          // Bind the tenant DB for the whole handler execution so every nested
          // query resolves to the token's tenant. Without this, client-API
          // (token) requests never establish a tenant scope at request top and
          // fall back to the process-global tenant binding, which a concurrent
          // request for another tenant can overwrite — causing cross-tenant
          // reads/writes. Mirrors the cookie/RBAC path.
          const db = await getDatabase();
          if (typeof db.runWithTenant === 'function') {
            return db.runWithTenant(apiToken.tenantDbName, () =>
              handler(request as TRequest, reply, apiToken),
            );
          }
          await db.switchToTenant(apiToken.tenantDbName);
          return handler(request as TRequest, reply, apiToken);
        },
      );
    } catch (error) {
      return sendClientApiError(reply, error, errorStyle);
    }
  };
  // `rbac: false` opts out of the permission gate, so such a route is not "gated".
  return enforceRbac ? markGated(run) : run;
}

/**
 * Convenience for OpenAI-SDK-compatible token routes (chat/completions,
 * embeddings, audio/*, ocr). Identical to {@link withClientApiRequestContext}
 * but emits the OpenAI `{ error: { message, type } }` envelope. RBAC stays on
 * by default (no-op for paths without a permission service) — this is what
 * closes the historical bypasses on the routes that DO map to a service.
 */
export function withOpenAiApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: Omit<ClientApiContextOptions, 'errorStyle'> = {},
) {
  return withClientApiRequestContext(handler, { ...options, errorStyle: 'openai' });
}

/**
 * Same lifecycle as the OpenAI wrapper — auth, RBAC, tenant binding — with the
 * Messages-dialect error envelope. A route that authenticates identically but
 * answers failures in the other dialect is the whole difference, and it has to
 * be the whole difference: an Anthropic SDK cannot parse an OpenAI error body,
 * so a shared wrapper with the wrong envelope turns every 401 into an opaque
 * client-side crash.
 */
export function withAnthropicApiRequestContext<
  TRequest extends FastifyRequest = FastifyRequest,
>(
  handler: (
    request: TRequest,
    reply: FastifyReply,
    auth: ApiTokenContext,
  ) => Promise<unknown> | unknown,
  options: Omit<ClientApiContextOptions, 'errorStyle'> = {},
) {
  return withClientApiRequestContext(handler, { ...options, errorStyle: 'anthropic' });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie('token', { path: '/' });
  reply.clearCookie('active_project_id', { path: '/' });
}

export function setSessionCookies(
  reply: FastifyReply,
  options: {
    token: string;
    activeProjectId?: string;
  },
): void {
  const isProduction = getConfig().nodeEnv === 'production';

  reply.setCookie('token', options.token, {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
    sameSite: 'lax',
    secure: isProduction,
  });

  if (options.activeProjectId) {
    reply.setCookie('active_project_id', options.activeProjectId, {
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
      sameSite: 'lax',
      secure: isProduction,
    });
    return;
  }

  reply.clearCookie('active_project_id', { path: '/' });
}

export async function requireProjectContextForRequest(
  request: FastifyRequest,
): Promise<ProjectContext & { session: ApiSessionContext }> {
  const session = getSessionContext(request);
  if (!session) {
    throw new Error('Unauthorized');
  }

  const projectContext = await resolveProjectContext({
    activeProjectId: request.cookies.active_project_id,
    tenantDbName: session.tenantDbName,
    tenantId: session.tenantId,
    userId: session.userId,
  });

  if (projectContext.projectId) {
    patchRequestContext({ projectId: String(projectContext.projectId) });
  }

  return {
    ...projectContext,
    session,
  };
}
