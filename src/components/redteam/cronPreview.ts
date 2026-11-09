/**
 * Schedule checks for the campaign form: whether a cron expression is accepted
 * and when it fires next. `validateCron` is the same function the server runs at
 * save time (schedulePlanner.ts only depends on cron-parser, so it is safe in
 * the browser), so the form and the API agree on what is acceptable.
 */

import cronParser from 'cron-parser';
import { validateCron } from '@/lib/services/redteam/schedulePlanner';

/** An error message for the cron field, or null when the expression is accepted. */
export function cronError(cron: string): string | null {
  return validateCron(cron);
}

/** The next `count` fire times (UTC), or [] for an expression that does not parse. */
export function nextFireTimes(cron: string, count = 3, from: Date = new Date()): Date[] {
  if (validateCron(cron)) return [];
  try {
    const it = cronParser.parseExpression(cron, { utc: true, currentDate: from });
    const out: Date[] = [];
    for (let i = 0; i < count; i += 1) out.push(it.next().toDate());
    return out;
  } catch {
    return [];
  }
}

/** `2026-11-10 03:00 UTC` */
export function formatFireTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
