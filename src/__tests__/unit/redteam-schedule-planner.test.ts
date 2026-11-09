/**
 * Unit tests — red-team schedule planner (cron due-logic for scheduled scans).
 */

import { describe, it, expect } from 'vitest';
import { computeNextRun, isDue, latestSlot, validateCron } from '@/lib/services/redteam/schedulePlanner';

const DAILY_3AM = '0 3 * * *';

describe('validateCron', () => {
  it('accepts a valid expression', () => {
    expect(validateCron(DAILY_3AM)).toBeNull();
  });
  it('rejects empty / invalid', () => {
    expect(validateCron('')).toMatch(/required/);
    expect(validateCron('not a cron')).toMatch(/invalid/);
  });

  it('refuses a schedule that fires more often than every 15 minutes', () => {
    expect(validateCron('* * * * *')).toMatch(/15 minutes/);
    expect(validateCron('*/5 * * * *')).toMatch(/15 minutes/);
    expect(validateCron('*/14 * * * *')).toMatch(/15 minutes/);
    // Two close minutes inside an hour, and a close pair across midnight.
    expect(validateCron('0,10 * * * *')).toMatch(/15 minutes/);
    expect(validateCron('55,0 23,0 * * *')).toMatch(/15 minutes/);
    // A seconds field counts too.
    expect(validateCron('*/30 * * * * *')).toMatch(/15 minutes/);
  });

  it('accepts a schedule of at least 15 minutes between scans', () => {
    expect(validateCron('*/15 * * * *')).toBeNull();
    expect(validateCron('0 * * * *')).toBeNull();
    expect(validateCron('0 */6 * * *')).toBeNull();
    expect(validateCron('30 3 * * 1')).toBeNull();
  });

  it('only refuses at save time: a schedule saved before the minimum still gets due-checked', () => {
    const now = new Date('2026-06-04T05:00:30Z');
    expect(isDue({ cron: '* * * * *', enabled: true }, null, now)).toBe(true);
    expect(computeNextRun({ cron: '*/5 * * * *', enabled: true }, null, now)?.toISOString()).toBe('2026-06-04T05:05:00.000Z');
  });
});

describe('validateCron without the interval minimum', () => {
  it('accepts a fast expression that parses', () => {
    expect(validateCron('*/5 * * * *')).toMatch(/15 minutes/);
    expect(validateCron('*/5 * * * *', { minInterval: false })).toBeNull();
  });
  it('still refuses an empty or unparsable expression', () => {
    expect(validateCron('', { minInterval: false })).toBeTruthy();
    expect(validateCron('nope', { minInterval: false })).toBeTruthy();
  });
});

describe('latestSlot', () => {
  it('is the latest cron slot at or before now', () => {
    const slot = latestSlot({ cron: DAILY_3AM, enabled: true }, new Date('2026-06-04T05:00:00Z'));
    expect(slot?.toISOString()).toBe('2026-06-04T03:00:00.000Z');
  });
  it('is null for an unusable schedule', () => {
    expect(latestSlot({ cron: 'nope', enabled: true })).toBeNull();
    expect(latestSlot(undefined)).toBeNull();
  });
});

describe('isDue', () => {
  const now = new Date('2026-06-04T05:00:00Z'); // after 03:00 slot

  it('is not due when disabled or unset', () => {
    expect(isDue(undefined, null, now)).toBe(false);
    expect(isDue({ cron: DAILY_3AM, enabled: false }, null, now)).toBe(false);
  });

  it('fires when it has never run', () => {
    expect(isDue({ cron: DAILY_3AM, enabled: true }, null, now)).toBe(true);
  });

  it('does not re-fire within the same slot', () => {
    const justRan = new Date('2026-06-04T03:30:00Z'); // after the 03:00 slot
    expect(isDue({ cron: DAILY_3AM, enabled: true }, justRan, now)).toBe(false);
  });

  it('fires again once a new slot elapses', () => {
    const ranYesterday = new Date('2026-06-03T03:30:00Z');
    expect(isDue({ cron: DAILY_3AM, enabled: true }, ranYesterday, now)).toBe(true);
  });
});

describe('computeNextRun', () => {
  it('returns the next slot after now', () => {
    const next = computeNextRun({ cron: DAILY_3AM, enabled: true }, null, new Date('2026-06-04T05:00:00Z'));
    expect(next?.toISOString()).toBe('2026-06-05T03:00:00.000Z');
  });
  it('is null when disabled', () => {
    expect(computeNextRun({ cron: DAILY_3AM, enabled: false }, null)).toBeNull();
  });
});
