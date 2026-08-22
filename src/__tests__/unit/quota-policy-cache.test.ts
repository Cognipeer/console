/**
 * Unit tests — quota policy source caching
 *
 * Every guarded request used to re-read the tenant record and the policy
 * collection, and an inference call resolves limits three times before the
 * model is reached. These cover the cache that amortizes those reads, and the
 * per-request filtering that must NOT be cached with them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const cacheStore = new Map<string, unknown>();
const config = { quota: { policyCacheTtlSeconds: 30 } };

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/core/config', () => ({
  getConfig: () => config,
}));

vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({
    get: async (key: string) => cacheStore.get(key),
    set: async (key: string, value: unknown) => { cacheStore.set(key, value); },
    del: async (key: string) => { cacheStore.delete(key); },
  }),
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  }),
}));

import { getDatabase } from '@/lib/database';
import { resolveEffectiveLimits, quotaPolicyCacheKey } from '@/lib/quota/quotaGuard';
import type { QuotaContext } from '@/lib/quota/quotaGuard';
import type { ITenant, IQuotaPolicy } from '@/lib/database';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

function makeContext(overrides: Partial<QuotaContext> = {}): QuotaContext {
  return {
    tenantDbName: DB_NAME,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    licenseType: 'PROFESSIONAL',
    domain: 'llm',
    ...overrides,
  } as QuotaContext;
}

/** A tenant-scoped policy and a user-scoped one, so filtering is observable. */
function policies(): IQuotaPolicy[] {
  return [
    {
      _id: 'p-tenant',
      tenantId: TENANT_ID,
      domain: 'llm',
      scope: 'tenant',
      priority: 10,
      enabled: true,
      limits: { rateLimit: { requests: { perMinute: 100 } } },
    } as unknown as IQuotaPolicy,
    {
      _id: 'p-user',
      tenantId: TENANT_ID,
      domain: 'llm',
      scope: 'user',
      scopeId: 'user-vip',
      priority: 20,
      enabled: true,
      limits: { rateLimit: { requests: { perMinute: 999 } } },
    } as unknown as IQuotaPolicy,
  ];
}

describe('quota policy source cache', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    config.quota.policyCacheTtlSeconds = 30;
    db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: TENANT_ID, slug: 'acme' } as unknown as ITenant);
    db.listQuotaPolicies.mockResolvedValue(policies());
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('reads the tenant and its policies once across repeated resolutions', async () => {
    await resolveEffectiveLimits(makeContext());
    await resolveEffectiveLimits(makeContext());
    await resolveEffectiveLimits(makeContext());

    expect(db.findTenantById).toHaveBeenCalledTimes(1);
    expect(db.listQuotaPolicies).toHaveBeenCalledTimes(1);
  });

  it('still applies per-caller scope filtering on a cache hit', async () => {
    const anonymous = await resolveEffectiveLimits(makeContext());
    const vip = await resolveEffectiveLimits(makeContext({ userId: 'user-vip' }));

    // Same cached policy set, different callers — the user-scoped policy must
    // reach only the caller it names.
    expect(anonymous.rateLimit?.requests?.perMinute).toBe(100);
    expect(vip.rateLimit?.requests?.perMinute).toBe(999);
    expect(db.listQuotaPolicies).toHaveBeenCalledTimes(1);
  });

  it('keeps separate entries per project', async () => {
    await resolveEffectiveLimits(makeContext());
    await resolveEffectiveLimits(makeContext({ projectId: 'proj-2' }));

    expect(db.listQuotaPolicies).toHaveBeenCalledTimes(2);
  });

  it('goes back to the database once the entry is dropped', async () => {
    await resolveEffectiveLimits(makeContext());
    cacheStore.delete(quotaPolicyCacheKey(DB_NAME, TENANT_ID, PROJECT_ID));
    await resolveEffectiveLimits(makeContext());

    expect(db.listQuotaPolicies).toHaveBeenCalledTimes(2);
  });

  it('reads through on every call when the cache is disabled', async () => {
    config.quota.policyCacheTtlSeconds = 0;

    await resolveEffectiveLimits(makeContext());
    await resolveEffectiveLimits(makeContext());

    expect(db.findTenantById).toHaveBeenCalledTimes(2);
    expect(db.listQuotaPolicies).toHaveBeenCalledTimes(2);
  });
});
