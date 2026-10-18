/**
 * Pure helpers for the crawler scheduler.
 *
 * - `computeNextRun(schedule, from)`     – next fire time, honouring window
 * - `isDue(schedule, now)`               – is the schedule ready to fire?
 * - `dueSlot(schedule, now)`              – the due slot id (claim-key suffix) or null
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

/**
 * The slot that is due right now, as a stable identifier, or `null`.
 *
 * - cron: the latest slot at or before `now` (`prev()`), due when it is after
 *   the last run (else `startAt`, else `since` — the crawler's creation; with
 *   none of the three nothing is due) and inside the startAt/endAt window. `computeNextRun` is strictly
 *   after `now`, so it can never express "due"; that is why cron never fired.
 * - interval: due once `lastRunAt + interval` has passed (or never ran). The
 *   id is derived from `lastRunAt`, so replicas deciding from the same
 *   persisted state compute the same id.
 *
 * The id is the claim-key suffix (`claimSchedulerSlot`) that makes dispatch
 * exactly-once across replicas.
 */
export function dueSlot(
  schedule: ICrawlerSchedule | undefined | null,
  now: Date = new Date(),
  since?: Date | string,
): string | null {
  if (!schedule || !schedule.enabled) return null;
  if (validateSchedule(schedule)) return null;

  const startAt = asDate(schedule.startAt);
  const endAt = asDate(schedule.endAt);
  const lastRun = asDate(schedule.lastRunAt);

  if (schedule.mode === 'interval') {
    const next = computeNextRun(schedule, now);
    if (!next || next.getTime() > now.getTime()) return null;
    return lastRun ? `after-${lastRun.toISOString()}` : 'first';
  }

  let slot: Date;
  try {
    slot = cronParser
      // +1 ms: prev() is strictly before currentDate, so a tick landing exactly on a slot would otherwise see the previous one.
      .parseExpression(schedule.cron ?? '', { utc: true, currentDate: new Date(now.getTime() + 1) })
      .prev()
      .toDate();
  } catch {
    return null;
  }
  if (slot.getTime() > now.getTime()) return null;
  if (startAt && slot.getTime() < startAt.getTime()) return null;
  if (endAt && slot.getTime() > endAt.getTime()) return null;
  // Without any baseline we cannot tell a new slot from one that predates the
  // schedule, so it is not due (callers pass `since`, the crawler's creation).
  const floor = lastRun ?? startAt ?? asDate(since);
  if (!floor) return null;
  if (slot.getTime() <= floor.getTime()) {
    // startAt is inclusive: a slot exactly at startAt with no run yet is due.
    const startSlotUnrun = !lastRun && startAt !== null && slot.getTime() === startAt.getTime();
    if (!startSlotUnrun) return null;
  }
  return slot.toISOString();
}

/** Convenience: is the schedule due to fire right now? */
export function isDue(
  schedule: ICrawlerSchedule | undefined | null,
  now: Date = new Date(),
  since?: Date | string,
): boolean {
  return dueSlot(schedule, now, since) !== null;
}
