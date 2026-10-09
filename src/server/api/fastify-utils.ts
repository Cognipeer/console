import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { trustsEveryHop } from '@/lib/security/trustedProxy';
import { getDatabase, type IUser } from '@/lib/database';
import { isShuttingDown } from '@/lib/core/lifecycle';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import { patchRequestContext, runWithRequestContext } from '@/lib/core/requestContext';
import {
  authorizeService,
  authorizeServiceRequest,
  type GroupTenantGrant,
  type PermissionService,
  type ServicePermissionLevel,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { canonicalizeRequestPathname } from '@/lib/security/requestPath';
import { serviceDenialReason } from '@/lib/iam/denialReason';
import { loadGroupGrants } from '@/lib/iam/groupGrants';
import { markGated, resolveRouteAuthz, type RouteAuthzResolution } from '@/lib/iam/routeAuthz';
import { authorizeServiceAccess, type ServiceAuthzOptions, type ServiceAuthzResult } from '@/lib/iam/requestAuthz';
import { resolveEnforcement } from '@/lib/iam/shadow/mode';
import { observeGateDecision, observeUnmappedPath } from '@/lib/iam/shadow/observer';
import { canonicalRoute } from '@/lib/iam/shadow/routePattern';
import { getUserAuthState, isUserDisabled } from '@/lib/services/users/userAuthState';
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

class RbacAuthorizationError extends Error {
  status: number;
  /**
   * Structured denial (enforce mode): `{ error, code, ... }`, where `error` is the
   * same reason sentence legacy mode sends (`error.message` of this error). Session
   * routes send it as is; the client-API error styles embed `code` in their
   * envelope and keep `error.message` as the reason.
   */
  body?: Record<string, unknown>;

  constructor(message: string, status = 403, body?: Record<string, unknown>) {
    super(message);
    this.name = 'RbacAuthorizationError';
    this.status = status;
    this.body = body;
  }
}

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
  return canonicalizeRequestPathname(request.raw.url);
}

async function loadRbacUser(session: ApiSessionContext): Promise<IUser> {
  const db = await getDatabase();
  await db.switchToTenant(session.tenantDbName);
  // Defense-in-depth: verify the active tenant context matches the session.
  // Real providers always implement assertTenantContext; test mocks may not.
  if (typeof db.assertTenantContext === 'function') {
    db.assertTenantContext(session.tenantDbName);
  }
  const user = await db.findUserById(session.userId);
  if (!user) {
    throw new RbacAuthorizationError('Unauthorized', 401);
  }
  // Defense-in-depth: ensure the loaded user record actually belongs to the
  // session's tenant. (DB partitioning already enforces this, but a mis-bound
  // mock or future refactor could break the invariant — fail loudly here.)
  if (user.tenantId && String(user.tenantId) !== String(session.tenantId)) {
    throw new RbacAuthorizationError('Tenant mismatch', 403);
  }
  // Defense-in-depth: the global session hook already rejects disabled
  // accounts, but this is also the entry point for callers that bypass it
  // (e.g. realtime cookie auth via resolveSessionRbacContext).
  if (isUserDisabled(user)) {
    throw new RbacAuthorizationError('Account is disabled', 401);
  }
  return user;
}

/**
 * Cookie sessions are stateless JWTs, so a disabled or deleted account is
 * only caught by re-checking the user row (cached ~30s, invalidated on
 * disable/delete). Runs for EVERY cookie-authenticated request, mapped to an
 * RBAC service or not. Returns true when it sent a rejection; fail closed:
 * if the state cannot be read the request is refused with a 503.
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
    return false;
  }

  clearSessionCookies(reply);
  reply.code(401).send(
    state === 'disabled'
      ? { error: 'Unauthorized', message: 'Account is disabled', code: 'account_disabled' }
      : { error: 'Unauthorized', message: 'Account no longer exists', code: 'account_missing' },
  );
  return true;
}

/**
 * Loads the tenant-level grants of every group the user belongs to. These are
 * unioned with the user's own role/permissions at authorization time, so group
 * membership can only ever raise access. Resolved per request (not baked into
 * the session) so group edits take effect immediately without re-login.
 */
async function loadGroupTenantGrants(
  db: Awaited<ReturnType<typeof getDatabase>>,
  userId: string,
): Promise<GroupTenantGrant[]> {
  // Defensive: a provider without group support (or a partial test double) must
  // never break the authorization gate — treat a missing/empty result as "no
  // group grants" rather than throwing. The loader keeps exactly that contract
  // and the old per-membership point reads (bounded concurrency, same order).
  return loadGroupGrants(db, userId);
}

