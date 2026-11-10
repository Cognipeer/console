import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plan: { tenantId: 't1', mode: 'on', limits: { apiRpm: 10, concurrency: {}, monthly: {}, seats: {}, credits: {} } } as any,
  cache: { name: 'memory' } as any,
  events: [] as unknown[],
  peaks: [] as unknown[],
}));

vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/core/cache', () => ({ getCache: async () => h.cache }));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: unknown, c: unknown) => h.events.push({ d, c }),
  recordLimitEvent: vi.fn(),
}));
vi.mock('@/lib/limits/peaks', () => ({ notePeak: (...a: unknown[]) => h.peaks.push(a) }));

import { clearLocalStoreForTests, localRateTake } from '@/lib/limits/localStore';
import {
  assertApiRequestRate,
  clearRpmStateForTests,
  enforceApiRequestRate,
  rpmBucketFor,
  rpmCounters,
  rpmKey,
} from '@/lib/limits/rpm';
import { isPlanLimitError } from '@/lib/limits/errors';

const source = { type: 'api_token' as const, id: 'tok' };

function setLimit(mode: 'on' | 'shadow' | 'off', apiRpm?: number) {
  h.plan = { tenantId: 't1', mode, limits: { apiRpm, concurrency: {}, monthly: {}, seats: {}, credits: {} } };
}

beforeEach(() => {
  clearLocalStoreForTests();
  clearRpmStateForTests();
  h.cache = { name: 'memory' };
  h.events.length = 0;
  h.peaks.length = 0;
  setLimit('on', 10);
});
afterEach(() => vi.useRealTimers());

describe('localRateTake (GCRA)', () => {
  it('admits a full burst, then refuses with a retry hint', () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) expect(localRateTake('k', 10, now).allowed).toBe(true);
    const refused = localRateTake('k', 10, now);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(6000);
    expect(refused.remaining).toBe(0);
  });

  it('counts remaining down and recovers over time', () => {
    const now = 5_000_000;
    expect(localRateTake('k', 10, now).remaining).toBe(9);
    expect(localRateTake('k', 10, now).remaining).toBe(8);
    for (let i = 0; i < 8; i++) localRateTake('k', 10, now);
    expect(localRateTake('k', 10, now).allowed).toBe(false);
    // one interval (6 s) later one request fits again
    expect(localRateTake('k', 10, now + 6000).allowed).toBe(true);
    expect(localRateTake('k', 10, now + 6000).allowed).toBe(false);
  });

  it('keeps tenants apart', () => {
    for (let i = 0; i < 10; i++) localRateTake('a', 10, 1);
    expect(localRateTake('a', 10, 1).allowed).toBe(false);
    expect(localRateTake('b', 10, 1).allowed).toBe(true);
  });
});

