/**
 * Regression — A REGEX RULE MUST NOT BE ABLE TO FREEZE THE PROCESS.
 *
 * The load-behaviour measurement found the one way a single request could take
 * every tenant on a pod down with it. An operator-authored rule is compiled and
 * run synchronously on the request path, and none of the three bounds the file
 * advertised measured the thing that actually blows up:
 *
 *   · `DEFAULT_MAX_REGEX_INPUT_CHARS` (262,144) bounds the INPUT. Measured: the
 *     stall reached 10.7 s at 29 characters — 0.011% of that ceiling.
 *   · `maxMatchChars` only ever produced the `overDeclaredBound` boolean, AFTER
 *     a match returned. Measured with the strictest legal value, 1.
 *   · `DEFAULT_MAX_MATCHES_PER_RULE` (1,000) counts SUCCESSFUL matches, so an
 *     `exec` that never returns never reaches it.
 *
 * With `(a+)+$` and a 29-character input, one request held the event loop for
 * 10.7 seconds and an unrelated tenant's request behind it waited 45.4 s. The
 * fix is a wall-clock budget enforced inside a V8 context, which is the only
 * thing that can interrupt a regex — a hung engine never throws, it just never
 * returns, so no try/catch and no post-hoc length check can help.
 *
 * These tests are deliberately CHEAP: each asserts that the budget fires, not
 * how long the pathological case would otherwise take. Measuring the 10.7 s is
 * what the load round was for; re-measuring it on every CI run is not.
 */

import { describe, it, expect } from 'vitest';
import {
  scanRegexRules,
  DEFAULT_REGEX_BUDGET_MS,
  DEFAULT_MAX_MATCHES_PER_RULE,
} from '@/lib/services/guardrail/families/regex';
import type { GuardrailRegexRule } from '@/lib/database';

/** A stored rule, with only the fields a given test cares about spelled out. */
function rule(overrides: Partial<GuardrailRegexRule> & { pattern: string }): GuardrailRegexRule {
  return {
    id: overrides.id ?? 'r',
    label: overrides.label ?? overrides.id ?? 'r',
    category: 'custom',
    severity: 'medium',
    maxMatchChars: 256,
    ...overrides,
  } as GuardrailRegexRule;
}

/** The classic nested quantifier, and the exact shape the measurement used. */
const CATASTROPHIC = '(a+)+$';

/** 29 'a's then a '!' — the '!' is what forces the engine to backtrack. */
const ATTACK_INPUT = `${'a'.repeat(29)}!`;

describe('regex family: a pathological rule is cut off, not waited on', () => {
  it('a catastrophic pattern returns within the budget instead of hanging', () => {
    const started = Date.now();
    const outcome = scanRegexRules(ATTACK_INPUT, [
      rule({ id: 'evil', pattern: CATASTROPHIC, maxMatchChars: 1 }),
    ]);
    const elapsed = Date.now() - started;

    // The real assertion. Without the budget this call took 10.7 SECONDS.
    // The ceiling is generous (10x the budget) because CI machines are slow
    // and the point is the order of magnitude, not the millisecond.
    expect(elapsed).toBeLessThan(DEFAULT_REGEX_BUDGET_MS * 10);

    // It reports rather than silently passing: a rule that could not finish
    // must reach the operator, or a guardrail quietly stops guarding.
    expect(outcome.matches).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]?.ruleId).toBe('evil');
    expect(outcome.skipped[0]?.reason).toMatch(/backtrack/i);
  });

  it('the stall does not scale with input length — 200 chars is bounded too', () => {
    const started = Date.now();
    const outcome = scanRegexRules(`${'a'.repeat(200)}!`, [
      rule({ id: 'evil', pattern: CATASTROPHIC }),
    ]);

    expect(Date.now() - started).toBeLessThan(DEFAULT_REGEX_BUDGET_MS * 10);
    expect(outcome.skipped).toHaveLength(1);
  });

  it('one bad rule does not buy the whole list a fresh budget each', () => {
    // Six pathological rules would be six budgets if the bound were per-rule.
    const rules = Array.from({ length: 6 }, (_, i) =>
      rule({ id: `evil-${i}`, pattern: CATASTROPHIC }),
    );

    const started = Date.now();
    const outcome = scanRegexRules(ATTACK_INPUT, rules);
    const elapsed = Date.now() - started;

    // ONE budget for the list, so six rules cost about what one does — not 6x.
    expect(elapsed).toBeLessThan(DEFAULT_REGEX_BUDGET_MS * 10);
    // Every rule is accounted for: the ones that ran and timed out, and the
    // ones that never got to run. Silence about a rule is the failure mode.
    expect(outcome.skipped).toHaveLength(6);
    const reasons = outcome.skipped.map((s) => s.reason).join(' | ');
    expect(reasons).toMatch(/backtrack/i);
    expect(reasons).toMatch(/budget/i);
  });
});

