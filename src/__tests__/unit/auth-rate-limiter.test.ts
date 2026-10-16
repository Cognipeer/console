/**
 * The auth rate limiter keeps its counters in process memory, so that state
 * has to stay small whatever keys it is given:
 *
 *  - the address part of a client key is normalised (`clientRateLimitKey`):
 *    only a valid IP address gets its own bucket, everything else shares one;
 *  - a key that is still long is stored as a fixed-size digest;
 *  - the number of live keys is capped (`RATE_LIMIT_MAX_TRACKED_KEYS`): counters
 *    whose window has ended go first, then the ones counted least recently.
 *
 * Window semantics, limits and responses for valid addresses are unchanged.
 * Sizes are checked by counting stored keys, never by timing or heap size.
 * How the setting is read is covered in config-mcp-limits.test.ts, and the
 * order in which live counters are dropped in rate-limiter-bounded-store.test.ts.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import {
  LOGIN_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
  REGISTER_RATE_LIMIT,
  SESSION_ISSUANCE_RATE_LIMIT,
  checkRateLimit,
  clientRateLimitKey,
  getRateLimitLongestKeyLength,
  getRateLimitStoreSize,
  normalizeClientAddress,
  resetRateLimitStore,
  type RateLimitConfig,
} from '@/lib/services/auth/rateLimiter';

const originalSource = getConfigSource();
const DEFAULT_CAP = 100_000;
/** No stored key may be longer than this (the limiter's own bound). */
const KEY_BOUND = 256;
/** For loops that only count entries, so no attempt is ever refused or logged. */
const UNLIMITED: RateLimitConfig = { maxAttempts: 1_000_000, windowSeconds: 900 };

function setMaxKeys(value: string | undefined): void {
  setConfigSource({ name: 'test', get: (key) => (key === 'RATE_LIMIT_MAX_TRACKED_KEYS' ? value : undefined) });
}

afterEach(() => {
  setConfigSource(originalSource);
  vi.useRealTimers();
});

const ipv4 = (n: number) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
const randomText = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * Whether the key's counter was already running (as opposed to a new window).
 * Only meaningful with a generous `maxAttempts`. Probing an unknown key adds
 * it, so probe the keys expected to be gone last.
 */
function remembered(key: string, config: RateLimitConfig): boolean {
  return checkRateLimit(key, config).remaining < config.maxAttempts - 1;
}

