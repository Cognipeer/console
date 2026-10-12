/**
 * getUserAuthState / invalidateUserAuthState: the cached account-state lookup
 * every cookie-authenticated request goes through. Fail-closed contract: cache
 * failures degrade to a miss, DB failures reach the caller.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const cache = {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    del: vi.fn(async (key: string) => { store.delete(key); }),
  };
  const db = { findUserById: vi.fn() };
  return { store, cache, db };
});

vi.mock('@/lib/core/cache', () => ({ getCache: vi.fn(async () => h.cache) }));
vi.mock('@/lib/database', () => ({
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));

import { getCache } from '@/lib/core/cache';
import { runWithTenantScope } from '@/lib/database';
import { invalidatePrincipal } from '@/lib/iam/events';
import {
  USER_AUTH_STATE_TTL_SECONDS,
  USER_IDENTITY_TTL_SECONDS,
  getUserAuthState,
  getUserIdentity,
  invalidateUserAuthState,
  isUserDisabled,
  isUserLoginBlocked,
  userAuthStateCacheKey,
  userIdentityCacheKey,
} from '@/lib/services/users/userAuthState';

const DB = 'tenant_acme';
const KEY = `user-auth-state:${DB}:u1`;
const IDENTITY_KEY = `user-identity:${DB}:u1`;

beforeEach(() => {
  vi.clearAllMocks();
  h.store.clear();
  (getCache as ReturnType<typeof vi.fn>).mockResolvedValue(h.cache);
});

describe('predicates', () => {
  it('treats a missing status as active', () => {
    expect(isUserDisabled({})).toBe(false);
    expect(isUserDisabled(null)).toBe(false);
    expect(isUserDisabled(undefined)).toBe(false);
    expect(isUserDisabled({ status: 'active' })).toBe(false);
    expect(isUserDisabled({ status: 'disabled' })).toBe(true);
  });

  it('blocks login for canLogin=false OR disabled, never for legacy rows', () => {
    expect(isUserLoginBlocked({})).toBe(false);
    expect(isUserLoginBlocked({ canLogin: true })).toBe(false);
    expect(isUserLoginBlocked({ canLogin: false })).toBe(true);
    expect(isUserLoginBlocked({ canLogin: true, status: 'disabled' })).toBe(true);
  });

  it('builds the documented cache key', () => {
    expect(userAuthStateCacheKey(DB, 'u1')).toBe(KEY);
  });
});

describe('getUserAuthState', () => {
  it('returns a cached state without touching the database', async () => {
    h.store.set(KEY, 'disabled');
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('disabled');
    expect(h.db.findUserById).not.toHaveBeenCalled();
  });

  it('ignores a garbage cache value and re-reads the row', async () => {
    h.store.set(KEY, 'banana');
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('active');
    expect(h.db.findUserById).toHaveBeenCalledWith('u1');
  });

  it('on a miss loads the row in the tenant scope and caches the result with the 30s TTL', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('active');
    expect(runWithTenantScope).toHaveBeenCalledWith(DB, expect.any(Function));
    expect(h.cache.set).toHaveBeenCalledWith(KEY, 'active', USER_AUTH_STATE_TTL_SECONDS);
    expect(USER_AUTH_STATE_TTL_SECONDS).toBe(30);
  });

  it('treats a row without a status field as active (legacy / on-prem rows)', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', canLogin: true });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('active');
  });

  it('reports a disabled row and caches it', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', status: 'disabled' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('disabled');
    expect(h.store.get(KEY)).toBe('disabled');
  });

  it('reports a null row as missing and caches that too', async () => {
    h.db.findUserById.mockResolvedValue(null);
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('missing');
    expect(h.store.get(KEY)).toBe('missing');
  });

  it('reports a row from another tenant as missing', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 'other-tenant' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('missing');
  });

  it('does not treat an unset row tenantId as a mismatch', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('active');
  });

  it('lets a database error throw so callers fail closed, and caches nothing', async () => {
    h.db.findUserById.mockRejectedValue(new Error('db down'));
    await expect(getUserAuthState(DB, 't1', 'u1')).rejects.toThrow('db down');
    expect(h.cache.set).not.toHaveBeenCalled();
  });

  it('treats cache read and write failures as a miss', async () => {
    h.cache.get.mockRejectedValueOnce(new Error('redis down'));
    h.cache.set.mockRejectedValueOnce(new Error('redis down'));
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', status: 'disabled' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('disabled');
  });

  it('works when the cache cannot even be constructed', async () => {
    (getCache as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no cache'));
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('active');
  });
});

describe('invalidateUserAuthState', () => {
  it('deletes the cached entry so the next read hits the database', async () => {
    h.store.set(KEY, 'active');
    await invalidateUserAuthState(DB, 'u1');
    expect(h.cache.del).toHaveBeenCalledWith(KEY);

    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', status: 'disabled' });
    await expect(getUserAuthState(DB, 't1', 'u1')).resolves.toBe('disabled');
  });

  it('never throws when the cache is down', async () => {
    h.cache.del.mockRejectedValueOnce(new Error('redis down'));
    await expect(invalidateUserAuthState(DB, 'u1')).resolves.toBeUndefined();
  });
});


describe('getUserIdentity (state and current role)', () => {
  it('builds the documented cache key and keeps the account-state key as it was', () => {
    expect(userIdentityCacheKey(DB, 'u1')).toBe(IDENTITY_KEY);
    expect(userAuthStateCacheKey(DB, 'u1')).toBe(KEY);
  });

  it('on a miss reads the row in the tenant scope and caches state and role with the 30s TTL', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'admin' });
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'active', role: 'admin' });
    expect(runWithTenantScope).toHaveBeenCalledWith(DB, expect.any(Function));
    expect(h.cache.set).toHaveBeenCalledWith(IDENTITY_KEY, 'active:admin', USER_IDENTITY_TTL_SECONDS);
    expect(USER_IDENTITY_TTL_SECONDS).toBe(30);
    // the account-state entry is a different key and stays untouched
    expect(h.store.has(KEY)).toBe(false);
  });

  it('serves a cached identity without touching the database', async () => {
    h.store.set(IDENTITY_KEY, 'disabled:user');
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'disabled', role: 'user' });
    expect(h.db.findUserById).not.toHaveBeenCalled();
  });

  it('ignores a garbage cache value and re-reads the row', async () => {
    for (const bad of ['banana', 'active:galactic', 42, null]) {
      h.store.set(IDENTITY_KEY, bad);
      h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'user' });
      await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'active', role: 'user' });
    }
    expect(h.db.findUserById).toHaveBeenCalledTimes(4);
  });

  it('reports a disabled row with its role, and a missing or foreign row without one', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'project_admin', status: 'disabled' });
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'disabled', role: 'project_admin' });

    h.store.clear();
    h.db.findUserById.mockResolvedValue(null);
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'missing', role: null });
    expect(h.store.get(IDENTITY_KEY)).toBe('missing:');
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'missing', role: null });

    h.store.clear();
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 'other-tenant', role: 'owner' });
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'missing', role: null });
  });

  it('gives no role to a row whose role is not a known one', async () => {
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'galactic-overlord' });
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'active', role: null });
  });

  it('lets a database error throw so callers fail closed, and caches nothing', async () => {
    h.db.findUserById.mockRejectedValue(new Error('db down'));
    await expect(getUserIdentity(DB, 't1', 'u1')).rejects.toThrow('db down');
    expect(h.cache.set).not.toHaveBeenCalled();
  });

  it('treats cache failures as a miss', async () => {
    h.cache.get.mockRejectedValueOnce(new Error('redis down'));
    h.cache.set.mockRejectedValueOnce(new Error('redis down'));
    h.db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'owner' });
    await expect(getUserIdentity(DB, 't1', 'u1')).resolves.toEqual({ state: 'active', role: 'owner' });
  });

  it('invalidateUserAuthState drops BOTH entries', async () => {
    h.store.set(KEY, 'active');
    h.store.set(IDENTITY_KEY, 'active:admin');
    await invalidateUserAuthState(DB, 'u1');
    expect(h.cache.del).toHaveBeenCalledWith(KEY);
    expect(h.cache.del).toHaveBeenCalledWith(IDENTITY_KEY);
    expect(h.store.size).toBe(0);
  });

  it('a write to the user row (an IAM invalidation of that user) drops the cached identity', async () => {
    h.store.set(IDENTITY_KEY, 'active:admin');
    h.store.set(`user-identity:${DB}:u2`, 'active:user');
    invalidatePrincipal(DB, 'u1');
    await vi.waitFor(() => expect(h.store.has(IDENTITY_KEY)).toBe(false));
    // only that user's entry
    expect(h.store.has(`user-identity:${DB}:u2`)).toBe(true);
  });

  it('an invalidation without a tenant scope cannot name a cache entry and changes nothing', async () => {
    h.store.set(IDENTITY_KEY, 'active:admin');
    invalidatePrincipal(null, 'u1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.store.has(IDENTITY_KEY)).toBe(true);
  });
});
