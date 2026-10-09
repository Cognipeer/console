/**
 * The pure model behind the token screens: badges, the expiry choices a form
 * offers under the tenant policy (and the payload they produce), and the IP
 * allowlist text parsing.
 */
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  EXPIRY_PRESET_DAYS,
  NO_POLICY,
  allowlistToText,
  daysFromToday,
  defaultExpiryChoice,
  expiryPayload,
  expiryPresets,
  expiryPreview,
  expiryProblem,
  fromDateInput,
  maxDaysFromNow,
  normalizeTokenPolicy,
  parseAllowlistText,
  sameRanges,
  toDateInput,
  tokenStatuses,
  type ExpiryContext,
} from '@/components/iam/tokens/tokenModel';

// Noon local time: no DST edge, and "today +N" is unambiguous.
const NOW = new Date(2026, 9, 9, 12, 0, 0).getTime();
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY_MS).toISOString();
const ctx = (maxLifetimeDays: number | null, expiryRequired = maxLifetimeDays !== null, createdAt?: string): ExpiryContext => ({
  policy: { maxLifetimeDays, expiryRequired },
  createdAt,
  now: NOW,
});

describe('normalizeTokenPolicy', () => {
  it('reads the API answer', () => {
    expect(normalizeTokenPolicy({ maxLifetimeDays: 90, requireExpiry: false, expiryRequired: true, maxIpRanges: 100, clientIp: '203.0.113.9', trustsForwardedHeaders: true }))
      .toEqual({ maxLifetimeDays: 90, requireExpiry: false, expiryRequired: true, maxIpRanges: 100, clientIp: '203.0.113.9', trustsForwardedHeaders: true });
  });

  it('a maximum implies a required expiry even when the flag is missing', () => {
    expect(normalizeTokenPolicy({ maxLifetimeDays: 30 }).expiryRequired).toBe(true);
    expect(normalizeTokenPolicy({ requireExpiry: true }).expiryRequired).toBe(true);
  });

  it('shows an IPv4-mapped client address as plain IPv4', () => {
    expect(normalizeTokenPolicy({ clientIp: '::ffff:203.0.113.9' }).clientIp).toBe('203.0.113.9');
    expect(normalizeTokenPolicy({ clientIp: '2001:db8::1' }).clientIp).toBe('2001:db8::1');
    expect(normalizeTokenPolicy({ clientIp: '' }).clientIp).toBeNull();
  });

  it('falls back to "no rule" on anything unusable', () => {
    for (const raw of [null, undefined, 'x', 7, [], { maxLifetimeDays: 0 }, { maxLifetimeDays: 'ten' }, { maxLifetimeDays: Number.NaN }]) {
      expect(normalizeTokenPolicy(raw)).toEqual(NO_POLICY);
    }
  });
});

describe('tokenStatuses', () => {
  const base = { createdAt: iso(-2), expiresAt: null, exceedsTenantPolicy: false, lastUsed: null, allowedIpRanges: null };

  it('a fresh unrestricted token has no badge', () => {
    expect(tokenStatuses(base, NOW)).toEqual([]);
  });

  it('expired: past the expiry, and it hides the policy and unused badges that no longer matter', () => {
    expect(tokenStatuses({ ...base, expiresAt: iso(-1), exceedsTenantPolicy: true, createdAt: iso(-100) }, NOW)).toEqual(['expired']);
    expect(tokenStatuses({ ...base, expiresAt: iso(1) }, NOW)).toEqual([]);
  });

  it('exceeds the tenant policy', () => {
    expect(tokenStatuses({ ...base, exceedsTenantPolicy: true }, NOW)).toEqual(['exceedsPolicy']);
  });

  it('unused for 30+ days: counted from the last use, or from creation when never used', () => {
    expect(tokenStatuses({ ...base, createdAt: iso(-29) }, NOW)).toEqual([]);
    expect(tokenStatuses({ ...base, createdAt: iso(-30) }, NOW)).toEqual(['unused']);
    expect(tokenStatuses({ ...base, createdAt: iso(-400), lastUsed: iso(-5) }, NOW)).toEqual([]);
    expect(tokenStatuses({ ...base, createdAt: iso(-400), lastUsed: iso(-31) }, NOW)).toEqual(['unused']);
    // lastUsedAt (the IAM center's name) is read as well
    expect(tokenStatuses({ ...base, createdAt: iso(-400), lastUsedAt: iso(-1) }, NOW)).toEqual([]);
  });

  it('ip restricted is informational and combines with the others', () => {
    expect(tokenStatuses({ ...base, allowedIpRanges: ['10.0.0.0/8'] }, NOW)).toEqual(['ipRestricted']);
    expect(tokenStatuses({ ...base, allowedIpRanges: [] }, NOW)).toEqual([]);
    expect(tokenStatuses({ ...base, exceedsTenantPolicy: true, createdAt: iso(-60), allowedIpRanges: ['10.0.0.0/8'] }, NOW))
      .toEqual(['exceedsPolicy', 'unused', 'ipRestricted']);
  });

  it('tolerates unparsable dates', () => {
    expect(tokenStatuses({ ...base, createdAt: 'garbage', expiresAt: 'garbage' }, NOW)).toEqual([]);
  });
});