describe('client address normalisation', () => {
  const validAddresses = [
    '203.0.113.9',
    '10.0.0.1',
    '0.0.0.0',
    '::1',
    '::',
    '2001:db8::1',
    '2001:DB8:0:0:0:0:0:1',
    '::ffff:203.0.113.9',
    'fe80::1%eth0',
  ];

  it.each(validAddresses)('keeps the valid address %s, and its key is the one used before', (address) => {
    expect(normalizeClientAddress(address)).toBe(address);
    expect(clientRateLimitKey('login', address)).toBe(`login:${address}`);
    expect(clientRateLimitKey('forgot-password', address)).toBe(`forgot-password:${address}`);
  });

  it.each([
    ['203.0.113.9:51234', '203.0.113.9'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['[::ffff:203.0.113.9]:8080', '::ffff:203.0.113.9'],
  ])('reads the address out of %s as %s (gateways may append a port)', (value, address) => {
    expect(normalizeClientAddress(value)).toBe(address);
  });

  const notAddresses: Array<[string, string | null | undefined]> = [
    ['empty', ''],
    ['missing', undefined],
    ['null', null],
    ['the "unknown" placeholder', 'unknown'],
    ['free text', 'not-an-ip'],
    ['an out-of-range octet', '999.1.1.1'],
    ['too few octets', '1.2.3'],
    ['too many octets', '1.2.3.4.5'],
    ['an octet with a leading zero', '01.2.3.4'],
    ['an address with a trailing newline', '203.0.113.9\n'],
    ['an address with a port that is too long', '203.0.113.9:123456'],
    ['a hostname with a port', 'example.com:443'],
    ['an unterminated bracket', '[2001:db8::1'],
    ['an IPv6 zone suffix that makes it longer than any address', `::1%${'a'.repeat(45)}`],
    ['a 12 KB value', 'z'.repeat(12_000)],
    ['a 12 KB value shaped like an address with a zone suffix', `::1%${'a'.repeat(12_000)}`],
  ];

  it.each(notAddresses)('puts %s in the shared "invalid" bucket', (_label, value) => {
    expect(normalizeClientAddress(value)).toBe('invalid');
    expect(clientRateLimitKey('login', value)).toBe('login:invalid');
  });
});

describe('limits and windows are unchanged for valid addresses', () => {
  it('keeps the configured limits and windows', () => {
    expect(LOGIN_RATE_LIMIT).toEqual({ maxAttempts: 10, windowSeconds: 15 * 60 });
    expect(REGISTER_RATE_LIMIT).toEqual({ maxAttempts: 5, windowSeconds: 60 * 60 });
    expect(PASSWORD_RESET_RATE_LIMIT).toEqual({ maxAttempts: 3, windowSeconds: 15 * 60 });
    expect(SESSION_ISSUANCE_RATE_LIMIT).toEqual({ maxAttempts: 20, windowSeconds: 15 * 60 });
  });

  it.each(['203.0.113.9', '2001:db8::1'])('counts attempts per address, then refuses with Retry-After (%s)', (address) => {
    vi.useFakeTimers();
    const key = clientRateLimitKey('login', address);

    for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT.maxAttempts; attempt++) {
      const result = checkRateLimit(key, LOGIN_RATE_LIMIT);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(LOGIN_RATE_LIMIT.maxAttempts - attempt);
      expect(result.retryAfterSeconds).toBe(0);
    }

    vi.advanceTimersByTime(60_000);
    const refused = checkRateLimit(key, LOGIN_RATE_LIMIT);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBe(14 * 60);
    expect(refused.resetAt.getTime()).toBe(Date.now() + 14 * 60 * 1000);
  });

  it('keeps addresses apart, and scopes apart', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i++) {
      checkRateLimit(clientRateLimitKey('login', '203.0.113.9'), LOGIN_RATE_LIMIT);
    }
    expect(checkRateLimit(clientRateLimitKey('login', '203.0.113.9'), LOGIN_RATE_LIMIT).allowed).toBe(false);
    expect(checkRateLimit(clientRateLimitKey('login', '203.0.113.10'), LOGIN_RATE_LIMIT).allowed).toBe(true);
    expect(checkRateLimit(clientRateLimitKey('login', '2001:db8::9'), LOGIN_RATE_LIMIT).allowed).toBe(true);
    expect(checkRateLimit(clientRateLimitKey('register', '203.0.113.9'), REGISTER_RATE_LIMIT).allowed).toBe(true);
  });

  it('starts a new window once the previous one has ended', () => {
    vi.useFakeTimers();
    const key = clientRateLimitKey('forgot-password', '203.0.113.9');
    for (let i = 0; i < PASSWORD_RESET_RATE_LIMIT.maxAttempts; i++) checkRateLimit(key, PASSWORD_RESET_RATE_LIMIT);
    expect(checkRateLimit(key, PASSWORD_RESET_RATE_LIMIT).allowed).toBe(false);

    vi.advanceTimersByTime(PASSWORD_RESET_RATE_LIMIT.windowSeconds * 1000 + 1);

    const fresh = checkRateLimit(key, PASSWORD_RESET_RATE_LIMIT);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(PASSWORD_RESET_RATE_LIMIT.maxAttempts - 1);
  });

  it('counts a client once whatever port its connection uses', () => {
    for (let port = 1111; port < 1111 + LOGIN_RATE_LIMIT.maxAttempts; port++) {
      checkRateLimit(clientRateLimitKey('login', `203.0.113.9:${port}`), LOGIN_RATE_LIMIT);
    }
    expect(checkRateLimit(clientRateLimitKey('login', '203.0.113.9'), LOGIN_RATE_LIMIT).allowed).toBe(false);
    expect(getRateLimitStoreSize()).toBe(1);
  });
});