/**
 * Resolves the RBAC user + group grants for routes that are not covered by the
 * route-prefix map (e.g. /api/dashboard) but still need per-item permission
 * filtering inside the handler. Reuses the exact same loaders as the
 * route-level RBAC gate so both paths can never diverge.
 */
export async function resolveSessionRbacContext(
  session: ApiSessionContext,
): Promise<{ user: IUser; groupGrants: GroupTenantGrant[] }> {
  const user = await loadRbacUser(session);
  const db = await getDatabase();
  const groupGrants = await loadGroupTenantGrants(db, String(user._id));
  return { user, groupGrants };
}

/**
 * A second, handler-level service check (after the route gate) that follows the
 * tenant's authorization mode: the rbac.ts answer in legacy / shadow, the policy
 * engine's (groups for tokens, project narrowing, custom policies) in enforce.
 * Use it instead of calling rbac.ts directly whenever a handler decides on a
 * permission service itself (per-item filtering, an extra "admin only" switch).
 * Works for dashboard sessions and for API-token requests.
 */
export async function authorizeServiceForRequest(
  request: FastifyRequest,
  service: PermissionService,
  options: ServiceAuthzOptions & { rbac?: { user: IUser; groupGrants: GroupTenantGrant[] } } = {},
): Promise<ServiceAuthzResult> {
  const result = await decideServiceForRequest(request, service, options);
  // A refusal the handler turns into a 403 names its decision (X-Decision-Id).
  if (!result.allowed && result.decisionId) request.iamDecisionId = result.decisionId;
  return result;
}

