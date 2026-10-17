/**
 * Time arithmetic of routine triggers — pure (no database, no Node APIs), so
 * the Studio editor previews a schedule with exactly the code the scheduler
 * fires it with.
 *
 * A schedule is a 5-field cron expression evaluated in an IANA timezone, so
 * "09:00 on weekdays" stays 09:00 local across daylight-saving changes (a
 * local time a spring-forward skips fires at the first valid time after it; one
 * a fall-back repeats fires once).
 */

import cronParser from 'cron-parser';

export const DEFAULT_ROUTINE_TIMEZONE = 'UTC';

let knownZones: Set<string> | null = null;

/** An IANA timezone the runtime knows (`UTC` is accepted although `Intl` lists it only as `Etc/UTC`). */
export function isValidRoutineTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (value === 'UTC') return true;
  if (!knownZones) {
    try {
      knownZones = new Set(Intl.supportedValuesOf('timeZone'));
    } catch {
      knownZones = new Set();
    }
  }
  return knownZones.has(value);
}

/** Null when `cron` is a valid 5-field expression, else why not. */
export function validateRoutineCron(cron: unknown): string | null {
  if (typeof cron !== 'string' || cron.trim() === '') return 'cron is required';
  const fields = cron.trim().split(/\s+/);
  // cron-parser also takes a seconds field; a routine fires on minutes.
  if (fields.length !== 5) return 'cron must have 5 fields (minute hour day-of-month month day-of-week)';
  try {
    cronParser.parseExpression(cron.trim(), { tz: DEFAULT_ROUTINE_TIMEZONE });
  } catch (error) {
    return `invalid cron expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/** The first slot strictly after `after`, or null for an expression that cannot be evaluated. */
export function nextCronFire(cron: string, timezone: string, after: Date): Date | null {
  try {
    return cronParser.parseExpression(cron.trim(), { tz: timezone, currentDate: after }).next().toDate();
  } catch {
    return null;
  }
}

/** The next `count` slots after `after` (the editor's preview). */
export function upcomingCronFires(cron: string, timezone: string, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i += 1) {
    const next = nextCronFire(cron, timezone, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** The latest slot at or before `at`, or null. */
export function latestCronSlot(cron: string, timezone: string, at: Date): Date | null {
  try {
    // +1 ms: prev() is strictly before currentDate, so a tick landing exactly on a slot would see the previous one.
    return cronParser.parseExpression(cron.trim(), { tz: timezone, currentDate: new Date(at.getTime() + 1) }).prev().toDate();
  } catch {
    return null;
  }
}

type TimedTrigger =
  | { type: 'schedule'; cron: string; timezone: string }
  | { type: 'once'; runAt: Date }
  | { type: string };

/**
 * `nextFireAt` for a routine saved now: the first cron slot after `now`; a
 * once trigger's time until it has fired; null for anything else (manual, a
 * disabled routine, a finished once). A once time already past is still
 * returned: the scheduler fires it within the misfire grace, else skips it.
 */
export function initialNextFireAt(
  routine: { enabled: boolean; trigger: TimedTrigger; lastFireAt?: Date | null },
  now: Date,
): Date | null {
  if (!routine.enabled) return null;
  const trigger = routine.trigger;
  if (trigger.type === 'schedule' && 'cron' in trigger) return nextCronFire(trigger.cron, trigger.timezone, now);
  if (trigger.type === 'once' && 'runAt' in trigger) {
    // Fired = a fire at (or after) its time; a Run now before it does not count.
    const runAt = new Date(trigger.runAt);
    return routine.lastFireAt && new Date(routine.lastFireAt).getTime() >= runAt.getTime() ? null : runAt;
  }
  return null;
}

export type DueRoutinePlan =
  /** Fire `fireAt` (the latest due slot; older missed ones are skipped) and move on to `next`. */
  | { kind: 'fire'; fireAt: Date; next: Date | null }
  /** The due slot is older than the misfire grace: no run; move on to `next`. */
  | { kind: 'missed'; slot: Date; next: Date | null };

/**
 * What the scheduler does with a routine whose `nextFireAt` is due. At most one
 * catch-up run: of several missed slots only the latest fires, and only while
 * it is younger than `graceMs`.
 */
export function planDueRoutine(trigger: TimedTrigger, dueAt: Date, now: Date, graceMs: number): DueRoutinePlan {
  if (trigger.type === 'schedule' && 'cron' in trigger) {
    const next = nextCronFire(trigger.cron, trigger.timezone, now);
    const latest = latestCronSlot(trigger.cron, trigger.timezone, now) ?? dueAt;
    const slot = latest.getTime() < dueAt.getTime() ? dueAt : latest;
    if (now.getTime() - slot.getTime() > graceMs) return { kind: 'missed', slot, next };
    return { kind: 'fire', fireAt: slot, next };
  }
  const slot = trigger.type === 'once' && 'runAt' in trigger ? new Date(trigger.runAt) : dueAt;
  if (now.getTime() - slot.getTime() > graceMs) return { kind: 'missed', slot, next: null };
  return { kind: 'fire', fireAt: slot, next: null };
}
