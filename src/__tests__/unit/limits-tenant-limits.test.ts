import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  active: true,
  findTenantById: vi.fn(),
  defaultClaim: null as unknown,
  restrictedClaim: null as unknown,
  effective: vi.fn(),
  invalidateEnterprise: vi.fn(async () => undefined),
  clearMemo: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: async () => ({ findTenantById: h.findTenantById }),
}));
vi.mock('@/enterprise/plan-limits', () => ({
  getDefaultPlanClaim: () => h.defaultClaim,
  getRestrictedPlanClaim: () => h.restrictedClaim,
}));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: { getEffectiveLicenseForTenant: (t: unknown) => h.effective(t) },
}));
vi.mock('@/lib/limits/mode', () => ({
  planLimitsActive: () => h.active,
  effectivePlanLimitsMode: (e?: 'shadow' | 'on') => (h.active ? e ?? 'shadow' : 'off'),
}));
vi.mock('@/lib/license/enterprise-license-cache', () => ({
  invalidateEnterpriseLicenseCache: h.invalidateEnterprise,
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  clearServiceAvailabilityMemo: h.clearMemo,
}));

import {
  clearTenantPlanCacheForTests,
  invalidateTenantPlan,
  limitsFromPlanClaim,
  resolveTenantPlan,
} from '@/lib/limits/tenantLimits';
import { invalidateTenantLicenseState } from '@/lib/limits/invalidate';

const claim = {
  id: 'test-plan',
  name: 'Test',
  capacityPacks: 2,
  enforcement: 'on' as const,
  seats: { console: 5, portal: 20 },
  limits: {
    apiRequestsPerMinute: 120,
    concurrent: { agentSessions: 3, flows: 4, jobs: 2, crawlers: 3, browserSessions: 1, realtimeSessions: 6, sandboxes: 0 },
    monthly: { searches: 100, flowRuns: 50, crawlerPages: 500, sandboxHours: 2 },
    storageGb: 1.5,
    realtimeMaxSessionMinutes: 30,
    sandboxMaxSize: { cpu: 2, memoryMb: 1024 },
  },
  credits: { includedPerMonth: 1000 },
};

beforeEach(() => {
  h.active = true;
  h.defaultClaim = null;
  h.restrictedClaim = null;
  h.findTenantById.mockReset();
  h.effective.mockReset();
  clearTenantPlanCacheForTests();
});
afterEach(() => vi.clearAllMocks());

describe('limitsFromPlanClaim', () => {
  it('maps every field', () => {
    const exp = new Date('2030-01-01T00:00:00Z');
    const l = limitsFromPlanClaim(claim, 'license', exp);
    expect(l).toMatchObject({
      source: 'license',
      plan: 'test-plan',
      planName: 'Test',
      capacityPacks: 2,
      apiRpm: 120,
      concurrency: { agent: 3, flow: 4, job: 2, crawler: 3, browser: 1, realtime: 6, sandbox: 0 },
      monthly: { flowRuns: 50, crawlerPages: 500, sandboxHours: 2 },
      storageBytes: 1_500_000_000,
      seats: { console: 5, portal: 20 },
      sandboxMaxSize: { cpu: 2, memoryMb: 1024 },
      realtimeMaxSessionMinutes: 30,
      credits: { includedPerMonth: 1000 },
      expiresAt: exp,
    });
  });

  it('ignores an older claim\'s monthly searches: web search is paid with credits', () => {
    const l = limitsFromPlanClaim(claim, 'license');
    expect(l.monthly).toEqual({ flowRuns: 50, crawlerPages: 500, sandboxHours: 2 });
    expect('searches' in l.monthly).toBe(false);
  });

  it('leaves absent limits undefined', () => {
    const l = limitsFromPlanClaim({ id: 'x' }, 'default');
    expect(l.apiRpm).toBeUndefined();
    expect(l.concurrency).toEqual({});
    expect(l.concurrency.crawler).toBeUndefined();
    expect(l.storageBytes).toBeUndefined();
    expect(l.source).toBe('default');
  });
});