async function decideServiceForRequest(
  request: FastifyRequest,
  service: PermissionService,
  options: ServiceAuthzOptions & { rbac?: { user: IUser; groupGrants: GroupTenantGrant[] } },
): Promise<ServiceAuthzResult> {
  const requestId = request.apiRequestId ?? 'unknown';
  const route = routeLabel(request, getRequestPathname(request));
  const common = { requestId, route, ...options };

  const tokenContext = request.apiTokenContext;
  if (tokenContext) {
    if (!tokenContext.user) {
      return { allowed: false, service, required: options.level ?? 'read', enforced: false };
    }
    return authorizeServiceAccess({
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
    }, service, common);
  }

  const session = requireSessionContext(request);
  const rbac = options.rbac ?? await resolveSessionRbacContext(session);
  return authorizeServiceAccess({
    subject: 'session',
    tenantDbName: session.tenantDbName,
    tenantId: session.tenantId,
    userId: String(rbac.user._id),
    user: rbac.user,
    groupGrants: rbac.groupGrants,
    projectId: sessionProject(request).projectId,
    projectFromPath: sessionProject(request).fromPath,
    ip: getAuthzClientIp(request),
    path: getRequestPathname(request),
  }, service, common);
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

interface LegacyVerdict {
  allowed: boolean;
  service: PermissionService;
  required?: ServicePermissionLevel;
}

/**
 * The legacy (rbac.ts) decision for a request that resolves to a service. A
 * route that merely falls under a ROUTE_PREFIXES entry goes through
 * authorizeServiceRequest exactly as before; only an explicit `service`
 * declaration (new, may carry a `level`) uses the resolved-service variant.
 */
function legacyVerdict(
  resolution: RouteAuthzResolution,
  user: IUser,
  method: string,
  pathname: string,
  groupGrants: GroupTenantGrant[],
  tokenScope: UserServicePermissions | null | undefined,
  target: { service: PermissionService; level?: 'read' | 'write' | 'admin' },
): LegacyVerdict {
  if (resolution.declaration?.kind === 'service') {
    const d = authorizeService(user, method, target.service, groupGrants, tokenScope, target.level);
    return { allowed: d.allowed, service: d.service, required: d.required };
  }
  const d = authorizeServiceRequest(user, method, pathname, groupGrants, tokenScope);
  return { allowed: d.allowed, service: d.service ?? target.service, required: d.required };
}

/**
 * Enforce mode: what to do with a request that does not resolve to a service.
 * `public` / `self` / `authenticated` declarations let it through (the handler,
 * the global hook or the token wrapper authenticated the caller); an undeclared
 * route is refused with 403 `route_not_declared`.
 */
async function applyNonServiceDeclaration(
  request: FastifyRequest,
  resolution: RouteAuthzResolution,
  tenantDbName: string,
  log: Record<string, unknown>,
): Promise<void> {
  const kind = resolution.effective.kind;
  if (kind !== 'undeclared') {
    // public / self: the handler is responsible. authenticated: the caller is a
    // signed-in principal of the tenant (the global hook / token auth ran).
    return;
  }
  const { recordUndeclaredDenial, undeclaredRouteBody } = await import('@/lib/iam/enforce');
  recordUndeclaredDenial(tenantDbName, log);
  const body = undeclaredRouteBody();
  request.iamDenial = { code: 'route_not_declared' };
  throw new RbacAuthorizationError(body.message, 403, body);
}

async function enforceSessionRbac(request: FastifyRequest, session: ApiSessionContext): Promise<void> {
  const pathname = getRequestPathname(request);
  const resolution = resolveRequestAuthz(request, pathname);
  const enforced = await resolveEnforcement(session.tenantDbName);

  // Not a service route: legacy never gated it. Enforce decides by declaration.
  const target = enforced
    ? (resolution.effective.kind === 'service' ? resolution.effective : null)
    : resolution.legacy;

  if (!target) {
    if (resolution.effective.kind === 'undeclared') {
      // Shadow/enforce only: record that an authenticated caller reached a route
      // nobody declared (enforce refuses it). Synchronous, never throws.
      observeUnmappedPath(session.tenantDbName, () => ({
        subject: 'session',
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        requestId: request.apiRequestId ?? session.requestId,
        method: request.method,
        pathname,
        route: routeLabel(request, pathname),
        userId: session.userId,
        role: session.userRole,
      }));
    }
    if (enforced) {
      await applyNonServiceDeclaration(request, resolution, session.tenantDbName, {
        subject: 'session',
        requestId: request.apiRequestId ?? session.requestId,
        method: request.method,
        route: routeLabel(request, pathname),
        userId: session.userId,
      });
    }
    return;
  }

  const user = await loadRbacUser(session);
  request.rbacUser = user;
  // db is already switched to the session tenant by loadRbacUser.
  const db = await getDatabase();
  const groupGrants = await loadGroupTenantGrants(db, String(user._id));
  const decision = legacyVerdict(resolution, user, request.method, pathname, groupGrants, undefined, target);
  // Shadow mode (C2): evaluate the policy engine off the request path against
  // the decision just computed. Fire-and-forget; see lib/iam/shadow/observer.
  observeGateDecision(session.tenantDbName, () => ({
    subject: 'session',
    tenantDbName: session.tenantDbName,
    tenantId: session.tenantId,
    requestId: request.apiRequestId ?? session.requestId,
    method: request.method,
    pathname,
    route: routeLabel(request, pathname),
    userId: String(user._id),
    role: typeof user.role === 'string' ? user.role : '',
    user: { role: user.role, servicePermissions: user.servicePermissions, projectIds: user.projectIds },
    groupGrants,
    activeProjectId: sessionProject(request).projectId,
    projectFromPath: sessionProject(request).fromPath,
    ip: getAuthzClientIp(request),
    legacy: { allowed: decision.allowed, service: decision.service, required: decision.required, level: target.level },
  }));

  if (enforced) {
    const { decideEnforced, forbiddenBody } = await import('@/lib/iam/enforce');
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
      requestedProjectId: sessionProject(request).projectId,
      projectFromPath: sessionProject(request).fromPath,
      service: decision.service,
      level: target.level,
      legacyAllowed: decision.allowed,
      ip: getAuthzClientIp(request),
      path: pathname,
    });
    if (!verdict.allowed) {
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
      throw new RbacAuthorizationError(String(body.message), 403, body);
    }
    return;
  }

  if (!decision.allowed) {
    throw new RbacAuthorizationError(serviceDenialReason(decision.service, decision.required), 403);
  }
}

