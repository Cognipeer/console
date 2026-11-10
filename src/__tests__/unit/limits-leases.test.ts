import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plan: { tenantId: 't1', mode: 'on', limits: { concurrency: { agent: 2 }, monthly: {}, seats: {}, credits: {} } } as any,
  events: [] as any[],
  recorded: [] as any[],
}));

vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/core/cache', () => ({ getCache: async () => ({ name: 'memory' }) }));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: { outcome: string }, c: unknown) => {
    if (d.outcome !== 'allowed') h.events.push({ d, c });
  },
  recordLimitEvent: (e: unknown) => h.recorded.push(e),
}));
vi.mock('@/lib/limits/peaks', () => ({ notePeak: vi.fn() }));

import {
  clearLocalStoreForTests,
  localLeaseAcquire,
  localLeaseCount,
  localLeaseRelease,
  localLeaseRenew,
} from '@/lib/limits/localStore';
import {
  acquirePlanLease,
  clearLeaseStateForTests,
  countPlanLeases,
  heldLeaseCount,
  runLeaseKeeperForTests,
  waitForPlanLease,
} from '@/lib/limits/leases';

function setPlan(mode: 'on' | 'shadow' | 'off', agent?: number) {
  h.plan = {
    tenantId: 't1',
    mode,
    limits: { concurrency: agent === undefined ? {} : { agent }, monthly: {}, seats: {}, credits: {} },
  };
}

beforeEach(() => {
  clearLocalStoreForTests();
  clearLeaseStateForTests();
  h.events.length = 0;
  h.recorded.length = 0;
  setPlan('on', 2);
});
afterEach(() => {
  clearLeaseStateForTests();
  vi.useRealTimers();
});

describe('local lease store', () => {
  it('limits, renews, expires and releases', () => {
    expect(localLeaseAcquire('k', 'a', 2, 1000, 0)).toEqual({ acquired: true, count: 1 });
    expect(localLeaseAcquire('k', 'b', 2, 1000, 0)).toEqual({ acquired: true, count: 2 });
    expect(localLeaseAcquire('k', 'c', 2, 1000, 0)).toEqual({ acquired: false, count: 2 });
    // existing member renews and counts as acquired even at the limit
    expect(localLeaseAcquire('k', 'a', 2, 1000, 500)).toEqual({ acquired: true, count: 2 });
    expect(localLeaseRenew('k', 'b', 1000, 900)).toBe(true);
    // a expires at 1500, b at 1900
    expect(localLeaseCount('k', 1600)).toBe(1);
    expect(localLeaseRenew('k', 'a', 1000, 1600)).toBe(false);
    localLeaseRelease('k', 'b');
    expect(localLeaseCount('k', 1600)).toBe(0);
  });

  it('null limit always adds', () => {
    for (let i = 0; i < 5; i++) expect(localLeaseAcquire('k', `m${i}`, null, 1000, 0).acquired).toBe(true);
    expect(localLeaseCount('k', 0)).toBe(5);
  });
});

describe('acquirePlanLease', () => {
  it('returns no lease when off', async () => {
    setPlan('off', 1);
    const r = await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'h1' });
    expect(r.lease).toBeNull();
    expect(r.decision.allowed).toBe(true);
  });

  it('enforces the limit in on mode and records the refusal', async () => {
    const a = await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'a' });
    const b = await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'b' });
    const c = await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'c' });
    expect(a.lease && b.lease).toBeTruthy();
    expect(c.lease).toBeNull();
    expect(c.decision).toMatchObject({ allowed: false, outcome: 'refused', used: 2, limit: 2, retryAfterMs: 5000 });
    expect(h.events).toHaveLength(1);
    expect(await countPlanLeases('t1', 'agent')).toBe(2);
    await a.lease!.release();
    await a.lease!.release(); // idempotent
    expect(await countPlanLeases('t1', 'agent')).toBe(1);
    expect((await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'c' })).lease).not.toBeNull();
  });

  it('shadow mode admits everyone but reports would_refuse', async () => {
    setPlan('shadow', 1);
    await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'a' });
    const b = await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'b' });
    expect(b.lease).not.toBeNull();
    expect(b.decision).toMatchObject({ allowed: true, outcome: 'would_refuse', used: 2 });
    expect(await countPlanLeases('t1', 'agent')).toBe(2);
  });

  it('counts without limiting when the pool has no limit', async () => {
    setPlan('on', undefined);
    for (let i = 0; i < 4; i++) {
      expect((await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: `h${i}` })).lease).not.toBeNull();
    }
    expect(await countPlanLeases('t1', 'agent')).toBe(4);
  });

  it('limit 0 refuses everything', async () => {
    setPlan('on', 0);
    expect((await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'a' })).lease).toBeNull();
  });
});

describe('keeper', () => {
  it('starts lazily, renews held leases past the TTL and stops when empty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const timers = vi.getTimerCount();
    const r = await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'a' });
    expect(vi.getTimerCount()).toBe(timers + 1);
    expect(heldLeaseCount()).toBe(1);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await runLeaseKeeperForTests();
    }
    // 60 s later, well past the 30 s TTL, the lease is still counted
    expect(await countPlanLeases('t1', 'agent')).toBe(1);
    await r.lease!.release();
    expect(heldLeaseCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(timers);
  });

  it('an unrenewed lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'a' });
    clearLeaseStateForTests(); // stop the keeper, as if the process died
    vi.setSystemTime(new Date('2030-01-01T00:00:31Z'));
    expect(await countPlanLeases('t1', 'agent')).toBe(0);
  });
});

describe('waitForPlanLease', () => {
  it('calls onQueued once and records waited when a slot frees up', async () => {
    const a = await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'a' });
    await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'b' });
    const onQueued = vi.fn();
    setTimeout(() => void a.lease!.release(), 30);
    const r = await waitForPlanLease({
      tenantId: 't1', pool: 'agent', holderId: 'c', maxWaitMs: 2000, pollMs: 10, onQueued,
    });
    expect(r.lease).not.toBeNull();
    expect(onQueued).toHaveBeenCalledTimes(1);
    // retryInMs = how long the wait may still last (maxWaitMs minus the time already spent).
    const info = onQueued.mock.calls[0][0] as { limit: number; active: number; retryInMs: number };
    expect(info).toMatchObject({ limit: 2, active: 2 });
    expect(info.retryInMs).toBeGreaterThan(1900);
    expect(info.retryInMs).toBeLessThanOrEqual(2000);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ outcome: 'waited', kind: 'concurrency', dimension: 'agent' });
    expect(h.recorded[0].waitMs).toBeGreaterThanOrEqual(0);
  });

  it('gives up with a refusal and one refused event', async () => {
    await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'a' });
    await acquirePlanLease({ tenantId: 't1', pool: 'agent', holderId: 'b' });
    h.events.length = 0;
    const r = await waitForPlanLease({ tenantId: 't1', pool: 'agent', holderId: 'c', maxWaitMs: 40, pollMs: 10 });
    expect(r.lease).toBeNull();
    expect(r.decision.outcome).toBe('refused');
    expect(h.events).toHaveLength(1);
    expect(h.recorded).toHaveLength(0);
  });

  it('does not call onQueued when admitted at once', async () => {
    const onQueued = vi.fn();
    const r = await waitForPlanLease({ tenantId: 't1', pool: 'agent', holderId: 'c', maxWaitMs: 100, onQueued });
    expect(r.lease).not.toBeNull();
    expect(onQueued).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(0);
  });
});
