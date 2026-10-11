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
import { onIamInvalidation } from '@/lib/iam/events';
import { isTenantRole, type TenantRole } from '@/lib/iam/identity';

const logger = createLogger('service:users:auth-state');

export const USER_AUTH_STATE_TTL_SECONDS = 30;

export type UserAuthState = 'active' | 'disabled' | 'missing';

export function isUserDisabled(user: Pick<IUser, 'status'> | null | undefined): boolean {
  return user?.status === 'disabled';
}

/**
 * True when the account may not authenticate by any route: no login capability, disabled, or an EXTERNAL account
 * (a person of a host application who uses a portal's embed - they never sign in to the dashboard, whatever vouches for them).
 */
export function isUserLoginBlocked(user: Pick<IUser, 'canLogin' | 'status'> & { kind?: IUser['kind'] }): boolean {
  return user.canLogin === false || user.kind === 'external' || isUserDisabled(user);
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

/* ------------------------------------------------------------------ */
/*  Identity: account state AND the current role                       */
/* ------------------------------------------------------------------ */

/**
 * A session carries the role the account had when it was issued, but a role can be
 * changed afterwards. Everything that decides on a role (the handlers' own checks,
 * the server-rendered layouts) therefore asks for the role the database holds now.
 * The answer is cached for as long as the account state is and dropped by the same
 * events (`invalidateUserAuthState`, and any write to the user row in this process).
 *
 * Same fail-closed contract as `getUserAuthState`: a database error is not swallowed.
 */
export const USER_IDENTITY_TTL_SECONDS = 30;

export interface UserIdentity {
  state: UserAuthState;
  /** The role the account has now; null when the account is missing or its role is not a known one. */
  role: TenantRole | null;
}

export function userIdentityCacheKey(tenantDbName: string, userId: string): string {
  return `user-identity:${tenantDbName}:${userId}`;
}

/** `active:admin`, `disabled:user`, `missing:` - the cached form of an identity. */
function serializeIdentity(identity: UserIdentity): string {
  return `${identity.state}:${identity.role ?? ''}`;
}

function parseIdentity(value: unknown): UserIdentity | null {
  if (typeof value !== 'string') return null;
  const [state, role = ''] = value.split(':');
  if (!isUserAuthState(state)) return null;
  if (role !== '' && !isTenantRole(role)) return null;
  return { state, role: role === '' ? null : (role as TenantRole) };
}

function identityOf(user: IUser | null, tenantId: string): UserIdentity {
  // A session/token minted for another tenant must never validate here.
  if (!user || (user.tenantId && String(user.tenantId) !== String(tenantId))) {
    return { state: 'missing', role: null };
  }
  return {
    state: isUserDisabled(user) ? 'disabled' : 'active',
    role: isTenantRole(user.role) ? user.role : null,
  };
}

export async function getUserIdentity(
  tenantDbName: string,
  tenantId: string,
  userId: string,
): Promise<UserIdentity> {
  const key = userIdentityCacheKey(tenantDbName, userId);

  try {
    const cache = await getCache();
    const cached = parseIdentity(await cache.get<string>(key));
    if (cached) return cached;
  } catch (error) {
    logger.warn('User identity cache read failed; falling back to the database', { error });
  }

  // No catch: a DB error must reach the caller so it can deny (fail closed).
  const user = await runWithTenantScope(tenantDbName, (db) => db.findUserById(userId));
  const identity = identityOf(user, tenantId);

  try {
    const cache = await getCache();
    await cache.set(key, serializeIdentity(identity), USER_IDENTITY_TTL_SECONDS);
  } catch (error) {
    logger.warn('User identity cache write failed', { error });
  }

  return identity;
}

/**
 * Drop the cached state and role so the next request re-reads the row. Best
 * effort: if the cache is unreachable the entries expire on their own within the
 * TTL.
 */
export async function invalidateUserAuthState(
  tenantDbName: string,
  userId: string,
): Promise<void> {
  try {
    const cache = await getCache();
    await cache.del(userAuthStateCacheKey(tenantDbName, userId));
    await cache.del(userIdentityCacheKey(tenantDbName, userId));
  } catch (error) {
    logger.warn('User auth-state cache invalidation failed', { error });
  }
}

/**
 * A write to a user row anywhere in this process (a role change, a disable, an
 * LDAP/SSO sync, a token API call) drops that user's cached identity at once - the
 * provider reports it as an IAM invalidation. Other servers pick the change up
 * when the entry expires, within USER_IDENTITY_TTL_SECONDS.
 */
function dropIdentityOf(tenantDbName: string, userId: string): void {
  void (async () => {
    try {
      const cache = await getCache();
      await cache.del(userIdentityCacheKey(tenantDbName, userId));
    } catch (error) {
      logger.warn('User identity cache invalidation failed', { error });
    }
  })();
}

onIamInvalidation((event) => {
  if (event.kind === 'user' && event.tenantDbName) dropIdentityOf(event.tenantDbName, event.userId);
});
