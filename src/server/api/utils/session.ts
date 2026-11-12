import { createLogger } from '@/lib/core/logger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { runWithTenantScope, type IGroup, type IUser } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { patchRequestContext } from '@/lib/core/requestContext';
import type { GroupTenantGrant } from '@/lib/security/rbac';
import { fetchGroupsByIds, grantsOf, listUserGroupIds } from '@/lib/iam/groupGrants';
import {
  getUserAuthState,
  getUserIdentity,
  isSessionIssuedBeforeCredentialChange,
  isUserDisabled,
} from '@/lib/services/users/userAuthState';
import { ProjectContextError, resolveProjectContext, type ProjectContext } from '@/lib/services/projects/projectContext';
import { RbacAuthorizationError, sendRbacError } from './rbacError';

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
export async function loadSessionAuthz(
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
 *
 * A session issued before the account's password was last set (`issuedAt`, the
 * JWT `iat`, against the same cached identity) is refused with 401 and its
 * cookies are cleared: changing or resetting a password ends the other sessions.
 */
export async function rejectInactiveSessionAccount(
  reply: FastifyReply,
  session: { tenantDbName: string; tenantId: string; userId: string; issuedAt?: number },
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

/**
 * Sets the role of the request's session context to the one the account has now, and refuses a session
 * issued before the last password change; true when it refused the request.
 */
async function applyCurrentRole(
  reply: FastifyReply,
  session: { tenantDbName: string; tenantId: string; userId: string; issuedAt?: number },
): Promise<boolean> {
  const headers = reply.request?.apiContextHeaders;
  if (!headers) return false;
  try {
    const identity = await getUserIdentity(session.tenantDbName, session.tenantId, session.userId);
    if (
      getConfig().auth?.passwordChangeEndsSessions !== false
      && isSessionIssuedBeforeCredentialChange(session.issuedAt, identity.sessionsValidFrom)
    ) {
      clearSessionCookies(reply);
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Session is no longer valid. Please sign in again.',
        code: 'session_expired',
      });
      return true;
    }
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