describe('values that are not IP addresses', () => {
  it('share one bucket per scope, and that bucket is limited', () => {
    const values = [
      '',
      'unknown',
      'not-an-ip',
      randomText(6_000), // 12 KB
      randomText(8_000), // 16 KB
      `::1%${randomText(4_000)}`,
      '203.0.113.9:123456',
      'ünïcödé-クライアント',
      '999.999.999.999',
      '1.2.3',
    ];
    expect(values.length).toBe(LOGIN_RATE_LIMIT.maxAttempts);

    for (const value of values) {
      expect(checkRateLimit(clientRateLimitKey('login', value), LOGIN_RATE_LIMIT).allowed).toBe(true);
    }
    // One more attempt, from a value not seen before, is over the shared limit.
    const refused = checkRateLimit(clientRateLimitKey('login', randomText(500)), LOGIN_RATE_LIMIT);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);

    expect(getRateLimitStoreSize()).toBe(1);
  });

  it('do not add entries however many distinct values arrive', () => {
    for (let i = 0; i < 2_000; i++) {
      checkRateLimit(clientRateLimitKey('login', randomText(1_024)), UNLIMITED);
    }
    expect(getRateLimitStoreSize()).toBe(1);
    expect(getRateLimitLongestKeyLength()).toBe('login:invalid'.length);
  });

  it('are bucketed separately per scope, and do not affect valid addresses', () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts + 3; i++) {
      checkRateLimit(clientRateLimitKey('login', `value-${i}`), LOGIN_RATE_LIMIT);
    }
    expect(checkRateLimit(clientRateLimitKey('login', 'anything-else'), LOGIN_RATE_LIMIT).allowed).toBe(false);

    expect(checkRateLimit(clientRateLimitKey('register', 'anything-else'), REGISTER_RATE_LIMIT).allowed).toBe(true);
    expect(checkRateLimit(clientRateLimitKey('login', '203.0.113.9'), LOGIN_RATE_LIMIT)).toMatchObject({
      allowed: true,
      remaining: LOGIN_RATE_LIMIT.maxAttempts - 1,
    });
    expect(getRateLimitStoreSize()).toBe(3);
  });
});

describe('key length', () => {
  const config: RateLimitConfig = { maxAttempts: 3, windowSeconds: 60 };

  it('keeps a key of the bound as given, and replaces a longer one with a short digest', () => {
    checkRateLimit('k'.repeat(KEY_BOUND), config);
    expect(getRateLimitLongestKeyLength()).toBe(KEY_BOUND);

    resetRateLimitStore();
    checkRateLimit('k'.repeat(KEY_BOUND + 1), config);
    expect(getRateLimitStoreSize()).toBe(1);
    expect(getRateLimitLongestKeyLength()).toBeLessThan(100);
  });

  it('tracks a long key as one entry and tells long keys apart by their whole text', () => {
    const shared = `login:${'x'.repeat(5_000)}`;
    const a = `${shared}-a`;
    const b = `${shared}-b`;

    for (let i = 0; i < config.maxAttempts; i++) expect(checkRateLimit(a, config).allowed).toBe(true);
    expect(checkRateLimit(a, config).allowed).toBe(false);
    expect(checkRateLimit(b, config)).toMatchObject({ allowed: true, remaining: config.maxAttempts - 1 });

    expect(getRateLimitStoreSize()).toBe(2);
    expect(getRateLimitLongestKeyLength()).toBeLessThanOrEqual(KEY_BOUND);
  });
});

describe('live key cap', () => {
  it('never tracks more keys than the cap, however many distinct clients show up', () => {
    setMaxKeys(undefined);
    let peak = 0;
    for (let n = 0; n < DEFAULT_CAP + 20_000; n++) {
      checkRateLimit(clientRateLimitKey('login', ipv4(n)), LOGIN_RATE_LIMIT);
      peak = Math.max(peak, getRateLimitStoreSize());
    }
    expect(peak).toBeLessThanOrEqual(DEFAULT_CAP);
    // Dropping makes room for a stretch of new keys but does not empty the store.
    expect(getRateLimitStoreSize()).toBeGreaterThan(DEFAULT_CAP * 0.8);
    expect(getRateLimitStoreSize()).toBeLessThanOrEqual(DEFAULT_CAP);
  });

  it('follows RATE_LIMIT_MAX_TRACKED_KEYS', () => {
    setMaxKeys('50');
    let peak = 0;
    for (let n = 0; n < 500; n++) {
      checkRateLimit(`login:10.0.${n >> 8}.${n & 255}`, LOGIN_RATE_LIMIT);
      peak = Math.max(peak, getRateLimitStoreSize());
    }
    expect(peak).toBeLessThanOrEqual(50);
    expect(getRateLimitStoreSize()).toBeGreaterThan(40);
  });

  it('makes room with a margin, so the next new keys do not each trigger a pass', () => {
    setMaxKeys('100');
    for (let n = 0; n < 100; n++) checkRateLimit(`k${n}`, LOGIN_RATE_LIMIT);
    expect(getRateLimitStoreSize()).toBe(100);

    checkRateLimit('one-more', LOGIN_RATE_LIMIT);

    expect(getRateLimitStoreSize()).toBeLessThan(100);
    expect(getRateLimitStoreSize()).toBeGreaterThan(80);
  });

  it('holds a cap of one', () => {
    setMaxKeys('1');
    checkRateLimit('first', LOGIN_RATE_LIMIT);
    checkRateLimit('second', LOGIN_RATE_LIMIT);
    expect(getRateLimitStoreSize()).toBe(1);
  });
});

