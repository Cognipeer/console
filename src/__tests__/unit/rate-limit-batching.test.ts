/**
 * Unit tests — batched rate-limit counters
 *
 * A guarded request touches a counter per metric per window. Issued separately
 * those are up to 25 concurrent round trips, enough for one caller to hold
 * every connection in the pool while its own limits are checked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const cacheStore = new Map<string, unknown>();
const config = {
  quota: { policyCacheTtlSeconds: 0 },
  rateLimit: { provider: 'mongodb' as 'mongodb' | 'memory' | 'redis' },
};

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/config', () => ({ getConfig: () => config }));
vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({
    name: 'memory',
    get: async (key: string) => cacheStore.get(key),
    set: async (key: string, value: unknown) => { cacheStore.set(key, value); },
    del: async (key: string) => { cacheStore.delete(key); },
  }),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: {
    getQuotaLimitsForTenant: () => ({
      quotas: {},
      rateLimit: {
        requests: { perSecond: 5, perMinute: 100, perHour: 1000 },
        tokens: { perMinute: 10_000 },
      },
    }),
  },
}));

import { getDatabase } from '@/lib/database';
import type { ITenant } from '@/lib/database';
import { checkRateLimit } from '@/lib/quota/quotaGuard';
import type { QuotaContext } from '@/lib/quota/quotaGuard';

const CTX = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  licenseType: 'PROFESSIONAL',
  domain: 'llm',
  userId: 'user-1',
} as QuotaContext;

describe('checkRateLimit batching', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    config.rateLimit.provider = 'mongodb';
    db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: 'tenant-1' } as unknown as ITenant);
    db.listQuotaPolicies.mockResolvedValue([]);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('issues one batch instead of a call per window', async () => {
    db.incrementRateLimits.mockImplementation(
      async (entries: Array<{ amount: number }>) =>
        entries.map(() => ({ count: 1, resetAt: new Date() })),
    );

    const result = await checkRateLimit(CTX, { requests: 1, tokens: 42 });

    expect(result.allowed).toBe(true);
    expect(db.incrementRateLimits).toHaveBeenCalledTimes(1);
    // Three request windows carry a limit, plus one token window.
    expect(db.incrementRateLimits.mock.calls[0][0]).toHaveLength(4);
  });

  it('skips windows with no configured limit and zero-cost metrics', async () => {
    db.incrementRateLimits.mockImplementation(
      async (entries: Array<unknown>) => entries.map(() => ({ count: 1, resetAt: new Date() })),
    );

    await checkRateLimit(CTX, { requests: 1, tokens: 0 });

    const entries = db.incrementRateLimits.mock.calls[0][0] as Array<{ key: string }>;
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.key.includes(':requests:'))).toBe(true);
  });

  it('rejects when any window is over its limit', async () => {
    db.incrementRateLimits.mockImplementation(
      async (entries: Array<{ key: string }>) =>
        entries.map((entry) => ({
          count: entry.key.includes('perSecond') ? 6 : 1,
          resetAt: new Date(),
        })),
    );

    const result = await checkRateLimit(CTX, { requests: 1 });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/requests perSecond \(6\/5\)/);
  });

  it('fails closed when the batch itself fails', async () => {
    db.incrementRateLimits.mockRejectedValue(new Error('pool exhausted'));

    const result = await checkRateLimit(CTX, { requests: 1 });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('Rate limit enforcement unavailable');
  });

  it('does no work at all when no window applies', async () => {
    await checkRateLimit(CTX, { vectors: 0, files: 0 });
    expect(db.incrementRateLimits).not.toHaveBeenCalled();
  });

  it('routes to the cache provider when one is configured', async () => {
    config.rateLimit.provider = 'memory';
    const result = await checkRateLimit(CTX, { requests: 1 });

    // The mocked cache has no incrementCounters, so the batch throws and the
    // guard fails closed — proving it never reached the database path.
    expect(db.incrementRateLimits).not.toHaveBeenCalled();
    expect(result.allowed).toBe(false);
  });
});
