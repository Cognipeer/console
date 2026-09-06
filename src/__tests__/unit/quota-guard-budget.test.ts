/**
 * Regression tests for F-04 (finance-institution assessment, 2026-09-05):
 * `checkBudget`'s counter used to round every cost to whole cents — a
 * $0.004 call rounded to 0, so 1,000 real $0.004 charges ($4 of actual
 * spend) left the counter at $0 — and a counter-lookup exception was only
 * logged, never denied, so a Redis/DB blip silently disabled a tenant's own
 * configured hard cap (fail-open).
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
import { checkBudget } from '@/lib/quota/quotaGuard';
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
    licenseType: 'enterprise',
    domain: 'llm',
    ...overrides,
  } as QuotaContext;
}

function budgetPolicy(dailySpendLimit: number): IQuotaPolicy {
  return {
    _id: 'p-budget',
    tenantId: TENANT_ID,
    domain: 'llm',
    scope: 'tenant',
    priority: 10,
    enabled: true,
    limits: { budget: { dailySpendLimit, monthlySpendLimit: -1 } },
  } as unknown as IQuotaPolicy;
}

describe('checkBudget — micro-dollar precision + fail-closed on counter error', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: TENANT_ID, slug: 'acme' } as unknown as ITenant);
    db.listQuotaPolicies.mockResolvedValue([budgetPolicy(10)]); // $10/day cap
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('does not round a sub-cent cost away to zero', async () => {
    let counter = 0;
    db.incrementRateLimit.mockImplementation(async (_key, _windowSeconds, amount) => {
      counter += amount;
      return { count: counter, resetAt: new Date() };
    });

    // 1,000 calls at $0.004 each == $4 of real spend. Whole-cent rounding
    // used to turn every single one of these into a 0-cent increment.
    for (let i = 0; i < 1000; i += 1) {
      await checkBudget(makeContext(), { usd: 0.004 });
    }

    // 1,000 * $0.004 = $4 = 4,000,000 micros.
    expect(counter).toBe(4_000_000);
  });

  it('denies the request when the counter lookup fails and a hard cap IS configured (fail closed)', async () => {
    db.incrementRateLimit.mockRejectedValue(new Error('cache unavailable'));

    const result = await checkBudget(makeContext(), { usd: 1 });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/failing closed/i);
  });

  it('does not fail closed when the tenant has no budget limit configured', async () => {
    db.listQuotaPolicies.mockResolvedValue([]); // no budget policy at all
    db.incrementRateLimit.mockRejectedValue(new Error('cache unavailable'));

    const result = await checkBudget(makeContext(), { usd: 1 });

    // checkWindow's early-return for an unconfigured limit means the failing
    // counter is never even touched — a tenant who never opted into a hard
    // cap must not get a new failure mode from this fix.
    expect(result.allowed).toBe(true);
    expect(db.incrementRateLimit).not.toHaveBeenCalled();
  });

  it('rejects once the atomic increment itself pushes the window over the configured cap', async () => {
    db.incrementRateLimit.mockImplementation(async (_key, _windowSeconds, amount) => {
      // Peek (amount 0) reports just under the $10 cap; the real increment
      // (amount > 0) is what actually tips it over.
      if (amount === 0) return { count: 9_990_000, resetAt: new Date() };
      return { count: 9_990_000 + amount, resetAt: new Date() };
    });

    const result = await checkBudget(makeContext(), { usd: 0.02 }); // 20,000 micros

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/budget exceeded/i);
  });
});
