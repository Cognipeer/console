/**
 * checkSharedRateLimit: a limit with its own window, counted locally and, with
 * RATE_LIMIT_PROVIDER=redis, across replicas through the shared counter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: { rateLimit: { provider: 'memory', maxTrackedKeys: 1000 } },
  shared: new Map<string, number>(),
  incrementCounter: vi.fn(),
  cacheName: 'redis',
}));

vi.mock('@/lib/core/config', () => ({ getConfig: () => h.config }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({ name: h.cacheName, incrementCounter: h.incrementCounter })),
}));

import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { checkSharedRateLimit, resetSharedCounterState } from '@/lib/services/auth/sharedRateCounter';

const LIMIT = { maxAttempts: 3, windowSeconds: 900 };

beforeEach(() => {
  resetRateLimitStore();
  resetSharedCounterState();
  h.shared.clear();
  h.config.rateLimit.provider = 'memory';
  h.cacheName = 'redis';
  h.incrementCounter.mockReset();
  h.incrementCounter.mockImplementation(async (key: string, ttlSeconds: number) => {
    const count = (h.shared.get(key) ?? 0) + 1;
    h.shared.set(key, count);
    return { count, resetAt: new Date(Date.now() + ttlSeconds * 1000) };
  });
});

describe('checkSharedRateLimit', () => {
  it('is the local limit when no shared counter is configured', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push((await checkSharedRateLimit('k', LIMIT)).allowed);
    expect(results).toEqual([true, true, true, false]);
    expect(h.incrementCounter).not.toHaveBeenCalled();
  });

  it('counts in the shared counter with the limit window, and refuses once the shared count is over', async () => {
    h.config.rateLimit.provider = 'redis';
    // Other replicas already counted two attempts.
    h.shared.set('k', 2);

    expect((await checkSharedRateLimit('k', LIMIT)).allowed).toBe(true);
    expect(h.incrementCounter).toHaveBeenCalledWith('k', LIMIT.windowSeconds, 1);

    const refused = await checkSharedRateLimit('k', LIMIT);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(LIMIT.windowSeconds);
  });

  it('falls back to the local limit while the shared counter cannot be reached', async () => {
    h.config.rateLimit.provider = 'redis';
    h.incrementCounter.mockRejectedValue(new Error('redis down'));
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push((await checkSharedRateLimit('k', LIMIT)).allowed);
    expect(results).toEqual([true, true, true, false]);
  });
});
