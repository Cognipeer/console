/**
 * The identity of one attempt inside a run.
 *
 * An attempt id is unique only within its probe (two probes may both have an
 * attempt `a1`), so a run identifies an attempt by `<probeKey>::<attemptId>`.
 * Probe keys never contain `::` (built-in keys are kebab-case, custom keys are
 * `custom:<slug>`), so the key splits on the first `::`.
 *
 * Pure module with no imports, so client components can use it too.
 */

export const ATTEMPT_KEY_SEPARATOR = '::';

export function attemptKeyOf(attempt: { probeKey: string; attemptId: string }): string {
  return `${attempt.probeKey}${ATTEMPT_KEY_SEPARATOR}${attempt.attemptId}`;
}

export function parseAttemptKey(key: string): { probeKey: string; attemptId: string } | null {
  if (typeof key !== 'string') return null;
  const at = key.indexOf(ATTEMPT_KEY_SEPARATOR);
  if (at <= 0) return null;
  const probeKey = key.slice(0, at);
  const attemptId = key.slice(at + ATTEMPT_KEY_SEPARATOR.length);
  if (!attemptId) return null;
  return { probeKey, attemptId };
}
