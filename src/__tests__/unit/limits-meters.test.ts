import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plan: { tenantId: 't1', mode: 'on', limits: null } as any,
  db: {
    incrementPlanUsageMonthly: vi.fn(async () => undefined),
    getPlanUsageMonthly: vi.fn(async () => ({})),
  },
  events: [] as any[],
}));

vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: unknown, c: unknown) => h.events.push({ d, c }),
  recordLimitEvent: vi.fn(),
}));

import {
  addMonthlyUsage,
  assertMonthlyAllowance,
  checkMonthlyAllowance,
  clearMeterCacheForTests,
  currentPeriod,
  getMonthlyUsage,
  periodEnd,
} from '@/lib/limits/meters';

function setPlan(mode: 'on' | 'shadow' | 'off', monthly: Record<string, number> = {}) {
  h.plan = { tenantId: 't1', mode, limits: { concurrency: {}, monthly, seats: {}, credits: {} } };
}

beforeEach(() => {
  clearMeterCacheForTests();
  h.events.length = 0;
  h.db.incrementPlanUsageMonthly.mockClear();
  h.db.getPlanUsageMonthly.mockReset();
  h.db.getPlanUsageMonthly.mockResolvedValue({});
  setPlan('on', { searches: 10, sandboxHours: 1 });
});
afterEach(() => vi.useRealTimers());

describe('period math', () => {
  it('formats the UTC month', () => {
    expect(currentPeriod(new Date('2030-03-05T10:00:00Z'))).toBe('2030-03');
    expect(currentPeriod(new Date('2030-12-31T23:59:59Z'))).toBe('2030-12');
  });

  it('rolls December into January', () => {
    expect(periodEnd('2030-12').toISOString()).toBe('2031-01-01T00:00:00.000Z');
    expect(periodEnd('2030-01').toISOString()).toBe('2030-02-01T00:00:00.000Z');
  });
});

describe('addMonthlyUsage', () => {
  it('is a no-op when off, and ignores non-positive amounts', async () => {
    setPlan('off');
    await addMonthlyUsage('t1', 'searches', 1);
    setPlan('on');
    await addMonthlyUsage('t1', 'searches', 0);
    expect(h.db.incrementPlanUsageMonthly).not.toHaveBeenCalled();
  });

  it('writes the delta and bumps the read cache', async () => {
    h.db.getPlanUsageMonthly.mockResolvedValue({ searches: 4 });
    await getMonthlyUsage('t1');
    await addMonthlyUsage('t1', 'searches', 3);
    expect(h.db.incrementPlanUsageMonthly).toHaveBeenCalledWith('t1', currentPeriod(), { searches: 3 });
    expect((await getMonthlyUsage('t1')).searches).toBe(7);
    expect(h.db.getPlanUsageMonthly).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    h.db.incrementPlanUsageMonthly.mockRejectedValueOnce(new Error('db'));
    await expect(addMonthlyUsage('t1', 'searches', 1)).resolves.toBeUndefined();
  });
});

describe('getMonthlyUsage', () => {
  it('fills missing meters with 0 and caches for 10 s', async () => {
    vi.useFakeTimers();
    h.db.getPlanUsageMonthly.mockResolvedValue({ flowRuns: 2 });
    expect(await getMonthlyUsage('t1')).toEqual({ searches: 0, flowRuns: 2, crawlerPages: 0, sandboxSeconds: 0 });
    await getMonthlyUsage('t1');
    expect(h.db.getPlanUsageMonthly).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11_000);
    await getMonthlyUsage('t1');
    expect(h.db.getPlanUsageMonthly).toHaveBeenCalledTimes(2);
  });
});

describe('checkMonthlyAllowance', () => {
  it('allows below the limit and refuses past it in on mode with reset info', async () => {
    h.db.getPlanUsageMonthly.mockResolvedValue({ searches: 9 });
    expect((await checkMonthlyAllowance({ tenantId: 't1', meter: 'searches' })).allowed).toBe(true);
    clearMeterCacheForTests();
    h.db.getPlanUsageMonthly.mockResolvedValue({ searches: 10 });
    const d = await checkMonthlyAllowance({ tenantId: 't1', meter: 'searches' });
    expect(d).toMatchObject({ allowed: false, outcome: 'refused', kind: 'monthly', dimension: 'searches', limit: 10, used: 10 });
    expect(d.resetAt).toEqual(periodEnd(currentPeriod()));
    expect(d.retryAfterMs).toBeGreaterThan(0);
    expect(h.events).toHaveLength(1);
  });

  it('shadow mode reports would_refuse and allows', async () => {
    setPlan('shadow', { searches: 1 });
    h.db.getPlanUsageMonthly.mockResolvedValue({ searches: 1 });
    const d = await checkMonthlyAllowance({ tenantId: 't1', meter: 'searches' });
    expect(d).toMatchObject({ allowed: true, outcome: 'would_refuse' });
  });

  it('compares sandbox seconds against hours', async () => {
    h.db.getPlanUsageMonthly.mockResolvedValue({ sandboxSeconds: 3500 });
    const ok = await checkMonthlyAllowance({ tenantId: 't1', meter: 'sandboxSeconds', amount: 100 });
    expect(ok.allowed).toBe(true);
    expect(ok.limit).toBe(3600);
    const over = await checkMonthlyAllowance({ tenantId: 't1', meter: 'sandboxSeconds', amount: 101 });
    expect(over.allowed).toBe(false);
  });

  it('allows when the meter has no limit, when off, or when the counter cannot be read', async () => {
    expect((await checkMonthlyAllowance({ tenantId: 't1', meter: 'flowRuns' })).allowed).toBe(true);
    setPlan('off', { searches: 0 });
    expect((await checkMonthlyAllowance({ tenantId: 't1', meter: 'searches' })).allowed).toBe(true);
    setPlan('on', { searches: 0 });
    h.db.getPlanUsageMonthly.mockRejectedValue(new Error('db'));
    expect((await checkMonthlyAllowance({ tenantId: 't1', meter: 'searches' })).allowed).toBe(true);
  });

  it('assertMonthlyAllowance throws monthly_allowance_exhausted', async () => {
    h.db.getPlanUsageMonthly.mockResolvedValue({ searches: 10 });
    const err = await assertMonthlyAllowance({ tenantId: 't1', meter: 'searches' }).catch((e) => e);
    expect(err.code).toBe('monthly_allowance_exhausted');
    expect(err.dimension).toBe('searches');
    expect(err.status).toBe(429);
  });
});