describe('eviction order', () => {
  const config: RateLimitConfig = { maxAttempts: 1000, windowSeconds: 3600 };

  it('drops the key counted least recently first when the store is full', () => {
    vi.useFakeTimers();
    setMaxKeys('10');
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    for (const key of keys) {
      checkRateLimit(key, config);
      checkRateLimit(key, config);
      vi.advanceTimersByTime(1_000);
    }
    expect(getRateLimitStoreSize()).toBe(10);

    checkRateLimit('k10', config);

    expect(getRateLimitStoreSize()).toBe(10);
    const survivors = [...keys.slice(1), 'k10'];
    expect(survivors.map((key) => remembered(key, config))).toEqual(survivors.map(() => true));
    expect(remembered('k0', config)).toBe(false);
  });

  it('drops windows that have already ended before any live one', () => {
    vi.useFakeTimers();
    setMaxKeys('10');
    const longWindow = { maxAttempts: 1000, windowSeconds: 3600 };
    const shortWindow = { maxAttempts: 1000, windowSeconds: 60 };
    const longKeys = ['l0', 'l1', 'l2', 'l3', 'l4'];
    const shortKeys = ['s0', 's1', 's2', 's3', 's4'];
    // The long windows are the oldest entries in the store.
    for (const key of longKeys) {
      checkRateLimit(key, longWindow);
      checkRateLimit(key, longWindow);
    }
    for (const key of shortKeys) checkRateLimit(key, shortWindow);
    expect(getRateLimitStoreSize()).toBe(10);

    vi.advanceTimersByTime(61_000); // the short windows have ended, the long ones have not
    checkRateLimit('new', longWindow);

    expect(getRateLimitStoreSize()).toBe(6);
    expect(longKeys.map((key) => remembered(key, longWindow))).toEqual(longKeys.map(() => true));
  });

  it('treats a window that restarted as the newest, not as its old position', () => {
    vi.useFakeTimers();
    setMaxKeys('3');
    const window100: RateLimitConfig = { maxAttempts: 1000, windowSeconds: 100 };
    for (const key of ['a', 'b', 'c']) {
      checkRateLimit(key, window100);
      checkRateLimit(key, window100);
      vi.advanceTimersByTime(10_000);
    }
    // t = 30 s. a's window ends at 100 s, b's at 110 s, c's at 120 s.
    vi.advanceTimersByTime(75_000); // t = 105 s: a's window has ended

    checkRateLimit('a', window100); // a starts a new window
    checkRateLimit('a', window100);
    expect(getRateLimitStoreSize()).toBe(3);

    vi.advanceTimersByTime(1_000);
    checkRateLimit('d', window100); // full: the key counted least recently (b) goes

    expect(remembered('c', window100)).toBe(true);
    expect(remembered('a', window100)).toBe(true);
    expect(remembered('b', window100)).toBe(false);
  });

  it('keeps a client at its limit limited while older windows are dropped', () => {
    setMaxKeys('100');
    for (let n = 0; n < 99; n++) checkRateLimit(`k${n}`, LOGIN_RATE_LIMIT);
    for (let attempt = 0; attempt <= LOGIN_RATE_LIMIT.maxAttempts; attempt++) {
      checkRateLimit('limited-client', LOGIN_RATE_LIMIT);
    }
    expect(checkRateLimit('limited-client', LOGIN_RATE_LIMIT).allowed).toBe(false);

    for (let n = 0; n < 50; n++) checkRateLimit(`later-${n}`, LOGIN_RATE_LIMIT);

    expect(remembered('k0', { maxAttempts: 1000, windowSeconds: 900 })).toBe(false);
    expect(checkRateLimit('limited-client', LOGIN_RATE_LIMIT).allowed).toBe(false);
  });
});