describe('enforceApiRequestRate', () => {
  it('is a no-op when off or without a limit', async () => {
    setLimit('off', 10);
    expect((await enforceApiRequestRate({ tenantId: 't1', source })).headers).toEqual({});
    setLimit('on', undefined);
    const r = await enforceApiRequestRate({ tenantId: 't1', source });
    expect(r.decision.allowed).toBe(true);
    expect(r.headers).toEqual({});
  });

  it('sets rate headers on success and notes the peak', async () => {
    const r = await enforceApiRequestRate({ tenantId: 't1', source });
    expect(r.decision.outcome).toBe('allowed');
    expect(r.headers['X-RateLimit-Limit']).toBe('10');
    expect(r.headers['X-RateLimit-Remaining']).toBe('9');
    expect(Number(r.headers['X-RateLimit-Reset'])).toBeGreaterThanOrEqual(1);
    expect(h.peaks[0]).toEqual(['t1', 'apiRpm', 1]);
  });

  it('allows exactly the limit then refuses in on mode and records an event', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await enforceApiRequestRate({ tenantId: 't1', source })).decision.allowed).toBe(true);
    }
    const r = await enforceApiRequestRate({ tenantId: 't1', source });
    expect(r.decision.allowed).toBe(false);
    expect(r.decision.outcome).toBe('refused');
    expect(r.decision.used).toBe(10);
    expect(r.decision.retryAfterMs).toBeGreaterThan(0);
    expect(h.events).toHaveLength(1);
  });

  it('shadow mode never refuses but reports would_refuse', async () => {
    setLimit('shadow', 2);
    await enforceApiRequestRate({ tenantId: 't1', source });
    await enforceApiRequestRate({ tenantId: 't1', source });
    const r = await enforceApiRequestRate({ tenantId: 't1', source });
    expect(r.decision.allowed).toBe(true);
    expect(r.decision.outcome).toBe('would_refuse');
    expect(h.events).toHaveLength(1);
  });

  it('assertApiRequestRate throws tenant_rate_limited with the message', async () => {
    setLimit('on', 1);
    await assertApiRequestRate({ tenantId: 't1', source });
    const err = await assertApiRequestRate({ tenantId: 't1', source }).catch((e) => e);
    expect(isPlanLimitError(err)).toBe(true);
    expect(err.code).toBe('tenant_rate_limited');
    expect(err.message).toMatch(/^Tenant API limit reached: 1 requests per minute\. Retry after \d+ seconds\.$/);
  });

  it('uses redis rateTake when available', async () => {
    const rateTake = vi.fn(async () => ({ allowed: true, retryAfterMs: 0, remaining: 4, resetAfterMs: 3000 }));
    h.cache = { name: 'redis', rateTake };
    const r = await enforceApiRequestRate({ tenantId: 't1', source });
    expect(rateTake).toHaveBeenCalledWith('plim:rpm:t1', 10, expect.any(Number));
    expect(r.headers['X-RateLimit-Remaining']).toBe('4');
    expect(r.headers['X-RateLimit-Reset']).toBe('3');
  });

  it('falls back to the local store when redis throws, counting the failure', async () => {
    h.cache = { name: 'redis', rateTake: vi.fn(async () => { throw new Error('boom'); }) };
    const r = await enforceApiRequestRate({ tenantId: 't1', source });
    expect(r.decision.allowed).toBe(true);
    expect(rpmCounters.failOpen).toBe(1);
  });
});

describe('public entry points use their own bucket', () => {
  it('maps public source types to the public bucket and the rest to the API bucket', () => {
    expect(rpmBucketFor({ type: 'webhook' })).toBe('public');
    expect(rpmBucketFor({ type: 'a2a' })).toBe('public');
    expect(rpmBucketFor({ type: 'mcp' })).toBe('public');
    expect(rpmBucketFor({ type: 'channel' })).toBe('public');
    expect(rpmBucketFor({ type: 'api_token' })).toBe('api');
    expect(rpmBucketFor({ type: 'user' })).toBe('api');
    expect(rpmKey('t1')).not.toBe(rpmKey('t1', 'public'));
  });

  it('public traffic that uses up its minute does not refuse authenticated API requests', async () => {
    setLimit('on', 3);
    const publicSource = { type: 'webhook' as const, id: 'hook-1' };
    for (let i = 0; i < 3; i++) {
      expect((await enforceApiRequestRate({ tenantId: 't1', source: publicSource })).decision.allowed).toBe(true);
    }
    expect((await enforceApiRequestRate({ tenantId: 't1', source: publicSource })).decision.allowed).toBe(false);
    // The tenant's own token still has its full minute.
    const api = await enforceApiRequestRate({ tenantId: 't1', source });
    expect(api.decision.allowed).toBe(true);
    expect(api.headers['X-RateLimit-Remaining']).toBe('2');
    // Peaks are kept apart too, so the API capacity row is not inflated by public traffic.
    expect(h.peaks.some((p) => (p as unknown[])[1] === 'publicRpm')).toBe(true);
  });
});
