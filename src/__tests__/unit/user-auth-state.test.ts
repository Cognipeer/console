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
import {
  USER_AUTH_STATE_TTL_SECONDS,
  getUserAuthState,
  invalidateUserAuthState,
  isUserDisabled,
  isUserLoginBlocked,
  userAuthStateCacheKey,
} from '@/lib/services/users/userAuthState';

const DB = 'tenant_acme';
const KEY = `user-auth-state:${DB}:u1`;

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