describe('date helpers', () => {
  it('round-trips yyyy-mm-dd in local time', () => {
    const date = new Date(2026, 11, 31);
    expect(toDateInput(date)).toBe('2026-12-31');
    expect(fromDateInput('2026-12-31')?.getTime()).toBe(date.getTime());
    expect(fromDateInput('2026-1-1')).toBeNull();
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput('not a date')).toBeNull();
  });

  it('counts calendar days from today', () => {
    expect(daysFromToday(new Date(2026, 9, 9), NOW)).toBe(0);
    expect(daysFromToday(new Date(2026, 9, 10), NOW)).toBe(1);
    expect(daysFromToday(new Date(2026, 10, 8), NOW)).toBe(30);
    expect(daysFromToday(new Date(2026, 9, 8), NOW)).toBe(-1);
    // across a year boundary
    expect(daysFromToday(new Date(2027, 9, 9), NOW)).toBe(365);
  });
});

describe('maximum and presets', () => {
  it('no maximum: every preset', () => {
    expect(maxDaysFromNow(ctx(null))).toBeNull();
    expect(expiryPresets(ctx(null))).toEqual([...EXPIRY_PRESET_DAYS]);
  });

  it('a new token under a maximum: presets that fit, plus the maximum itself', () => {
    expect(maxDaysFromNow(ctx(60))).toBe(60);
    expect(expiryPresets(ctx(60))).toEqual([7, 30, 60]);
    expect(expiryPresets(ctx(90))).toEqual([7, 30, 90]);
    expect(expiryPresets(ctx(5))).toEqual([5]);
    expect(expiryPresets(ctx(3650))).toEqual([7, 30, 90, 180, 365, 3650]);
  });

  it('an existing token: what is left of its lifetime, rounded down', () => {
    // created 10 days (and 1 hour) ago, maximum 30 -> 19 whole days left
    const created = new Date(NOW - 10 * DAY_MS - 3_600_000).toISOString();
    expect(maxDaysFromNow(ctx(30, true, created))).toBe(19);
    expect(expiryPresets(ctx(30, true, created))).toEqual([7, 19]);
    // lifetime already used up
    const old = new Date(NOW - 40 * DAY_MS).toISOString();
    expect(maxDaysFromNow(ctx(30, true, old))).toBe(0);
    expect(expiryPresets(ctx(30, true, old))).toEqual([]);
  });
});

describe('defaultExpiryChoice', () => {
  it('create: no rule = never expires (nothing changes for tenants without a policy)', () => {
    expect(defaultExpiryChoice({ ...ctx(null), mode: 'create' })).toEqual({ kind: 'none' });
  });

  it('create: a required expiry defaults to 90 days or the largest preset that fits', () => {
    expect(defaultExpiryChoice({ ...ctx(null, true), mode: 'create' })).toEqual({ kind: 'days', days: 90 });
    expect(defaultExpiryChoice({ ...ctx(180), mode: 'create' })).toEqual({ kind: 'days', days: 90 });
    expect(defaultExpiryChoice({ ...ctx(30), mode: 'create' })).toEqual({ kind: 'days', days: 30 });
    expect(defaultExpiryChoice({ ...ctx(5), mode: 'create' })).toEqual({ kind: 'days', days: 5 });
  });

  it('edit: keep what is there', () => {
    expect(defaultExpiryChoice({ ...ctx(30), mode: 'edit' })).toEqual({ kind: 'keep' });
  });
});

