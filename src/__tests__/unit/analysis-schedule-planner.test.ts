/**
 * Unit tests — analysis cron schedule planner.
 */

import { describe, it, expect } from 'vitest';
import { computeNextRun, isDue, validateCron, type AnalysisSchedule } from '@/lib/services/analysis/schedulePlanner';

const nightly: AnalysisSchedule = { cron: '0 2 * * *', enabled: true }; // 02:00 UTC daily

describe('validateCron', () => {
  it('accepts valid expressions and rejects bad/empty ones', () => {
    expect(validateCron('0 2 * * *')).toBeNull();
    expect(validateCron('')).toBeTruthy();
    expect(validateCron('not a cron')).toBeTruthy();
  });
});

describe('computeNextRun', () => {
  it('returns the next slot at/after the reference', () => {
    const from = new Date('2026-06-03T03:00:00Z'); // just after 02:00
    const next = computeNextRun(nightly, null, from);
    expect(next?.toISOString()).toBe('2026-06-04T02:00:00.000Z');
  });
  it('returns null when disabled or invalid', () => {
    expect(computeNextRun({ cron: '0 2 * * *', enabled: false }, null)).toBeNull();
    expect(computeNextRun({ cron: 'bad', enabled: true }, null)).toBeNull();
  });
});

describe('isDue', () => {
  const now = new Date('2026-06-03T03:00:00Z'); // 02:00 slot has passed today

  it('is due when it has never run and a slot has passed', () => {
    expect(isDue(nightly, null, now)).toBe(true);
  });
  it('is due when the last run predates the most recent slot', () => {
    expect(isDue(nightly, new Date('2026-06-02T02:30:00Z'), now)).toBe(true);
  });
  it('is not due when already run after the most recent slot', () => {
    expect(isDue(nightly, new Date('2026-06-03T02:30:00Z'), now)).toBe(false);
  });
  it('is not due when disabled', () => {
    expect(isDue({ cron: '0 2 * * *', enabled: false }, null, now)).toBe(false);
  });
});
