/**
 * Per-request account-state lookup for the auth paths.
 *
 * Cookie sessions are stateless 7-day JWTs, so "is this account still allowed
 * in?" has to be answered from the user row on every request. That would be a
 * DB hit per request, so the answer is cached briefly (30s) and invalidated
 * eagerly by `invalidateUserAuthState` whenever an admin disables/enables/
 * deletes the account — the TTL only bounds how stale a *cross-replica*
 * in-memory cache can be.
 *
 * Staleness bounds: with a per-process in-memory cache (no shared Redis) other
 * replicas keep a cached 'active' for up to the TTL after a disable, and a read
 * that raced the invalidation can re-cache a stale value for up to the TTL as
 * well. Bearer API tokens are unaffected — their owner is read fresh per request.
 *
 * Fail-closed contract: a cache failure is just a miss, but a DB failure is
 * NOT swallowed — callers must treat a throw as "cannot verify" and deny.
 * A missing/undefined `status` always means active (legacy and on-prem rows).
 */
import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { IUser } from '@/lib/database';

const logger = createLogger('service:users:auth-state');

export const USER_AUTH_STATE_TTL_SECONDS = 30;

export type UserAuthState = 'active' | 'disabled' | 'missing';

export function isUserDisabled(user: Pick<IUser, 'status'> | null | undefined): boolean {
  return user?.status === 'disabled';
}

/** True when the account may not authenticate by any route (no login capability, or disabled). */
export function isUserLoginBlocked(user: Pick<IUser, 'canLogin' | 'status'>): boolean {
  return user.canLogin === false || isUserDisabled(user);
}

export function userAuthStateCacheKey(tenantDbName: string, userId: string): string {
  return `user-auth-state:${tenantDbName}:${userId}`;
}

function isUserAuthState(value: unknown): value is UserAuthState {
  return value === 'active' || value === 'disabled' || value === 'missing';
}

export async function getUserAuthState(
  tenantDbName: string,
  tenantId: string,
  userId: string,
): Promise<UserAuthState> {
  const key = userAuthStateCacheKey(tenantDbName, userId);

  try {
    const cache = await getCache();
    const cached = await cache.get<string>(key);
    if (isUserAuthState(cached)) return cached;
  } catch (error) {
    logger.warn('User auth-state cache read failed; falling back to the database', { error });
  }

  // No catch: a DB error must reach the caller so it can deny (fail closed).
  const user = await runWithTenantScope(tenantDbName, (db) => db.findUserById(userId));

  let state: UserAuthState;
  if (!user) {
    state = 'missing';
  } else if (user.tenantId && String(user.tenantId) !== String(tenantId)) {
    // A session/token minted for another tenant must never validate here.
    state = 'missing';
  } else {
    state = isUserDisabled(user) ? 'disabled' : 'active';
  }

  try {
    const cache = await getCache();
    await cache.set(key, state, USER_AUTH_STATE_TTL_SECONDS);
  } catch (error) {
    logger.warn('User auth-state cache write failed', { error });
  }

  return state;
}

/**
 * Drop the cached state so the next request re-reads the row. Best effort: if
 * the cache is unreachable the entry expires on its own within the TTL.
 */
export async function invalidateUserAuthState(
  tenantDbName: string,
  userId: string,
): Promise<void> {
  try {
    const cache = await getCache();
    await cache.del(userAuthStateCacheKey(tenantDbName, userId));
  } catch (error) {
    logger.warn('User auth-state cache invalidation failed', { error });
  }
}
