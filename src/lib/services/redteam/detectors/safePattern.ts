/**
 * Bounded pattern matching for red-team detectors.
 *
 * A forbidden pattern is a regex source when it compiles and a literal
 * substring otherwise, matched without regard to case either way. Patterns
 * can come from a custom probe a user wrote, so a regex runs inside a `vm`
 * script with a time budget: the watchdog stops a match that takes too long
 * and the pattern counts as "could not decide" rather than as a hit. One
 * attempt's patterns share a total budget, so many slow patterns cannot add up.
 */

import vm from 'node:vm';

/** Time a single regex may run against one attempt's output. */
export const PATTERN_TIMEOUT_MS = 50;
/** Time all of one attempt's regex patterns may use together. */
export const PATTERN_TOTAL_BUDGET_MS = 200;
/** Limits for patterns a user stores on a custom probe. */
export const MAX_PATTERN_LENGTH = 300;
export const MAX_PATTERNS_PER_ATTEMPT = 20;

export type PatternOutcome = 'hit' | 'miss' | 'timeout';

type Compiled = { kind: 'regex'; re: RegExp } | { kind: 'literal'; needle: string };

function compile(pattern: string): Compiled {
  try {
    return { kind: 'regex', re: new RegExp(pattern, 'i') };
  } catch {
    return { kind: 'literal', needle: pattern.toLowerCase() };
  }
}

// One context and one compiled script, reused: a call sets the two globals and
// runs synchronously, so concurrent attempts cannot interleave inside it.
const context = vm.createContext(Object.create(null) as Record<string, unknown>);
const testScript = new vm.Script('re.test(s)');

function regexTest(re: RegExp, haystack: string, timeoutMs: number): PatternOutcome {
  context.re = re;
  context.s = haystack;
  try {
    return testScript.runInContext(context, { timeout: Math.max(1, Math.floor(timeoutMs)) }) ? 'hit' : 'miss';
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout';
    throw error;
  } finally {
    context.re = undefined;
    context.s = undefined;
  }
}

/** Match one pattern against the text, within `timeoutMs` for a regex. */
export function matchPattern(haystack: string, pattern: string, timeoutMs = PATTERN_TIMEOUT_MS): PatternOutcome {
  const compiled = compile(pattern);
  if (compiled.kind === 'literal') return haystack.toLowerCase().includes(compiled.needle) ? 'hit' : 'miss';
  return regexTest(compiled.re, haystack, timeoutMs);
}

export interface PatternScan {
  /** The first pattern that matched, if any. */
  matched?: string;
  /** Patterns that ran out of time (or were skipped once the budget was spent). */
  undecided: string[];
}

/**
 * Check a list of patterns in order and stop at the first match. Patterns that
 * time out, and the ones left once the total budget is spent, are reported as
 * undecided instead of being silently treated as misses.
 */
export function scanPatterns(
  haystack: string,
  patterns: readonly string[],
  budget: { perPatternMs?: number; totalMs?: number } = {},
): PatternScan {
  const perPattern = budget.perPatternMs ?? PATTERN_TIMEOUT_MS;
  let remaining = budget.totalMs ?? PATTERN_TOTAL_BUDGET_MS;
  const undecided: string[] = [];
  for (const pattern of patterns) {
    if (remaining <= 0) {
      undecided.push(pattern);
      continue;
    }
    const started = performance.now();
    const outcome = matchPattern(haystack, pattern, Math.min(perPattern, remaining));
    remaining -= performance.now() - started;
    if (outcome === 'hit') return { matched: pattern, undecided };
    if (outcome === 'timeout') undecided.push(pattern);
  }
  return { undecided };
}

/** Why a stored pattern list is not acceptable, or null when it is. */
export function patternListError(patterns: readonly string[]): string | null {
  if (patterns.length > MAX_PATTERNS_PER_ATTEMPT) {
    return `an attempt can have at most ${MAX_PATTERNS_PER_ATTEMPT} forbidden patterns`;
  }
  const tooLong = patterns.find((p) => p.length > MAX_PATTERN_LENGTH);
  if (tooLong !== undefined) {
    return `a forbidden pattern can be at most ${MAX_PATTERN_LENGTH} characters`;
  }
  return null;
}
