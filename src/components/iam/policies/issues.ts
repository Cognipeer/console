/**
 * Which compile warnings mean "this rule can never match a request" (saving it
 * would change nothing), as opposed to advice about a rule that does work.
 * Pure (no React); covered by unit tests.
 */

import type { ValidationDetail } from '../api';

/** Warning codes the compiler uses for a rule no request can ever match. */
export const INERT_WARNING_CODES: readonly string[] = [
  'not_enforced_actions',
  'not_enforced_resources',
  'not_enforced_channel',
  'not_asked_actions',
];

/** The compiler's own English wording, for a warning that has no code. */
const NEVER_APPLIES = /\bnever (apply|grant|block)\b/i;

export function isInertWarning(warning: Pick<ValidationDetail, 'code' | 'message'>): boolean {
  if (warning.code) return INERT_WARNING_CODES.includes(warning.code);
  return NEVER_APPLIES.test(warning.message);
}

export function splitWarnings(warnings: readonly ValidationDetail[]): {
  inert: ValidationDetail[];
  other: ValidationDetail[];
} {
  return {
    inert: warnings.filter(isInertWarning),
    other: warnings.filter((w) => !isInertWarning(w)),
  };
}
