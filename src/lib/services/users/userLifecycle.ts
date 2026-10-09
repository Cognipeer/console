/**
 * User lifecycle: disable / enable an account and tear down what a deleted
 * user leaves behind.
 *
 * Disabling is a soft, reversible block — the row, role and memberships stay,
 * and every auth path (cookie sessions, API tokens, background runs) refuses
 * the account via `userAuthState`. Owners are never a target, matching the
 * delete and permissions rules, so a tenant can't be locked out of its own
 * owner account through this surface.
 */
import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { IUser } from '@/lib/database';
import type { PermissionService } from '@/lib/security/rbac';
import { recordAuditLog } from '@/lib/services/audit/auditService';
import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
import { hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { invalidateUserAuthState, isUserDisabled } from './userAuthState';

const logger = createLogger('service:users:lifecycle');

export const MAX_DISABLE_REASON_LENGTH = 500;

/** The RBAC service `/api/users` is mapped to in `ROUTE_PREFIXES`. */
const USERS_AUDIT_SERVICE: PermissionService = 'members';

export type UserLifecycleStatus = 'active' | 'disabled';

/* ------------------------------------------------------------------ */
/*  Status-change listener seam                                        */
/* ------------------------------------------------------------------ */

export interface UserStatusChangedEvent {
  tenantDbName: string;
  tenantId: string;
  userId: string;
  status: UserLifecycleStatus;
}

export type UserStatusChangedListener = (
  event: UserStatusChangedEvent,
) => void | Promise<void>;

const statusListeners = new Set<UserStatusChangedListener>();

/**
 * Subscribe to account status changes (the enterprise overlay uses this to
 * close a disabled user's terminals and realtime sockets). Returns the
 * unsubscribe function.
 */
export function onUserStatusChanged(listener: UserStatusChangedListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/**
 * Run every listener without waiting for it. A throwing or rejecting listener
 * is logged and isolated: it must never fail the request that changed the
 * status, nor prevent the other listeners from running.
 */
export function notifyUserStatusChanged(event: UserStatusChangedEvent): void {
  for (const listener of [...statusListeners]) {
    try {
      Promise.resolve(listener(event)).catch((error) => {
        logger.error('User status listener failed', { error, userId: event.userId });
      });
    } catch (error) {
      logger.error('User status listener failed', { error, userId: event.userId });
    }
  }
}

/* ------------------------------------------------------------------ */
/*  setUserStatus                                                      */
/* ------------------------------------------------------------------ */

export interface UserStatusActor {
  type: 'user' | 'api_token';
  userId: string;
  email?: string;
  role?: string;
  apiTokenId?: string;
}

export interface SetUserStatusInput {
  tenantDbName: string;
  tenantId: string;
  actor: UserStatusActor;
  targetUserId: string;
  status: UserLifecycleStatus;
  reason?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export type SetUserStatusResult =
  | { ok: true; user: IUser }
  | { ok: false; httpStatus: 400 | 403 | 404; error: string };

function normalizeReason(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim().slice(0, MAX_DISABLE_REASON_LENGTH);
  return trimmed || undefined;
}

export async function setUserStatus(input: SetUserStatusInput): Promise<SetUserStatusResult> {
  const { tenantDbName, tenantId, actor, targetUserId, status } = input;

  if (String(targetUserId) === String(actor.userId)) {
    return {
      ok: false,
      httpStatus: 400,
      error: 'You cannot change the status of your own account',
    };
  }

  const target = await runWithTenantScope(tenantDbName, (db) => db.findUserById(targetUserId));
  if (!target || (target.tenantId && String(target.tenantId) !== String(tenantId))) {
    return { ok: false, httpStatus: 404, error: 'User not found' };
  }
  // The pre-load check above compares raw strings; a differently formatted id
  // (e.g. uppercase hex, which ObjectId accepts) resolves to the same row, so
  // compare the canonical ids once the row is loaded.
  if (target._id && String(target._id) === String(actor.userId)) {
    return {
      ok: false,
      httpStatus: 400,
      error: 'You cannot change the status of your own account',
    };
  }
  if (target.role === 'owner') {
    return { ok: false, httpStatus: 403, error: 'Owner accounts cannot be disabled' };
  }

  // Idempotent: repeating the current state is a success with no write and no
  // audit row, so a retried request can't pad the audit trail.
  if ((status === 'disabled') === isUserDisabled(target)) {
    return { ok: true, user: target };
  }

  const reason = normalizeReason(input.reason);
  const patch: Partial<IUser> = status === 'disabled'
    ? {
      status: 'disabled',
      disabledAt: new Date(),
      disabledBy: actor.userId,
      disabledReason: reason ?? null,
    }
    : {
      status: 'active',
      disabledAt: null,
      disabledBy: null,
      disabledReason: null,
    };

  const updated = await runWithTenantScope(tenantDbName, (db) => db.updateUser(targetUserId, patch));
  if (!updated) {
    return { ok: false, httpStatus: 404, error: 'User not found' };
  }

  // Before the audit/notify so the very next request already sees the new state.
  await invalidateUserAuthState(tenantDbName, targetUserId);

  criticalFireAndForget('user-status-audit', () => runWithTenantScope(tenantDbName, () => recordAuditLog(
    { tenantDbName, tenantId },
    {
      action: 'security',
      actorType: actor.type,
      actorUserId: actor.userId,
      actorEmail: actor.email,
      actorRole: actor.role,
      apiTokenId: actor.apiTokenId,
      event: status === 'disabled' ? 'user.disable' : 'user.enable',
      ipAddress: input.ipAddress,
      metadata: { reason: reason ?? null },
      outcome: 'success',
      requestId: input.requestId,
      resourceId: targetUserId,
      resourceType: 'user',
      service: USERS_AUDIT_SERVICE,
      userAgent: input.userAgent,
    },
  )));

  notifyUserStatusChanged({ tenantDbName, tenantId, userId: targetUserId, status });

  return { ok: true, user: updated };
}

/* ------------------------------------------------------------------ */
/*  Delete cleanup                                                     */
/* ------------------------------------------------------------------ */

/**
 * Delete every API token a user owns and evict their auth-cache entries.
 * Without this a deleted user's tokens were orphaned and — until the owner
 * lookup became strict — kept authenticating. Best effort per token: one
 * failure is logged and the rest are still revoked.
 */
export async function revokeUserApiTokens(
  tenantDbName: string,
  userId: string,
): Promise<{ revoked: number; failed: number }> {
  const tokens = await runWithTenantScope(tenantDbName, (db) => db.listApiTokens(userId));

  let revoked = 0;
  let failed = 0;
  for (const token of tokens) {
    const tokenId = String(token._id);
    try {
      const deleted = await runWithTenantScope(tenantDbName, (db) => db.deleteApiToken(tokenId, userId));
      if (deleted) revoked += 1;
      // Legacy rows may carry only the plaintext token; hash it so the cache
      // entry the auth path would have written is still found.
      const tokenHash = token.tokenHash ?? (token.token ? hashApiToken(token.token) : undefined);
      await invalidateApiTokenAuthCache(tokenHash);
    } catch (error) {
      failed += 1;
      logger.error('Failed to revoke API token for user', { error, tokenId, userId });
    }
  }
  return { revoked, failed };
}

/**
 * The cleanup both DELETE /users/:id surfaces run after a successful
 * `db.deleteUser`: revoke the user's tokens and drop the cached auth state.
 * Passing `tenantId` also notifies status listeners. Never throws: the row is
 * already gone, so a cleanup failure is logged, not returned as a failed delete.
 */
export async function cleanupDeletedUser(
  tenantDbName: string,
  userId: string,
  tenantId?: string,
): Promise<void> {
  try {
    await revokeUserApiTokens(tenantDbName, userId);
  } catch (error) {
    logger.error('Failed to revoke API tokens of deleted user', { error, userId });
  }
  await invalidateUserAuthState(tenantDbName, userId);
  // A deleted account must lose its open terminals / realtime sockets just like
  // a disabled one, so listeners get the same event (status 'disabled').
  // In-process only: other replicas' listeners are not reached.
  if (tenantId) {
    notifyUserStatusChanged({ tenantDbName, tenantId, userId, status: 'disabled' });
  }
}
