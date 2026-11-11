/**
 * Crawler pages against the plan's monthly allowance: every processed page is counted, a running crawl stops once the
 * allowance is used up (enforcing mode only), and a new run is refused with `monthly_allowance_exhausted`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pages: 0,
  plan: { tenantId: 'tenant-1', mode: 'on', limits: null } as any,
  usage: { searches: 0, flowRuns: 0, crawlerPages: 0, sandboxSeconds: 0 },
  db: {
    incrementPlanUsageMonthly: vi.fn(async (_t?: string, _p?: string, _d?: Record<string, number>) => undefined),
    getPlanUsageMonthly: vi.fn(async () => ({}) as Record<string, number>),
  },
  events: [] as any[],
}));

vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: unknown, c: unknown) => h.events.push({ d, c }),
  recordLimitEvent: vi.fn(),
}));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('@/lib/services/crawler/crawlerWebhook', () => ({ sendCrawlerWebhook: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/crawler/crawlerRagBridge', () => ({ ingestCrawlPage: vi.fn() }));
vi.mock('@/lib/services/crawler/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawler/engine')>()),
  crawl: async function* (_plan: unknown, options: { signal?: AbortSignal }) {
    for (let i = 0; i < h.pages; i++) {
      if (options?.signal?.aborted) return;
      yield { url: `https://example.com/p${i}`, depth: 0, type: 'html' as const, httpStatus: 200, body: `# ${i}`, fetchedAt: new Date() };
    }
  },
}));

import { createMockDb } from '../helpers/db.mock';
import { getDatabase } from '@/lib/database';
import { runCrawlJobLocal } from '@/lib/services/crawler/crawlerJobService';
import { assertMonthlyAllowance, clearMeterCacheForTests } from '@/lib/limits/meters';

const ctx = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' };

function setPlan(mode: 'on' | 'off', crawlerPages?: number) {
  h.plan = {
    tenantId: 'tenant-1',
    mode,
    limits: { concurrency: {}, monthly: crawlerPages === undefined ? {} : { crawlerPages }, seats: {}, credits: {} },
  };
}

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  clearMeterCacheForTests();
  h.events.length = 0;
  h.pages = 6;
  h.db.incrementPlanUsageMonthly.mockReset();
  h.db.incrementPlanUsageMonthly.mockResolvedValue(undefined);
  h.db.getPlanUsageMonthly.mockReset();
  h.db.getPlanUsageMonthly.mockResolvedValue({});
  db = createMockDb();
  Object.assign(db, h.db);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.claimCrawlJob.mockResolvedValue(({
    _id: 'job-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    crawlerKey: 'docs',
    trigger: 'schedule',
    planSnapshot: { seeds: ['https://example.com/'], engine: 'axios', http: { maxConcurrency: 1 } } as never,
  }) as never);
  db.updateCrawlJob.mockResolvedValue(null);
  db.createCrawlResult.mockResolvedValue({} as never);
  db.finalizeCrawlJob.mockResolvedValue({} as never);
});

describe('crawl job runner and the monthly crawler-page allowance', () => {
  it('counts every processed page and stops the crawl when the allowance is used up (on)', async () => {
    setPlan('on', 3);
    // The stored counter follows the increments, like the real one.
    let stored = 0;
    h.db.incrementPlanUsageMonthly.mockImplementation(async (_t?: string, _p?: string, delta: Record<string, number> = {}) => {
      stored += delta.crawlerPages ?? 0;
    });
    h.db.getPlanUsageMonthly.mockImplementation(async () => ({ crawlerPages: stored }));

    await runCrawlJobLocal(ctx as never, 'job-1');

    expect(stored).toBe(3);
    expect(db.finalizeCrawlJob).toHaveBeenCalledWith('job-1', 'tenant-1', expect.objectContaining({ pagesProcessed: 3 }));
    expect(h.events.length).toBeGreaterThan(0);
  });

  it('touches nothing when limits are off', async () => {
    setPlan('off', 3);
    await runCrawlJobLocal(ctx as never, 'job-1');
    expect(h.db.incrementPlanUsageMonthly).not.toHaveBeenCalled();
    expect(h.db.getPlanUsageMonthly).not.toHaveBeenCalled();
    expect(db.finalizeCrawlJob).toHaveBeenCalledWith('job-1', 'tenant-1', expect.objectContaining({ pagesProcessed: 6 }));
  });
});

describe('starting a crawl against the allowance', () => {
  it('refuses with monthly_allowance_exhausted (402) when used up in on mode', async () => {
    setPlan('on', 10);
    h.db.getPlanUsageMonthly.mockResolvedValue({ crawlerPages: 10 });
    await expect(assertMonthlyAllowance({ tenantId: 'tenant-1', meter: 'crawlerPages' })).rejects.toMatchObject({
      code: 'monthly_allowance_exhausted',
      status: 402,
    });
  });

  it('allows when off or when there is no limit', async () => {
    setPlan('off', 10);
    h.db.getPlanUsageMonthly.mockResolvedValue({ crawlerPages: 99 });
    await expect(assertMonthlyAllowance({ tenantId: 'tenant-1', meter: 'crawlerPages' })).resolves.toBeUndefined();
    setPlan('on');
    await expect(assertMonthlyAllowance({ tenantId: 'tenant-1', meter: 'crawlerPages' })).resolves.toBeUndefined();
  });
});
