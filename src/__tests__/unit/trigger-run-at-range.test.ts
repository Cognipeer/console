/**
 * Time inputs of a `once` trigger and of a delayed run are range-checked: a
 * value a Date cannot hold, or one far ahead (milliseconds sent as seconds),
 * is answered with an error instead of an Invalid Date or a never-firing time.
 */

import { describe, expect, it } from 'vitest';
import { parseRunSchedule, parseTimestamp } from '@/server/api/plugins/client-agent-runs';
import { MAX_ONCE_TRIGGER_AHEAD_MS, parseTriggerTypeSettings } from '@/server/api/plugins/agent-triggers';

const NOW = new Date('2026-11-09T12:00:00Z');
const nowSeconds = NOW.getTime() / 1000;
const DAY = 86_400;

const once = (settings: Record<string, unknown>) => parseTriggerTypeSettings('once', settings, NOW);

describe('parseTimestamp', () => {
  it('is null for a number or numeric string beyond the Date range', () => {
    expect(parseTimestamp(1.7e15)).toBeNull();
    expect(parseTimestamp('1700000000000000')).toBeNull();
    expect(parseTimestamp(nowSeconds)).toEqual(NOW);
  });
});

describe('once trigger time', () => {
  it('accepts a time within the horizon', () => {
    expect(once({ run_at: nowSeconds + 3600 })).toMatchObject({ ok: true });
    expect(once({ delay_seconds: 7 * DAY })).toMatchObject({ ok: true });
    expect(once({ run_at: nowSeconds + 364 * DAY })).toMatchObject({ ok: true });
  });

  it('rejects run_at in milliseconds (read as seconds it is tens of thousands of years ahead)', () => {
    const result = once({ run_at: NOW.getTime() });
    expect(result).toMatchObject({ ok: false, issue: { field: 'once.run_at' } });
    expect((result as { issue: { message: string } }).issue.message).toMatch(/milliseconds/);
  });

  it('rejects a run_at or delay_seconds a Date cannot hold', () => {
    expect(once({ run_at: 1.78e15 })).toMatchObject({ ok: false, issue: { field: 'once.run_at' } });
    expect(once({ delay_seconds: 1e13 })).toMatchObject({ ok: false, issue: { field: 'once.delay_seconds' } });
  });

  it('rejects a delay_seconds or an ISO run_at past the horizon', () => {
    const days = MAX_ONCE_TRIGGER_AHEAD_MS / 86_400_000;
    expect(once({ delay_seconds: (days + 1) * DAY })).toMatchObject({ ok: false, issue: { field: 'once.delay_seconds' } });
    expect(once({ run_at: '2099-01-01T00:00:00Z' })).toMatchObject({ ok: false, issue: { field: 'once.run_at' } });
  });
});

describe('parseRunSchedule', () => {
  it('answers an error, not "start now", for a delay or run_at a Date cannot hold', () => {
    expect(parseRunSchedule({ delay_seconds: 9e12 }, NOW.getTime())).toMatchObject({ param: 'delay_seconds' });
    expect(parseRunSchedule({ run_at: 1.7e15 }, NOW.getTime())).toMatchObject({ param: 'run_at' });
  });

  it('still schedules within 30 days', () => {
    expect(parseRunSchedule({ delay_seconds: 60 }, NOW.getTime())).toEqual({ notBefore: new Date(NOW.getTime() + 60_000) });
  });
});
