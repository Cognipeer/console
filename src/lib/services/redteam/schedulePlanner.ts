/**
 * Pure cron-scheduling helpers for red-team campaigns.
 *
 * Side-effect free so the due-logic is unit-testable without the DB or the
 * scheduler loop. "Due" means a cron slot has elapsed since the campaign's last
 * scan (so each slot fires at most once). Mirrors the analysis schedule planner.
 */

import cronParser from 'cron-parser';

export interface RedTeamSchedule {
  cron: string;
  enabled: boolean;
}

/** The shortest gap a saved schedule may have: a scan is many model calls, so it is never a per-minute job. */
export const MIN_SCHEDULE_INTERVAL_MS = 15 * 60_000;

const DAY_SECONDS = 24 * 60 * 60;

/** Does the expression parse at all? Used wherever an already-saved schedule is read, so one that predates the minimum keeps working. */
function parses(cron: string | undefined | null): boolean {
  if (!cron || !cron.trim()) return false;
  try {
    cronParser.parseExpression(cron, { utc: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The shortest gap between two fire times of a day, wrapping past midnight. Read
 * from the hour / minute / second fields, so it also catches a schedule that
 * fires closely only on some days (`*\/5 * 1 1 *`).
 */
function shortestGapMs(cron: string): number {
  const fields = cronParser.parseExpression(cron, { utc: true }).fields as unknown as {
    second: number[];
    minute: number[];
    hour: number[];
  };
  const times: number[] = [];
  for (const h of fields.hour) {
    for (const m of fields.minute) {
      for (const s of fields.second) times.push(h * 3600 + m * 60 + s);
    }
  }
  times.sort((a, b) => a - b);
  if (times.length < 2) return DAY_SECONDS * 1000;
  let min = DAY_SECONDS - times[times.length - 1] + times[0];
  for (let i = 1; i < times.length; i += 1) min = Math.min(min, times[i] - times[i - 1]);
  return min * 1000;
}

/**
 * Save-time check of a schedule: a valid expression that fires at most every 15
 * minutes. Only saving refuses a faster one; `isDue` / `computeNextRun` keep
 * honouring a schedule that was saved before the minimum existed. With
 * `minInterval: false` only the expression itself is checked (a schedule that is
 * switched off).
 */
export function validateCron(
  cron: string | undefined | null,
  options: { minInterval?: boolean } = {},
): string | null {
  if (!cron || !cron.trim()) return 'cron expression is required';
  try {
    cronParser.parseExpression(cron, { utc: true });
  } catch (err) {
    return `invalid cron expression: ${(err as Error).message}`;
  }
  if (options.minInterval === false) return null;
  try {
    if (shortestGapMs(cron) < MIN_SCHEDULE_INTERVAL_MS) {
      return 'a scan cannot be scheduled more often than every 15 minutes';
    }
  } catch {
    // A shape the field read cannot handle is left to the parser's verdict above.
  }
  return null;
}

/** Next fire time at or after `from` (honouring `lastRunAt`), or null. */
export function computeNextRun(
  schedule: RedTeamSchedule | undefined | null,
  lastRunAt: Date | null,
  from: Date = new Date(),
): Date | null {
  if (!schedule || !schedule.enabled || !parses(schedule.cron)) return null;
  let reference = from;
  if (lastRunAt && lastRunAt.getTime() > reference.getTime()) reference = lastRunAt;
  try {
    return cronParser.parseExpression(schedule.cron, { utc: true, currentDate: reference }).next().toDate();
  } catch {
    return null;
  }
}

/**
 * Is the schedule due to fire now? True when the most recent cron slot at or
 * before `now` is newer than `lastRunAt` (or it has never run).
 */
export function isDue(
  schedule: RedTeamSchedule | undefined | null,
  lastRunAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!schedule || !schedule.enabled || !parses(schedule.cron)) return false;
  try {
    const prev = cronParser.parseExpression(schedule.cron, { utc: true, currentDate: now }).prev().toDate();
    if (prev.getTime() > now.getTime()) return false;
    if (!lastRunAt) return true;
    return prev.getTime() > lastRunAt.getTime();
  } catch {
    return false;
  }
}

/**
 * The cron slot `isDue` is judging: the latest one at or before `now`. Its ISO
 * minute names the slot in the database claim that lets one replica fire it.
 */
export function latestSlot(schedule: RedTeamSchedule | undefined | null, now: Date = new Date()): Date | null {
  if (!schedule || !parses(schedule.cron)) return null;
  try {
    const prev = cronParser.parseExpression(schedule.cron, { utc: true, currentDate: now }).prev().toDate();
    return prev.getTime() > now.getTime() ? null : prev;
  } catch {
    return null;
  }
}
