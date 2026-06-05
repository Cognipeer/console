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

export function validateCron(cron: string | undefined | null): string | null {
  if (!cron || !cron.trim()) return 'cron expression is required';
  try {
    cronParser.parseExpression(cron, { utc: true });
    return null;
  } catch (err) {
    return `invalid cron expression: ${(err as Error).message}`;
  }
}

/** Next fire time at or after `from` (honouring `lastRunAt`), or null. */
export function computeNextRun(
  schedule: RedTeamSchedule | undefined | null,
  lastRunAt: Date | null,
  from: Date = new Date(),
): Date | null {
  if (!schedule || !schedule.enabled || validateCron(schedule.cron)) return null;
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
  if (!schedule || !schedule.enabled || validateCron(schedule.cron)) return false;
  try {
    const prev = cronParser.parseExpression(schedule.cron, { utc: true, currentDate: now }).prev().toDate();
    if (prev.getTime() > now.getTime()) return false;
    if (!lastRunAt) return true;
    return prev.getTime() > lastRunAt.getTime();
  } catch {
    return false;
  }
}