async function enforceApiTokenRbac(
  request: FastifyRequest,
  context: ApiTokenContext,
): Promise<void> {
  const pathname = getRequestPathname(request);
  const resolution = resolveRequestAuthz(request, pathname);
  const enforced = await resolveEnforcement(context.tenantDbName);

  const target = enforced
    ? (resolution.effective.kind === 'service' ? resolution.effective : null)
    : resolution.legacy;

  if (!target) {
    if (resolution.effective.kind === 'undeclared') {
      observeUnmappedPath(context.tenantDbName, () => ({
        subject: 'token',
        tenantDbName: context.tenantDbName,
        tenantId: context.tenantId,
        requestId: request.apiRequestId ?? 'unknown',
        method: request.method,
        pathname,
        route: routeLabel(request, pathname),
        userId: String(context.tokenRecord.userId ?? ''),
        role: typeof context.user?.role === 'string' ? context.user.role : '',
        tokenId: context.tokenRecord._id ? String(context.tokenRecord._id) : undefined,
      }));
    }
    if (enforced) {
      await applyNonServiceDeclaration(request, resolution, context.tenantDbName, {
        subject: 'token',
        requestId: request.apiRequestId ?? 'unknown',
        method: request.method,
        route: routeLabel(request, pathname),
        tokenId: context.tokenRecord._id ? String(context.tokenRecord._id) : undefined,
      });
    }
    return;
  }

  if (!context.user) {
    throw new RbacAuthorizationError('API token owner is not available', 403);
  }

  request.rbacUser = context.user;
  const owner = context.user;
  const decision = legacyVerdict(
    resolution,
    owner,
    request.method,
    pathname,
    [],
    // Least-privilege token scope: when the token carries its own
    // servicePermissions allowlist, cap the owner-derived permission at it.
    // Unscoped tokens (null) inherit the owner's permissions unchanged.
    context.tokenRecord.servicePermissions,
    target,
  );
  observeGateDecision(context.tenantDbName, () => ({
    subject: 'token',
    tenantDbName: context.tenantDbName,
    tenantId: context.tenantId,
    requestId: request.apiRequestId ?? 'unknown',
    method: request.method,
    pathname,
    route: routeLabel(request, pathname),
    userId: String(owner._id),
    role: typeof owner.role === 'string' ? owner.role : '',
    tokenId: context.tokenRecord._id ? String(context.tokenRecord._id) : undefined,
    user: { role: owner.role, servicePermissions: owner.servicePermissions, projectIds: owner.projectIds },
    groupGrants: [],
    tokenScope: context.tokenRecord.servicePermissions,
    // The project the handler will run in (the token's own, else the default one).
    activeProjectId: context.projectId ? String(context.projectId) : null,
    ip: getAuthzClientIp(request),
    legacy: { allowed: decision.allowed, service: decision.service, required: decision.required, level: target.level },
  }));

  if (enforced) {
    const { decideEnforced, forbiddenBody } = await import('@/lib/iam/enforce');
    const verdict = await decideEnforced({
      subject: 'token',
      tenantDbName: context.tenantDbName,
      tenantId: context.tenantId,
      requestId: request.apiRequestId ?? 'unknown',
      method: request.method,
      route: routeLabel(request, pathname),
      userId: String(owner._id),
      user: owner,
      groupGrants: [],
      tokenId: context.tokenRecord._id ? String(context.tokenRecord._id) : undefined,
      tokenScope: context.tokenRecord.servicePermissions,
      requestedProjectId: context.projectId ? String(context.projectId) : null,
      service: decision.service,
      level: target.level,
      legacyAllowed: decision.allowed,
      ip: getAuthzClientIp(request),
      path: pathname,
    });
    if (!verdict.allowed) {
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
      throw new RbacAuthorizationError(String(body.message), 403, body);
    }
    return;
  }

  if (!decision.allowed) {
    throw new RbacAuthorizationError(serviceDenialReason(decision.service, decision.required), 403);
  }
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

  return null;
}

function sendRbacError(reply: FastifyReply, error: unknown) {
  if (error instanceof RbacAuthorizationError) {
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
      }

      return runWithRequestContext(
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
      return sendRbacError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
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
    // An enforce-mode refusal names its decision in every dialect, so an API
    // caller can hand it to IAM center > Access check like a dashboard user can.
    const decisionId = typeof error.body?.decisionId === 'string' ? error.body.decisionId : undefined;
    const extra = decisionId ? { decision_id: decisionId } : {};
    if (style === 'anthropic') {
      const envelope = anthropicErrorEnvelope(error.message, 'permission_error');
      return reply.code(error.status).send({ ...envelope, error: { ...envelope.error, ...extra } });
    }
    if (style === 'openai') {
      const body = openAiErrorBody(error.message, 'permission_error');
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