describe('regex family: the budget does not change what benign rules do', () => {
  const EMAIL = rule({ id: 'email', pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+' });

  it('finds every match with correct spans', () => {
    const text = 'write to a@corp.com or b@corp.com please';
    const { matches, skipped } = scanRegexRules(text, [EMAIL]);

    expect(skipped).toHaveLength(0);
    expect(matches.map((m) => m.value)).toEqual(['a@corp.com', 'b@corp.com']);
    // Spans must still point at the ORIGINAL string — the sweep now runs in a
    // V8 context and returns plain objects, so the offsets crossing that
    // boundary is exactly what could have broken.
    for (const m of matches) {
      expect(text.slice(m.start, m.end)).toBe(m.value);
      expect(text.slice(m.matchStart, m.matchEnd)).toBe(m.value);
    }
  });

  it('honours captureGroup, so `Bearer (\\S+)` redacts only the token', () => {
    const text = 'Authorization: Bearer sk-abc123';
    const { matches } = scanRegexRules(text, [
      rule({ id: 'bearer', pattern: 'Bearer (\\S+)', captureGroup: 1 }),
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe('sk-abc123');
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('sk-abc123');
    // The whole match still spans "Bearer sk-abc123", which is what the
    // finding reports even though the redaction is narrower.
    expect(text.slice(matches[0]!.matchStart, matches[0]!.matchEnd)).toBe('Bearer sk-abc123');
  });

  it('falls back to the whole match when the capture group did not participate', () => {
    const { matches } = scanRegexRules('xyz', [
      rule({ id: 'alt', pattern: '(?:(abc)|xyz)', captureGroup: 1 }),
    ]);
    // Redacting more than asked is safe; reporting a finding and redacting
    // nothing is the verdict-without-enforcement failure the contract forbids.
    expect(matches[0]?.value).toBe('xyz');
  });

  it('still advances past a zero-length match instead of spinning', () => {
    // `\b|x` matches empty at every boundary. Before the rewrite this was
    // handled by a manual lastIndex bump; that guard had to survive the move
    // into the V8 context, and this is what proves it did.
    const { matches, skipped } = scanRegexRules('ax bx', [
      rule({ id: 'zero', pattern: '\\b|x' }),
    ]);

    expect(skipped.some((s) => /backtrack/i.test(s.reason))).toBe(false);
    expect(matches.every((m) => m.end > m.start)).toBe(true);
    expect(matches.map((m) => m.value)).toEqual(['x', 'x']);
  });

  it('still caps at maxMatchesPerRule and says so', () => {
    const { matches, skipped } = scanRegexRules('a'.repeat(50), [
      rule({ id: 'many', pattern: 'a' }),
    ], { maxMatchesPerRule: 10 });

    expect(matches).toHaveLength(10);
    expect(skipped[0]?.reason).toBe('stopped after 10 matches');
  });

  it('the shipped rule shapes stay far under budget on a large input', () => {
    // The measurement's baseline: the rules this product actually ships take
    // p50 1.4ms on a 262,144-character input. If this ever approaches the
    // budget, the budget is wrong — not the rules.
    const text = `${'lorem ipsum dolor sit amet '.repeat(4000)}a@corp.com`;
    const started = Date.now();
    const { matches, skipped } = scanRegexRules(text, [
      EMAIL,
      rule({ id: 'iban', pattern: 'TR\\d{24}' }),
      rule({ id: 'tckn', pattern: '\\b[1-9]\\d{10}\\b' }),
    ]);

    expect(Date.now() - started).toBeLessThan(DEFAULT_REGEX_BUDGET_MS);
    expect(skipped).toHaveLength(0);
    expect(matches.map((m) => m.value)).toEqual(['a@corp.com']);
  });

  it('exports the bounds it claims to enforce', () => {
    expect(DEFAULT_REGEX_BUDGET_MS).toBe(50);
    expect(DEFAULT_MAX_MATCHES_PER_RULE).toBe(1_000);
  });
});
