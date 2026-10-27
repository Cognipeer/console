/**
 * requireApiTokenFromHeader caches `{ tokenRecord, tenant }` between requests.
 * With CACHE_PROVIDER=redis that entry goes through JSON, so the cached tenant's
 * Date fields come back as ISO strings. The first call (cache miss, real Dates
 * from the database) and every later call (cache hit, strings) must authenticate
 * the same way; a cached tenant with a license expiry used to fail every hit with
 * "expiresAt.getTime is not a function".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  // Serializes like RedisCacheProvider: JSON.stringify on set, JSON.parse on get.
  const store = new Map<string, string>();
  return {
    store,
    db: {
      findApiTokenByHash: vi.fn(),
      findTenantById: vi.fn(),
      switchToTenant: vi.fn(),
      findUserById: vi.fn(),
      updateTokenLastUsedByHash: vi.fn(),
    },
    ensureDefaultProject: vi.fn(),
    cache: {
      get: vi.fn(async (key: string) => {
        const raw = store.get(key);
        return raw === undefined ? undefined : JSON.parse(raw);
      }),
      set: vi.fn(async (key: string, value: unknown) => { store.set(key, JSON.stringify(value)); }),
      del: vi.fn(async (key: string) => { store.delete(key); }),
    },
  };
});

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_dbName: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({ getCache: vi.fn(async () => h.cache) }));
vi.mock('@/lib/core/asyncTask', () => ({
  fireAndForget: (_label: string, fn: () => Promise<void>) => { fn().catch(() => undefined); },
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: h.ensureDefaultProject,
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';

const AUTH = 'Bearer cgate_secret';
const licenseExpiresAt = new Date(Date.now() + 365 * 86_400_000);
const tenant = {
  _id: 't1',
  dbName: 'tenant_acme',
  slug: 'acme',
  licenseId: 'lic-1',
  licensePayload: { licenseId: 'lic-1', licenseType: 'ENTERPRISE' },
  licenseStatus: 'active',
  licenseType: 'ENTERPRISE',
  licenseExpiresAt,
  createdAt: new Date(),
};
const tokenRecord = { _id: 'tok-1', tenantId: 't1', userId: 'u1', projectId: 'p1', createdAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  h.store.clear();
  h.db.findApiTokenByHash.mockResolvedValue(tokenRecord);
  h.db.findTenantById.mockResolvedValue(tenant);
  h.db.findUserById.mockResolvedValue({ _id: 'u1', role: 'owner', tenantId: 't1' });
  h.db.updateTokenLastUsedByHash.mockResolvedValue(undefined);
  h.ensureDefaultProject.mockResolvedValue({ _id: 'p-default' });
});

describe('requireApiTokenFromHeader: auth cache that serializes to JSON', () => {
  it('authenticates the cached (second) call of a tenant whose license has an expiry', async () => {
    const first = await requireApiTokenFromHeader(AUTH);
    expect(first.tenant.licenseType).toBe('ENTERPRISE');
    expect(h.cache.set).toHaveBeenCalledTimes(1);

    // The entry really went through JSON: the expiry is now a string.
    const [cached] = [...h.store.values()].map((raw) => JSON.parse(raw));
    expect(typeof cached.tenant.licenseExpiresAt).toBe('string');

    const second = await requireApiTokenFromHeader(AUTH);
    expect(second.tenant.licenseType).toBe('ENTERPRISE');
    expect(second.projectId).toBe('p1');
    // Token and tenant came from the cache, not the database.
    expect(h.db.findApiTokenByHash).toHaveBeenCalledTimes(1);
    expect(h.db.findTenantById).toHaveBeenCalledTimes(1);
  });
});
