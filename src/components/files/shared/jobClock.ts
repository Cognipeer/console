/**
 * When a background job that the server keeps no heartbeat for is taken for lost. A Markdown conversion and a
 * "delete the bucket with its files" run are queued in the server's memory (outside a clustered queue), so a restart
 * drops them and leaves the record `pending`, or the bucket `deleting`, for good. The screens cannot tell a lost job
 * from a slow one, but the record carries the time it was asked for, and asking again is safe at any moment: a
 * conversion only runs for a record that is still pending, and a deletion repeats nothing that matters. So after this
 * long a screen offers "Convert again" / "Delete again" next to the waiting state.
 */

/** A bucket `deleting` for this long was most likely lost. A big bucket can take longer: asking again is harmless. */
export const DELETE_STALLED_AFTER_MS = 5 * 60_000;
/** A file `pending` for this long was most likely lost (a conversion takes seconds, a long queue a few minutes). */
export const MARKDOWN_STALLED_AFTER_MS = 5 * 60_000;

/** An instant the server sent (an ISO string, a number or a Date) as milliseconds; null when it is none. */
export function timeOf(value: unknown): number | null {
  if (value instanceof Date) {
    const at = value.getTime();
    return Number.isNaN(at) ? null : at;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const at = new Date(value).getTime();
    return Number.isNaN(at) ? null : at;
  }
  return null;
}

/** Whether `since` is at least `thresholdMs` before `now`. Not known, or in the future (a clock that is behind): no. */
export function isQuietFor(since: unknown, thresholdMs: number, now: number): boolean {
  const at = timeOf(since);
  return at !== null && now - at >= thresholdMs;
}
