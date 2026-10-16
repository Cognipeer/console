/**
 * The in-process rate limiter keeps at most RATE_LIMIT_MAX_TRACKED_KEYS
 * counters. When the store is full, counters whose window has ended go first;
 * if it is still full, the ones counted least recently, so a key that is
 * counted all the time keeps its count however many one-off keys arrive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { checkRateLimit, resetRateLimitStore } from '@/lib/services/auth/rateLimiter';

const originalSource = getConfigSource();

function setTestConfig(values: Record<string, string | undefined> = {}) {
  const source: ConfigSource = { name: 'test', get: (key) => values[key] };
  setConfigSource(source);
}

const ONCE = { maxAttempts: 1, windowSeconds: 60 };

/** True while the key still has its counter: a second request in the window is refused. */
function isTracked(key: string, config = ONCE): boolean {
  return !checkRateLimit(key, config).allowed;
}

beforeEach(() => {
  resetRateLimitStore();
});

afterEach(() => {
  vi.useRealTimers();
  setConfigSource(originalSource);
});

describe('rate limiter store bound', () => {
  it('keeps the counters of the most recent keys once the store is full', () => {
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '10' });
    for (let i = 0; i < 1000; i += 1) {
      expect(checkRateLimit(`k${i}`, ONCE).allowed).toBe(true);
    }
    // The ten newest are still counted; the one before them was let go.
    for (let i = 999; i >= 990; i -= 1) {
      expect(isTracked(`k${i}`), `k${i}`).toBe(true);
    }
    expect(isTracked('k989')).toBe(false);
  });

  it('never holds more than the bound, however many keys arrive', () => {
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '50' });
    for (let i = 0; i < 5000; i += 1) checkRateLimit(`k${i}`, ONCE);

    // Newest first: the store holds the latest 46 to 50 keys and none of the
    // earlier ones, so the run of counted keys ends there.
    let counted = 0;
    for (let i = 4999; i >= 4800; i -= 1) if (isTracked(`k${i}`)) counted += 1;
    expect(counted).toBeLessThanOrEqual(50);
    expect(counted).toBeGreaterThanOrEqual(45);
  });

  it('drops counters whose window has ended before it drops a live one', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '3' });

    checkRateLimit('long', { maxAttempts: 1, windowSeconds: 600 });
    vi.setSystemTime(new Date('2030-01-01T00:00:01Z'));
    checkRateLimit('short-a', ONCE);
    vi.setSystemTime(new Date('2030-01-01T00:00:02Z'));
    checkRateLimit('short-b', ONCE);

    // The store is full; both short windows have ended.
    vi.setSystemTime(new Date('2030-01-01T00:01:10Z'));
    checkRateLimit('new', ONCE);

    // The oldest key is the one with the long window, and it is still counted.
    expect(isTracked('long', { maxAttempts: 1, windowSeconds: 600 })).toBe(true);
    expect(isTracked('new')).toBe(true);
  });

  it('keeps the keys that are still being counted and lets the idle ones go', () => {
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '3' });
    checkRateLimit('a', ONCE);
    checkRateLimit('b', ONCE);
    checkRateLimit('c', ONCE);

    // a is counted again, so b is now the one that has been idle longest.
    expect(checkRateLimit('a', ONCE).allowed).toBe(false);
    checkRateLimit('d', ONCE);

    expect(isTracked('a')).toBe(true);
    expect(isTracked('c')).toBe(true);
    expect(isTracked('d')).toBe(true);
    expect(isTracked('b')).toBe(false);
  });

  it('keeps counting a key that is hit all the time while many other keys come and go', () => {
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '50' });
    const busy = { maxAttempts: 10_000, windowSeconds: 60 };
    for (let i = 0; i < 3000; i += 1) {
      checkRateLimit('busy', busy);
      checkRateLimit(`once-${i}`, ONCE);
    }
    // All 3,000 hits are in one count, though the store turned over many times.
    expect(checkRateLimit('busy', busy).remaining).toBe(10_000 - 3001);
  });

  it('starts a key over when its window has ended, wherever it was in the store', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '3' });
    const short = { maxAttempts: 1, windowSeconds: 100 };

    checkRateLimit('a', short);
    expect(isTracked('a', short)).toBe(true);
    vi.setSystemTime(new Date('2030-01-01T00:01:41Z'));
    expect(checkRateLimit('a', short).allowed).toBe(true);
    expect(isTracked('a', short)).toBe(true);
  });

  it('keeps adding keys cheaply while the store is full', () => {
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '2000' });
    for (let i = 0; i < 2000; i += 1) checkRateLimit(`warm${i}`, ONCE);
    const start = performance.now();
    for (let i = 0; i < 50_000; i += 1) checkRateLimit(`more${i}`, ONCE);
    // Each pass over a full store frees a tenth of it, so 50,000 new keys take
    // a fraction of a second.
    expect(performance.now() - start).toBeLessThan(1500);
  });

  // A setting that is not a whole number from 1 is unset: it can neither switch
  // the bound off nor make it tiny.
  it.each([['0'], ['-1'], ['abc'], ['1e3'], ['1,000']])(
    'keeps the default bound when the setting is %j',
    (value) => {
      setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: value });
      for (let i = 0; i < 100_000; i += 1) checkRateLimit(`k${i}`, ONCE);
      checkRateLimit('one-more', ONCE);
      // The default bound is 100,000: the least recently counted tenth went, no more and no less.
      expect(isTracked('k10000')).toBe(true);
      expect(isTracked('k9999')).toBe(false);
    },
  );

  it('holds 100,000 counters by default, then lets the least recently counted tenth go', () => {
    setTestConfig({});
    for (let i = 0; i < 100_000; i += 1) checkRateLimit(`k${i}`, ONCE);
    checkRateLimit('one-more', ONCE);
    expect(isTracked('k10000')).toBe(true);
    expect(isTracked('one-more')).toBe(true);
    expect(isTracked('k9999')).toBe(false);
  });

  it('still refuses a key over its limit for as long as its counter is kept', () => {
    setTestConfig({ RATE_LIMIT_MAX_TRACKED_KEYS: '100' });
    const limit = { maxAttempts: 3, windowSeconds: 60 };
    const outcomes = Array.from({ length: 6 }, () => checkRateLimit('login:ip', limit).allowed);
    expect(outcomes).toEqual([true, true, true, false, false, false]);
  });
});
