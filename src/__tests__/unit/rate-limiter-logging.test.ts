/**
 * The in-memory rate limiter logs the first refused attempt of a window at
 * warn; the attempts that follow in the same window are logged at debug, so a
 * burst of refused requests is one warning, not one per request. When its store
 * is full of counters that have not ended and it has to drop some, that is one
 * warning a minute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/core/logger', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/core/logger')>()),
  createLogger: () => log,
}));

const LIMIT = { maxAttempts: 2, windowSeconds: 60 };

type RateLimiter = typeof import('@/lib/services/auth/rateLimiter');
let checkRateLimit: RateLimiter['checkRateLimit'];

beforeEach(async () => {
  // The test setup has already loaded the limiter with the real logger; load it
  // again so it takes the one above.
  vi.resetModules();
  vi.clearAllMocks();
  ({ checkRateLimit } = await import('@/lib/services/auth/rateLimiter'));
});

describe('rate limiter logging', () => {
  it('still refuses every attempt over the limit', () => {
    const results = Array.from({ length: 5 }, () => checkRateLimit('k1', LIMIT).allowed);
    expect(results).toEqual([true, true, false, false, false]);
  });

  it('warns once when a key first goes over its limit, and logs the rest at debug', () => {
    for (let i = 0; i < 5; i += 1) checkRateLimit('k1', LIMIT);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Rate limit exceeded', { key: 'k1', count: 3, maxAttempts: 2 });
    expect(log.debug).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenLastCalledWith('Rate limit exceeded', { key: 'k1', count: 5, maxAttempts: 2 });
  });

  it('names a key longer than the stored bound by its digest, so a log line stays short', () => {
    const long = `login:${'x'.repeat(5_000)}`;
    for (let i = 0; i < 3; i += 1) checkRateLimit(long, LIMIT);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const details = log.warn.mock.calls[0][1] as { key: string };
    expect(details.key).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('xxxxxxxxxx');
  });

  it('warns for each key on its own', () => {
    for (let i = 0; i < 3; i += 1) {
      checkRateLimit('k1', LIMIT);
      checkRateLimit('k2', LIMIT);
    }
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('does not log an attempt that is within the limit', () => {
    checkRateLimit('k1', LIMIT);
    checkRateLimit('k1', LIMIT);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });

  it('warns again in the next window', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i += 1) checkRateLimit('k1', LIMIT);
      expect(log.warn).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 61_000);
      for (let i = 0; i < 3; i += 1) checkRateLimit('k1', LIMIT);
      expect(log.warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rate limiter store bound logging', () => {
  const LONG = { maxAttempts: 2, windowSeconds: 600 };
  let check: RateLimiter['checkRateLimit'];

  beforeEach(async () => {
    process.env.RATE_LIMIT_MAX_TRACKED_KEYS = '5';
    // The typed config is read when the limiter first needs the bound.
    vi.resetModules();
    ({ checkRateLimit: check } = await import('@/lib/services/auth/rateLimiter'));
  });

  afterEach(() => {
    delete process.env.RATE_LIMIT_MAX_TRACKED_KEYS;
    vi.useRealTimers();
  });

  it('warns once when it first has to drop live counters, however many it drops after that', () => {
    for (let i = 0; i < 40; i += 1) check(`k${i}`, LONG);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('store is full'), { maxTrackedKeys: 5 });
  });

  it('warns again after a minute', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    for (let i = 0; i < 20; i += 1) check(`a${i}`, LONG);
    expect(log.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2030-01-01T00:00:30Z'));
    for (let i = 0; i < 20; i += 1) check(`b${i}`, LONG);
    expect(log.warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2030-01-01T00:01:05Z'));
    for (let i = 0; i < 20; i += 1) check(`c${i}`, LONG);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('says nothing while it only drops counters whose window has ended', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    for (let i = 0; i < 5; i += 1) check(`k${i}`, LIMIT);
    vi.setSystemTime(new Date('2030-01-01T00:02:00Z'));
    for (let i = 5; i < 10; i += 1) check(`k${i}`, LIMIT);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reads 0 as unset, not as a bound of zero that would drop every counter', async () => {
    process.env.RATE_LIMIT_MAX_TRACKED_KEYS = '0';
    vi.resetModules();
    const { checkRateLimit: unset } = await import('@/lib/services/auth/rateLimiter');
    for (let i = 0; i < 200; i += 1) unset(`k${i}`, LONG);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