describe('expiryProblem', () => {
  it('none is only fine when no expiry is required', () => {
    expect(expiryProblem({ kind: 'none' }, ctx(null))).toBeNull();
    expect(expiryProblem({ kind: 'none' }, ctx(null, true))).toBe('required');
    expect(expiryProblem({ kind: 'none' }, ctx(30))).toBe('required');
    expect(expiryProblem({ kind: 'keep' }, ctx(30))).toBeNull();
  });

  it('days: positive whole numbers within the maximum', () => {
    expect(expiryProblem({ kind: 'days', days: 30 }, ctx(30))).toBeNull();
    expect(expiryProblem({ kind: 'days', days: 31 }, ctx(30))).toBe('tooLong');
    expect(expiryProblem({ kind: 'days', days: 0 }, ctx(null))).toBe('notFuture');
    expect(expiryProblem({ kind: 'days', days: 1.5 }, ctx(null))).toBe('notFuture');
    expect(expiryProblem({ kind: 'days', days: 9999 }, ctx(null))).toBeNull();
  });

  it('date: in the future and within the maximum, counted in whole days from today', () => {
    expect(expiryProblem({ kind: 'date', date: toDateInput(new Date(2026, 9, 10)) }, ctx(30))).toBeNull();
    expect(expiryProblem({ kind: 'date', date: toDateInput(new Date(2026, 10, 8)) }, ctx(30))).toBeNull(); // +30
    expect(expiryProblem({ kind: 'date', date: toDateInput(new Date(2026, 10, 9)) }, ctx(30))).toBe('tooLong'); // +31
    expect(expiryProblem({ kind: 'date', date: toDateInput(new Date(2026, 9, 9)) }, ctx(30))).toBe('notFuture');
    expect(expiryProblem({ kind: 'date', date: '2026-10-08' }, ctx(null))).toBe('notFuture');
    expect(expiryProblem({ kind: 'date', date: 'nope' }, ctx(null))).toBe('invalidDate');
  });

  it('an existing token cannot be pushed past its original ceiling', () => {
    const created = new Date(NOW - 10 * DAY_MS).toISOString();
    const c = ctx(30, true, created); // 20 days left
    expect(expiryProblem({ kind: 'days', days: 20 }, c)).toBeNull();
    expect(expiryProblem({ kind: 'days', days: 21 }, c)).toBe('tooLong');
    expect(expiryProblem({ kind: 'none' }, c)).toBe('required');
  });
});

describe('expiryPayload', () => {
  it('keep sends nothing; none sends nothing on create and null on edit', () => {
    expect(expiryPayload({ kind: 'keep' }, 'edit', NOW)).toEqual({});
    expect(expiryPayload({ kind: 'none' }, 'create', NOW)).toEqual({});
    expect(expiryPayload({ kind: 'none' }, 'edit', NOW)).toEqual({ expiresAt: null });
  });

  it('days and dates both go out as "N days from now"', () => {
    expect(expiryPayload({ kind: 'days', days: 30 }, 'create', NOW)).toEqual({ expiresInDays: 30 });
    expect(expiryPayload({ kind: 'date', date: toDateInput(new Date(2026, 10, 8)) }, 'create', NOW)).toEqual({ expiresInDays: 30 });
    expect(expiryPayload({ kind: 'date', date: toDateInput(new Date(2026, 9, 10)) }, 'edit', NOW)).toEqual({ expiresInDays: 1 });
    expect(expiryPayload({ kind: 'date', date: 'nope' }, 'create', NOW)).toEqual({});
  });
});

describe('expiryPreview', () => {
  it('shows when a choice would expire the token', () => {
    expect(expiryPreview({ kind: 'none' }, NOW)).toBeNull();
    expect(expiryPreview({ kind: 'keep' }, NOW)).toBeNull();
    expect(expiryPreview({ kind: 'days', days: 7 }, NOW)?.getTime()).toBe(NOW + 7 * DAY_MS);
    expect(expiryPreview({ kind: 'date', date: toDateInput(new Date(2026, 9, 12)) }, NOW)?.getTime()).toBe(NOW + 3 * DAY_MS);
  });
});

describe('parseAllowlistText', () => {
  it('normalizes and de-duplicates', () => {
    const parsed = parseAllowlistText('10.0.0.0/8\n203.0.113.7, 203.0.113.7/32 ; 2001:DB8::/32\n');
    expect(parsed.ranges).toEqual(['10.0.0.0/8', '203.0.113.7/32', '2001:db8::/32']);
    expect(parsed.issues).toEqual([]);
    expect(parsed.tooMany).toBe(false);
  });

  it('reports each problem with its position in the typed list', () => {
    const parsed = parseAllowlistText('10.0.0.0/8\nnope\n10.0.0.0/40\n192.0.2.1');
    expect(parsed.ranges).toEqual(['10.0.0.0/8', '192.0.2.1/32']);
    expect(parsed.issues).toEqual([
      { position: 2, value: 'nope', reason: 'address' },
      { position: 3, value: '10.0.0.0/40', reason: 'prefix' },
    ]);
  });

  it('flags a list longer than allowed', () => {
    const text = Array.from({ length: 5 }, (_, i) => `10.0.${i}.0/24`).join('\n');
    expect(parseAllowlistText(text, 4).tooMany).toBe(true);
    expect(parseAllowlistText(text, 5).tooMany).toBe(false);
  });

  it('empty text is an empty list', () => {
    expect(parseAllowlistText('  \n ')).toEqual({ ranges: [], issues: [], tooMany: false });
  });

  it('round-trips through allowlistToText and compares lists', () => {
    expect(allowlistToText(['10.0.0.0/8', '192.0.2.1/32'])).toBe('10.0.0.0/8\n192.0.2.1/32');
    expect(allowlistToText(null)).toBe('');
    expect(sameRanges(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameRanges(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameRanges(null, [])).toBe(true);
    expect(sameRanges(['a'], null)).toBe(false);
  });
});