describe('periodic sweep', () => {
  it('still removes ended windows on its timer', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fresh = await import('@/lib/services/auth/rateLimiter');

    fresh.checkRateLimit('a', { maxAttempts: 1, windowSeconds: 60 });
    fresh.checkRateLimit('b', { maxAttempts: 1, windowSeconds: 3600 });
    expect(fresh.getRateLimitStoreSize()).toBe(2);

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(fresh.getRateLimitStoreSize()).toBe(1);
  });
});

/**
 * Negative control. The measurements above only mean something if they can
 * fail: this is the limiter as it behaved before the cap (same window logic,
 * keys stored exactly as given, nothing ever dropped), put through the same
 * checks. It must report unbounded state where the real limiter does not.
 */
describe('negative control: the limiter before the cap', () => {
  interface Probe {
    /** Records an attempt and returns whether it was allowed. */
    check(key: string): boolean;
    size(): number;
    longestKey(): number;
  }

  function createUncappedReference(config: RateLimitConfig): Probe {
    const entries = new Map<string, { count: number; resetAt: number }>();
    return {
      check(key) {
        const now = Date.now();
        let entry = entries.get(key);
        if (!entry || entry.resetAt <= now) {
          entry = { count: 1, resetAt: now + config.windowSeconds * 1000 };
          entries.set(key, entry);
        } else {
          entry.count++;
        }
        return entry.count <= config.maxAttempts;
      },
      size: () => entries.size,
      longestKey: () => Array.from(entries.keys()).reduce((longest, key) => Math.max(longest, key.length), 0),
    };
  }

  function createRealProbe(config: RateLimitConfig): Probe {
    return {
      check: (key) => checkRateLimit(key, config).allowed,
      size: getRateLimitStoreSize,
      longestKey: getRateLimitLongestKeyLength,
    };
  }

  const CAP = 100;
  const CLIENTS = 600;

  /** Keys as the call sites built them before: `<route>:<forwarded value>`, 8 KB values. */
  function presentUnusualClients(probe: Probe): void {
    for (let i = 0; i < CLIENTS; i++) probe.check(`login:${randomText(4_096)}`);
  }

  function expectBounded(probe: Probe): void {
    expect(probe.size()).toBeLessThanOrEqual(CAP);
    expect(probe.longestKey()).toBeLessThanOrEqual(KEY_BOUND);
  }

  it('the real limiter stays bounded when handed raw long keys', () => {
    setMaxKeys(String(CAP));
    const probe = createRealProbe(UNLIMITED);
    presentUnusualClients(probe);
    expectBounded(probe);
  });

  it('the same measurement on the uncapped limiter reports unbounded state', () => {
    const probe = createUncappedReference(UNLIMITED);
    presentUnusualClients(probe);

    expect(probe.size()).toBe(CLIENTS);
    expect(probe.longestKey()).toBeGreaterThan(8_000);
    expect(() => expectBounded(probe)).toThrow();
  });

  it('forwarded values give one entry per value with the old keys, and one in total with the new', () => {
    const reference = createUncappedReference(UNLIMITED);
    const forwardedValues = Array.from({ length: 300 }, () => randomText(4_096));

    for (const forwarded of forwardedValues) reference.check(`login:${forwarded}`);
    for (const forwarded of forwardedValues) checkRateLimit(clientRateLimitKey('login', forwarded), UNLIMITED);

    expect(reference.size()).toBe(300);
    expect(getRateLimitStoreSize()).toBe(1);
  });

  it('the control makes the same decisions as the real limiter for a valid client', () => {
    const reference = createUncappedReference(LOGIN_RATE_LIMIT);
    const real = createRealProbe(LOGIN_RATE_LIMIT);
    const key = clientRateLimitKey('login', '203.0.113.9');

    const decisions = (probe: Probe) => Array.from({ length: 13 }, () => probe.check(key));

    expect(decisions(reference)).toEqual(decisions(real));
    expect(reference.size()).toBe(real.size());
    expect(reference.longestKey()).toBe(real.longestKey());
  });
});
