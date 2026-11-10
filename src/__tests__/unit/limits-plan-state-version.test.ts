/**
 * The shared plan-state version: invalidating a tenant's license state bumps it in the shared cache, so other replicas
 * see it change; it reads '0' when never bumped, undefined when the cache cannot be read, and is per tenant.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  ttls: new Map<string, number | undefined>(),
  broken: false,
}));

vi.mock('@/lib/core/cache', () => ({
  getCache: async () => {
    if (h.broken) throw new Error('cache down');
    return {
      get: async (key: string) => h.store.get(key),
      set: async (key: string, value: unknown, ttl?: number) => { h.store.set(key, value); h.ttls.set(key, ttl); },
      del: async (key: string) => { h.store.delete(key); },
    };
  },
}));
vi.mock('@/lib/license/enterprise-license-cache', () => ({ invalidateEnterpriseLicenseCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ clearServiceAvailabilityMemo: vi.fn() }));
vi.mock('@/lib/limits/tenantLimits', () => ({ invalidateTenantPlan: vi.fn() }));

import { invalidateTenantLicenseState, planStateVersion } from '@/lib/limits/invalidate';

beforeEach(() => {
  h.store.clear();
  h.ttls.clear();
  h.broken = false;
});

describe('planStateVersion', () => {
  it("reads '0' until the tenant's state is invalidated, then a new value on every invalidation, per tenant", async () => {
    expect(await planStateVersion('t1')).toBe('0');
    await invalidateTenantLicenseState('t1');
    const first = await planStateVersion('t1');
    expect(first).not.toBe('0');
    await invalidateTenantLicenseState('t1');
    const second = await planStateVersion('t1');
    expect(second).not.toBe(first);
    expect(await planStateVersion('t2')).toBe('0');
    // Outlives the 30 s in-process plan cache.
    expect([...h.ttls.values()][0]).toBeGreaterThanOrEqual(30);
  });

  it('reads undefined, and invalidation still completes, when the cache is down', async () => {
    h.broken = true;
    expect(await planStateVersion('t1')).toBeUndefined();
    await expect(invalidateTenantLicenseState('t1')).resolves.toBeUndefined();
  });
});