describe('resolveTenantPlan', () => {
  it('is off without touching the database when inactive', async () => {
    h.active = false;
    const r = await resolveTenantPlan('t1');
    expect(r).toEqual({ tenantId: 't1', mode: 'off', limits: null });
    expect(h.findTenantById).not.toHaveBeenCalled();
  });

  it('uses the license plan and its enforcement', async () => {
    h.findTenantById.mockResolvedValue({ _id: 't1' });
    h.effective.mockReturnValue({ plan: claim, expiresAt: new Date('2030-01-01') });
    const r = await resolveTenantPlan('t1');
    expect(r.mode).toBe('on');
    expect(r.limits?.source).toBe('license');
    expect(r.limits?.apiRpm).toBe(120);
  });

  it('falls back to the default plan, and to no limits without one', async () => {
    h.findTenantById.mockResolvedValue({ _id: 't1' });
    h.effective.mockReturnValue({});
    h.defaultClaim = { id: 'dflt', limits: { apiRequestsPerMinute: 9 } };
    expect((await resolveTenantPlan('t1')).limits?.source).toBe('default');
    clearTenantPlanCacheForTests();
    h.defaultClaim = null;
    const none = await resolveTenantPlan('t1');
    expect(none.limits).toBeNull();
    expect(none.mode).toBe('shadow');
  });

  it('puts a lapsed stored license on the restricted plan, and no license on the default plan', async () => {
    h.defaultClaim = { id: 'community' };
    h.restrictedClaim = { id: 'restricted' };
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
      ['expired', { licenseId: 'L1', licensePayload: {}, licenseStatus: 'active' }, { status: 'expired', licenseType: 'FREE' }, 'restricted'],
      ['invalid', { licenseId: 'L1', licenseStatus: 'invalid' }, { status: 'free', licenseType: 'FREE' }, 'restricted'],
      ['paid without a plan', { licenseId: 'L1', licensePayload: {}, licenseStatus: 'active' }, { status: 'active', licenseType: 'PRO' }, 'restricted'],
      ['active free', { licenseId: 'L1', licensePayload: {}, licenseStatus: 'active' }, { status: 'active', licenseType: 'FREE' }, 'community'],
      ['no license', { licenseId: 'FREE', licenseStatus: 'free' }, { status: 'free', licenseType: 'FREE' }, 'community'],
    ];
    for (const [name, tenant, license, plan] of cases) {
      clearTenantPlanCacheForTests();
      h.findTenantById.mockResolvedValue({ _id: 't1', ...tenant });
      h.effective.mockReturnValue(license);
      expect((await resolveTenantPlan('t1')).limits?.plan, name).toBe(plan);
    }
    // A plan claim still wins.
    clearTenantPlanCacheForTests();
    h.effective.mockReturnValue({ status: 'active', licenseType: 'PRO', plan: claim });
    expect((await resolveTenantPlan('t1')).limits?.plan).toBe('test-plan');
  });

  it('keeps the default plan for a lapsed license when no restricted plan is registered (community edition)', async () => {
    h.findTenantById.mockResolvedValue({ _id: 't1', licenseId: 'L1', licensePayload: {} });
    h.effective.mockReturnValue({ status: 'expired', licenseType: 'FREE' });
    expect((await resolveTenantPlan('t1')).limits).toBeNull();
    clearTenantPlanCacheForTests();
    h.defaultClaim = { id: 'dflt' };
    expect((await resolveTenantPlan('t1')).limits?.plan).toBe('dflt');
  });

  it('caches, and invalidate forces a reload', async () => {
    h.findTenantById.mockResolvedValue({ _id: 't1' });
    h.effective.mockReturnValue({ plan: claim });
    await resolveTenantPlan('t1');
    await resolveTenantPlan('t1');
    expect(h.findTenantById).toHaveBeenCalledTimes(1);
    invalidateTenantPlan('t1');
    await resolveTenantPlan('t1');
    expect(h.findTenantById).toHaveBeenCalledTimes(2);
  });

  it('expires the cache after 30 s', async () => {
    vi.useFakeTimers();
    try {
      h.findTenantById.mockResolvedValue({ _id: 't1' });
      h.effective.mockReturnValue({ plan: claim });
      await resolveTenantPlan('t1');
      vi.advanceTimersByTime(31_000);
      await resolveTenantPlan('t1');
      expect(h.findTenantById).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails open when the tenant cannot be loaded', async () => {
    h.findTenantById.mockRejectedValue(new Error('db down'));
    const r = await resolveTenantPlan('t1');
    expect(r.limits).toBeNull();
    expect(r.mode).toBe('shadow');
    h.findTenantById.mockResolvedValue(null);
    clearTenantPlanCacheForTests();
    expect((await resolveTenantPlan('t1')).limits).toBeNull();
  });
});

describe('invalidateTenantLicenseState', () => {
  it('clears every derived cache', async () => {
    h.findTenantById.mockResolvedValue({ _id: 't1' });
    h.effective.mockReturnValue({ plan: claim });
    await resolveTenantPlan('t1');
    await invalidateTenantLicenseState('t1');
    expect(h.invalidateEnterprise).toHaveBeenCalledWith('t1');
    expect(h.clearMemo).toHaveBeenCalledWith('t1');
    await resolveTenantPlan('t1');
    expect(h.findTenantById).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the license cache fails', async () => {
    h.invalidateEnterprise.mockRejectedValueOnce(new Error('cache down'));
    await expect(invalidateTenantLicenseState('t1')).resolves.toBeUndefined();
    expect(h.clearMemo).toHaveBeenCalled();
  });
});
