/**
 * Pure helpers for the crawler scheduler.
 *
 * - `computeNextRun(schedule, from)`     – next fire time, honouring window
 * - `isDue(schedule, now)`               – is the schedule ready to fire?
 * - `validateSchedule(schedule)`         – returns an error message or null
 *
 * Kept side-effect free so unit tests can exercise edge cases without
 * touching the DB or queue.
 */

import cronParser from 'cron-parser';
import type { ICrawlerSchedule } from '@/lib/database';

const MIN_INTERVAL_SECONDS = 60;

export function validateSchedule(schedule: ICrawlerSchedule | undefined | null): string | null {
  if (!schedule) return null;
  if (!schedule.enabled) return null;
  if (schedule.mode === 'interval') {
    if (!Number.isFinite(schedule.intervalSeconds) || (schedule.intervalSeconds ?? 0) < MIN_INTERVAL_SECONDS) {
      return `intervalSeconds must be >= ${MIN_INTERVAL_SECONDS}`;
    }
    return null;
  }
  if (schedule.mode === 'cron') {
    if (!schedule.cron || !schedule.cron.trim()) {
      return 'cron expression is required';
    }
    try {
      cronParser.parseExpression(schedule.cron, { utc: true });
    } catch (err) {
      return `invalid cron expression: ${(err as Error).message}`;
    }
    return null;
  }
  return `unknown schedule mode: ${(schedule as { mode: string }).mode}`;
}

function asDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Compute the next scheduled fire time.
 *
 * Semantics:
 *  - If `lastRunAt` is set, the next fire is strictly after it (so we don't
 *    re-fire the same tick).
 *  - Otherwise the next fire is the first slot at or after `startAt`
 *    (defaults to `from`).
 *  - Returns `null` if the schedule is disabled, invalid, or past `endAt`.
 */
export function computeNextRun(
  schedule: ICrawlerSchedule | undefined | null,
  from: Date = new Date(),
): Date | null {
  if (!schedule || !schedule.enabled) return null;
  if (validateSchedule(schedule)) return null;

  const startAt = asDate(schedule.startAt);
  const endAt = asDate(schedule.endAt);
  const lastRun = asDate(schedule.lastRunAt);

  // Reference: where we start searching from.
  let reference = from;
  if (lastRun && lastRun.getTime() > reference.getTime()) reference = lastRun;
  if (startAt && startAt.getTime() > reference.getTime()) reference = startAt;

  let candidate: Date;
  if (schedule.mode === 'interval') {
    const intervalMs = (schedule.intervalSeconds ?? MIN_INTERVAL_SECONDS) * 1000;
    if (lastRun) {
      const nextFromLast = new Date(lastRun.getTime() + intervalMs);
      candidate = nextFromLast.getTime() < reference.getTime() ? reference : nextFromLast;
    } else {
      candidate = startAt && startAt.getTime() > from.getTime() ? startAt : from;
    }
  } else {
    try {
      const it = cronParser.parseExpression(schedule.cron ?? '', {
        utc: true,
        currentDate: reference,
      });
      candidate = it.next().toDate();
    } catch {
      return null;
    }
  }

  if (endAt && candidate.getTime() > endAt.getTime()) return null;
  return candidate;
}

/** Convenience: is the schedule due to fire right now? */
export function isDue(
  schedule: ICrawlerSchedule | undefined | null,
  now: Date = new Date(),
): boolean {
  const next = computeNextRun(schedule, now);
  if (!next) return false;
  return next.getTime() <= now.getTime();
}
