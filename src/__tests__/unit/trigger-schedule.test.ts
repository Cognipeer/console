/**
 * Trigger time arithmetic (agentTriggerSchedule.ts): 5-field cron in an
 * IANA timezone across daylight-saving changes, the first fire of a saved
 * trigger, and what the scheduler does with a due slot (misfire grace).
 */

import { describe, expect, it } from 'vitest';
import {
  initialNextFireAt,
  isValidTriggerTimezone,
  latestCronSlot,
  nextCronFire,
  planDueTrigger,
  upcomingCronFires,
  validateTriggerCron,
} from '@/lib/services/agents/agentTriggerSchedule';

const iso = (date: Date | null) => date?.toISOString() ?? null;
const HOUR = 3_600_000;

describe('validation', () => {
  it('takes exactly five cron fields', () => {
    expect(validateTriggerCron('0 9 * * 1-5')).toBeNull();
    expect(validateTriggerCron('  */15   * * * *  ')).toBeNull();
    expect(validateTriggerCron('0 0 9 * * 1-5')).toMatch(/5 fields/); // seconds field
    expect(validateTriggerCron('0 9 * *')).toMatch(/5 fields/);
    expect(validateTriggerCron('99 9 * * *')).toMatch(/invalid cron/);
    expect(validateTriggerCron('')).toMatch(/required/);
    expect(validateTriggerCron(42)).toMatch(/required/);
  });

  it('knows IANA timezones, and UTC', () => {
    expect(isValidTriggerTimezone('Europe/Istanbul')).toBe(true);
    expect(isValidTriggerTimezone('America/New_York')).toBe(true);
    expect(isValidTriggerTimezone('UTC')).toBe(true);
    expect(isValidTriggerTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTriggerTimezone('')).toBe(false);
    expect(isValidTriggerTimezone(null)).toBe(false);
  });
});

describe('daylight saving', () => {
  it('America/New_York: 09:00 local stays 09:00 local across the spring change (14:00Z → 13:00Z)', () => {
    const fires = upcomingCronFires('0 9 * * *', 'America/New_York', new Date('2026-03-06T15:00:00Z'), 3);
    expect(fires.map(iso)).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);
  });

  it('America/New_York: a local time the spring change skips fires at the first valid time after it', () => {
    // 2026-03-08 02:30 does not exist; it fires at 03:30 EDT (07:30Z).
    expect(iso(nextCronFire('30 2 * * *', 'America/New_York', new Date('2026-03-08T05:00:00Z')))).toBe('2026-03-08T07:30:00.000Z');
  });

  it('America/New_York: a local time the fall change repeats fires once', () => {
    const fires = upcomingCronFires('30 1 * * *', 'America/New_York', new Date('2026-10-31T12:00:00Z'), 3);
    expect(fires.map(iso)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);
  });

  it('Europe/Istanbul has no DST: 09:00 local is 06:00Z all year', () => {
    expect(iso(nextCronFire('0 9 * * *', 'Europe/Istanbul', new Date('2026-01-10T00:00:00Z')))).toBe('2026-01-10T06:00:00.000Z');
    expect(iso(nextCronFire('0 9 * * *', 'Europe/Istanbul', new Date('2026-07-10T00:00:00Z')))).toBe('2026-07-10T06:00:00.000Z');
    // Weekdays only: Friday → Monday.
    expect(iso(nextCronFire('0 9 * * 1-5', 'Europe/Istanbul', new Date('2026-10-16T07:00:00Z')))).toBe('2026-10-19T06:00:00.000Z');
  });

  it('the latest slot at or before a time includes a slot exactly on it', () => {
    expect(iso(latestCronSlot('0 * * * *', 'UTC', new Date('2026-10-18T09:00:00.000Z')))).toBe('2026-10-18T09:00:00.000Z');
    expect(iso(latestCronSlot('0 * * * *', 'UTC', new Date('2026-10-18T09:59:59.000Z')))).toBe('2026-10-18T09:00:00.000Z');
  });
});

describe('initialNextFireAt', () => {
  const now = new Date('2026-10-18T10:00:00Z');

  it('a schedule: the first slot strictly after now', () => {
    expect(iso(initialNextFireAt({ enabled: true, type: 'schedule', schedule: { cron: '0 10 * * *', timezone: 'UTC' } }, now))).toBe('2026-10-19T10:00:00.000Z');
  });

  it('a once trigger: its time until it has fired (a Run now before it does not count)', () => {
    const runAt = new Date('2026-10-18T12:00:00Z');
    expect(iso(initialNextFireAt({ enabled: true, type: 'once', once: { runAt } }, now))).toBe(runAt.toISOString());
    expect(initialNextFireAt({ enabled: true, type: 'once', once: { runAt }, lastFireAt: new Date('2026-10-18T09:00:00Z') }, now)?.toISOString()).toBe(runAt.toISOString());
    expect(initialNextFireAt({ enabled: true, type: 'once', once: { runAt }, lastFireAt: runAt }, now)).toBeNull();
  });

  it('manual and disabled triggers have none', () => {
    expect(initialNextFireAt({ enabled: true, type: 'manual' }, now)).toBeNull();
    expect(initialNextFireAt({ enabled: false, type: 'schedule', schedule: { cron: '* * * * *', timezone: 'UTC' } }, now)).toBeNull();
  });
});

describe('planDueTrigger (misfire grace)', () => {
  const hourly = { type: 'schedule' as const, schedule: { cron: '0 * * * *', timezone: 'UTC' } };

  it('fires a slot that is due now and moves on to the next one', () => {
    expect(planDueTrigger(hourly, new Date('2026-10-18T09:00:00Z'), new Date('2026-10-18T09:00:05Z'), HOUR)).toEqual({
      kind: 'fire', fireAt: new Date('2026-10-18T09:00:00Z'), next: new Date('2026-10-18T10:00:00Z'),
    });
  });

  it('of several missed slots, only the latest within the grace fires', () => {
    expect(planDueTrigger(hourly, new Date('2026-10-18T06:00:00Z'), new Date('2026-10-18T09:20:00Z'), HOUR)).toEqual({
      kind: 'fire', fireAt: new Date('2026-10-18T09:00:00Z'), next: new Date('2026-10-18T10:00:00Z'),
    });
  });

  it('a latest slot older than the grace is missed', () => {
    const daily = { type: 'schedule' as const, schedule: { cron: '0 6 * * *', timezone: 'UTC' } };
    expect(planDueTrigger(daily, new Date('2026-10-18T06:00:00Z'), new Date('2026-10-18T09:00:00Z'), HOUR)).toEqual({
      kind: 'missed', slot: new Date('2026-10-18T06:00:00Z'), next: new Date('2026-10-19T06:00:00Z'),
    });
  });

  it('a once trigger fires within the grace, is missed after it, and never has a next slot', () => {
    const runAt = new Date('2026-10-18T09:00:00Z');
    expect(planDueTrigger({ type: 'once', once: { runAt } }, runAt, new Date('2026-10-18T09:30:00Z'), HOUR)).toEqual({ kind: 'fire', fireAt: runAt, next: null });
    expect(planDueTrigger({ type: 'once', once: { runAt } }, runAt, new Date('2026-10-18T11:00:00Z'), HOUR)).toEqual({ kind: 'missed', slot: runAt, next: null });
  });
});
