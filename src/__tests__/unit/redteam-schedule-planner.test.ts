/**
 * Unit tests — red-team schedule planner (cron due-logic for scheduled scans).
 */

import { describe, it, expect } from 'vitest';
import { computeNextRun, isDue, validateCron } from '@/lib/services/redteam/schedulePlanner';

const DAILY_3AM = '0 3 * * *';

describe('validateCron', () => {
  it('accepts a valid expression', () => {
    expect(validateCron(DAILY_3AM)).toBeNull();
  });
  it('rejects empty / invalid', () => {
    expect(validateCron('')).toMatch(/required/);
    expect(validateCron('not a cron')).toMatch(/invalid/);
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
