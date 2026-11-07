/**
 * Unit tests: the usage summary builder (banners thresholds, counterScope, row shapes).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheState = vi.hoisted(() => ({ name: 'memory' }));

vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({ name: cacheState.name, get: vi.fn(async () => undefined) })),
}));
vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: vi.fn() }));
vi.mock('@/lib/limits/events', () => ({ listLimitEvents: vi.fn(async () => []) }));
vi.mock('@/lib/limits/leases', () => ({ countPlanLeases: vi.fn(async () => 0) }));
vi.mock('@/lib/limits/peaks', () => ({ getPeaks24h: vi.fn(async () => ({})) }));
vi.mock('@/lib/limits/seats', () => ({ countSeats: vi.fn(async () => 0) }));
vi.mock('@/lib/limits/storage', () => ({ getStoredBytes: vi.fn(async () => 0) }));
vi.mock('@/lib/limits/meters', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits/meters')>()),
  getMonthlyUsage: vi.fn(async () => ({ searches: 0, flowRuns: 0, crawlerPages: 0, sandboxSeconds: 0 })),
}));
vi.mock('@/enterprise/plan-limits', () => ({ getPlanCreditSummary: vi.fn(async () => null) }));

import { getPlanCreditSummary, type PlanCreditSummary } from '@/enterprise/plan-limits';
import { listLimitEvents } from '@/lib/limits/events';
import { countPlanLeases } from '@/lib/limits/leases';
import { clearLocalStoreForTests, localRateTake } from '@/lib/limits/localStore';
import { getMonthlyUsage } from '@/lib/limits/meters';
import { getPeaks24h } from '@/lib/limits/peaks';
import { rpmKey } from '@/lib/limits/rpm';
import { countSeats } from '@/lib/limits/seats';
import { getStoredBytes } from '@/lib/limits/storage';
import { resolveTenantPlan } from '@/lib/limits/tenantLimits';
import type { PlanLimitEvent, ResolvedTenantPlan, TenantLimits } from '@/lib/limits/types';
import { buildUsageSummary, computeBanners, type BannerInput } from '@/lib/limits/usageSummary';

function limits(overrides: Partial<TenantLimits> = {}): TenantLimits {
  return {
    source: 'license',
    plan: 'team',
    planName: 'Team',
    capacityPacks: 2,
    apiRpm: 120,
    concurrency: { agent: 10, flow: 5, job: 2, browser: 3 },
    monthly: { searches: 1000, flowRuns: 500, crawlerPages: 2000, sandboxHours: 10 },
    storageBytes: 5_000_000_000,
    seats: { console: 5, portal: 20 },
    credits: {},
    expiresAt: new Date('2027-01-31T00:00:00Z'),
    ...overrides,
  };
}

function plan(mode: ResolvedTenantPlan['mode'], value: TenantLimits | null): ResolvedTenantPlan {
  return { tenantId: 't1', mode, limits: value };
}

function credits(overrides: Partial<PlanCreditSummary> = {}): PlanCreditSummary {
  return {
    balance: 500,
    included: { period: '2026-11', granted: 1000, used: 500, endsAt: '2026-12-01T00:00:00.000Z' },
    prepaid: { remaining: 0, lots: 0 },
    ...overrides,
  };
}

const emptyInput = (overrides: Partial<BannerInput> = {}): BannerInput => ({
  monthly: [],
  storage: { usedBytes: 0 },
  credits: null,
  capacityHits: {},
  capacity: [],
  ...overrides,
});

describe('computeBanners', () => {
  it('raises nothing below 80 percent and nothing without a limit', () => {
    expect(
      computeBanners(
        emptyInput({
          monthly: [
            { dimension: 'searches', used: 799, limit: 1000 },
            { dimension: 'flowRuns', used: 999_999 },
          ],
          storage: { usedBytes: 79, limitBytes: 100 },
        }),
      ),
    ).toEqual([]);
  });

  it('warns from 80 percent and goes critical at 100 percent (monthly and storage)', () => {
    const banners = computeBanners(
      emptyInput({
        monthly: [
          { dimension: 'searches', used: 800, limit: 1000 },
          { dimension: 'flowRuns', used: 500, limit: 500 },
        ],
        storage: { usedBytes: 99, limitBytes: 100 },
      }),
    );
    const byId = Object.fromEntries(banners.map((banner) => [banner.id, banner.severity]));
    expect(byId).toEqual({ 'monthly:searches': 'warning', 'monthly:flowRuns': 'critical', storage: 'warning' });
    // most severe first
    expect(banners[0]!.severity).toBe('critical');

    const full = computeBanners(emptyInput({ storage: { usedBytes: 100, limitBytes: 100 } }));
    expect(full).toEqual([{ id: 'storage', severity: 'critical', dimension: 'storage', used: 100, limit: 100 }]);
  });

  it('warns when credits are at or below 5 percent of the included grant and is critical at zero', () => {
    expect(computeBanners(emptyInput({ credits: credits({ balance: 51 }) }))).toEqual([]);
    expect(computeBanners(emptyInput({ credits: credits({ balance: 50 }) }))).toMatchObject([
      { id: 'credits', severity: 'warning' },
    ]);
    expect(computeBanners(emptyInput({ credits: credits({ balance: 0 }) }))).toMatchObject([
      { id: 'credits', severity: 'critical' },
    ]);
    expect(computeBanners(emptyInput({ credits: credits({ balance: -3 }) }))).toMatchObject([
      { id: 'credits', severity: 'critical' },
    ]);
  });

  it('does not warn about credits when nothing was granted and some balance is left', () => {
    const none = credits({ balance: 10, included: { period: '2026-11', granted: 0, used: 0, endsAt: '2026-12-01T00:00:00.000Z' } });
    expect(computeBanners(emptyInput({ credits: none }))).toEqual([]);
  });

  it('warns when a capacity dimension hit its limit at least 3 times in 24 hours', () => {
    const capacity = [{ dimension: 'agent' as const, used: 1, limit: 10 }];
    expect(computeBanners(emptyInput({ capacity, capacityHits: { agent: 2 } }))).toEqual([]);
    expect(computeBanners(emptyInput({ capacity, capacityHits: { agent: 3 } }))).toMatchObject([
      { id: 'capacity:agent', severity: 'warning', dimension: 'agent' },
    ]);
    // a dimension without a limit never warns
    expect(computeBanners(emptyInput({ capacity: [{ dimension: 'agent', used: 1 }], capacityHits: { agent: 9 } }))).toEqual([]);
  });
});

describe('buildUsageSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheState.name = 'memory';
    clearLocalStoreForTests();
    vi.mocked(resolveTenantPlan).mockResolvedValue(plan('on', limits()));
    vi.mocked(listLimitEvents).mockResolvedValue([]);
    vi.mocked(countPlanLeases).mockResolvedValue(0);
    vi.mocked(getPeaks24h).mockResolvedValue({});
    vi.mocked(countSeats).mockResolvedValue(0);
    vi.mocked(getStoredBytes).mockResolvedValue(0);
    vi.mocked(getPlanCreditSummary).mockResolvedValue(null);
    vi.mocked(getMonthlyUsage).mockResolvedValue({ searches: 0, flowRuns: 0, crawlerPages: 0, sandboxSeconds: 0 });
  });

  it('returns null when limits are off for the tenant', async () => {
    vi.mocked(resolveTenantPlan).mockResolvedValue(plan('off', null));
    expect(await buildUsageSummary('t1')).toBeNull();
  });

  it('describes the plan, seats, capacity rows, monthly rows and storage', async () => {
    vi.mocked(countSeats).mockImplementation(async (_tenant, kind) => (kind === 'console' ? 3 : 7));
    vi.mocked(countPlanLeases).mockImplementation(async (_tenant, pool) => (pool === 'agent' ? 4 : 0));
    vi.mocked(getPeaks24h).mockResolvedValue({ agent: 9, apiRpm: 60 });
    vi.mocked(getStoredBytes).mockResolvedValue(1_000_000_000);
    vi.mocked(getMonthlyUsage).mockResolvedValue({ searches: 10, flowRuns: 20, crawlerPages: 30, sandboxSeconds: 5400 });

    const summary = (await buildUsageSummary('t1'))!;
    expect(summary.mode).toBe('on');
    expect(summary.plan).toEqual({
      id: 'team',
      name: 'Team',
      source: 'license',
      capacityPacks: 2,
      expiresAt: '2027-01-31T00:00:00.000Z',
      seats: { console: { used: 3, limit: 5 }, portal: { used: 7, limit: 20 } },
    });
    expect(summary.capacity.map((row) => row.dimension)).toEqual(['apiRpm', 'agent', 'flow', 'job', 'browser', 'realtime', 'sandbox']);
    expect(summary.capacity.find((row) => row.dimension === 'agent')).toEqual({ dimension: 'agent', used: 4, limit: 10, peak24h: 9 });
    // no limit for realtime: the row carries no limit key
    expect(summary.capacity.find((row) => row.dimension === 'realtime')).toEqual({ dimension: 'realtime', used: 0 });
    expect(summary.monthly).toEqual([
      { dimension: 'searches', used: 10, limit: 1000 },
      { dimension: 'flowRuns', used: 20, limit: 500 },
      { dimension: 'crawlerPages', used: 30, limit: 2000 },
      { dimension: 'sandboxHours', used: 1.5, limit: 10 },
    ]);
    expect(summary.storage).toEqual({ usedBytes: 1_000_000_000, limitBytes: 5_000_000_000 });
    expect(summary.period).toMatch(/^\d{4}-\d{2}$/);
    expect(new Date(summary.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(summary.credits).toBeNull();
    expect(summary.banners).toEqual([]);
  });

  it('reports the current minute for apiRpm from the bucket state without taking a request', async () => {
    for (let i = 0; i < 30; i += 1) localRateTake(rpmKey('t1'), 120);
    const summary = (await buildUsageSummary('t1'))!;
    const rpm = summary.capacity.find((row) => row.dimension === 'apiRpm')!;
    expect(rpm.limit).toBe(120);
    expect(rpm.used).toBeGreaterThanOrEqual(29);
    expect(rpm.used).toBeLessThanOrEqual(30);
    // reading twice does not advance the bucket
    const again = (await buildUsageSummary('t1'))!;
    expect(again.capacity.find((row) => row.dimension === 'apiRpm')!.used).toBeLessThanOrEqual(30);
  });

  it('answers counterScope cluster on redis and pod otherwise', async () => {
    expect((await buildUsageSummary('t1'))!.counterScope).toBe('pod');
    cacheState.name = 'redis';
    expect((await buildUsageSummary('t1'))!.counterScope).toBe('cluster');
  });

  it('has a null plan but still reports usage when no plan applies', async () => {
    vi.mocked(resolveTenantPlan).mockResolvedValue(plan('shadow', null));
    vi.mocked(getMonthlyUsage).mockResolvedValue({ searches: 4, flowRuns: 0, crawlerPages: 0, sandboxSeconds: 0 });
    const summary = (await buildUsageSummary('t1'))!;
    expect(summary.mode).toBe('shadow');
    expect(summary.plan).toBeNull();
    expect(summary.monthly[0]).toEqual({ dimension: 'searches', used: 4 });
    expect(summary.banners).toEqual([]);
  });

  it('carries the credit summary and its banner', async () => {
    vi.mocked(getPlanCreditSummary).mockResolvedValue(credits({ balance: 0 }));
    const summary = (await buildUsageSummary('t1'))!;
    expect(summary.credits?.balance).toBe(0);
    expect(summary.banners).toMatchObject([{ id: 'credits', severity: 'critical' }]);
  });

  it('turns repeated limit events of the last 24 hours into a capacity warning, folding sampled counts', async () => {
    const event = (overrides: Partial<PlanLimitEvent>): PlanLimitEvent => ({
      tenantId: 't1',
      kind: 'concurrency',
      dimension: 'agent',
      outcome: 'would_refuse',
      mode: 'shadow',
      count: 1,
      at: new Date(),
      ...overrides,
    });
    vi.mocked(listLimitEvents).mockResolvedValue([
      event({ count: 2 }),
      event({ outcome: 'refused', count: 1 }),
      event({ outcome: 'waited' }),
      event({ kind: 'api_rpm', dimension: 'apiRpm', count: 1 }),
    ]);
    const summary = (await buildUsageSummary('t1'))!;
    expect(summary.banners).toMatchObject([{ id: 'capacity:agent', severity: 'warning' }]);
  });

  it('survives a failing source and still answers', async () => {
    vi.mocked(getStoredBytes).mockRejectedValue(new Error('db down'));
    vi.mocked(countSeats).mockRejectedValue(new Error('db down'));
    const summary = (await buildUsageSummary('t1'))!;
    expect(summary.storage.usedBytes).toBe(0);
    expect(summary.plan?.seats.console.used).toBe(0);
  });
});
