/**
 * Forbidden patterns are matched within a time budget: a regex that takes too
 * long stops and is reported as undecided (never as a hit), a pattern that is
 * not a valid regex is matched as a literal without regard to case, and the
 * stored-pattern limits are checked when a custom probe is saved.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS_PER_ATTEMPT,
  matchPattern,
  patternListError,
  scanPatterns,
} from '@/lib/services/redteam/detectors/safePattern';
import { createPatternDetector } from '@/lib/services/redteam/detectors/patternDetector';
import { CustomProbeError, validateCustomProbePatterns } from '@/lib/services/redteam/probes';
import type { DetectorContext } from '@/lib/services/redteam/types';

// Nested quantifiers against a near-miss input: exponential for a backtracking engine.
const SLOW = '(a+)+$';
const SLOW_INPUT = `${'a'.repeat(40)}!`;

function ctx(output: string, forbiddenPatterns: string[], canary?: string): DetectorContext {
  return {
    attempt: { id: 'a1', turns: ['hi'], expect: { forbiddenPatterns, ...(canary ? { canary } : {}) } },
    probe: { key: 'p', family: 'f', category: 'LLM01-prompt-injection', severity: 'high', description: '', detectors: [], generate: () => [] },
    transcript: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: output }],
    finalOutput: output,
    allOutputs: [output],
  } as unknown as DetectorContext;
}

describe('matchPattern', () => {
  it('matches a regex without regard to case', () => {
    expect(matchPattern('Your API_KEY = abc', 'api[_-]?key\\s*=')).toBe('hit');
    expect(matchPattern('nothing here', 'api[_-]?key')).toBe('miss');
  });

  it('matches a pattern that is not a valid regex as a literal, without regard to case', () => {
    expect(matchPattern('Leaked: FOO(BAR', 'foo(bar')).toBe('hit');
    expect(matchPattern('Leaked: foo bar', 'foo(bar')).toBe('miss');
  });

  it('stops a regex that runs past its time budget', () => {
    const started = Date.now();
    expect(matchPattern(SLOW_INPUT, SLOW, 30)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('scanPatterns', () => {
  it('returns the first match', () => {
    expect(scanPatterns('alpha beta', ['gamma', 'BETA', 'alpha'])).toEqual({ matched: 'BETA', undecided: [] });
  });

  it('reports slow patterns as undecided and still finds a later match', () => {
    const scan = scanPatterns(SLOW_INPUT, [SLOW, 'a!'], { perPatternMs: 20, totalMs: 200 });
    expect(scan.matched).toBe('a!');
    expect(scan.undecided).toEqual([SLOW]);
  });

  it('shares one budget across all patterns of an attempt', () => {
    const started = Date.now();
    const scan = scanPatterns(SLOW_INPUT, Array.from({ length: 10 }, () => SLOW), { perPatternMs: 40, totalMs: 100 });
    expect(scan.matched).toBeUndefined();
    expect(scan.undecided).toHaveLength(10);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('pattern detector', () => {
  it('reports a timed-out pattern as an errored signal, not as a hit', () => {
    const signal = createPatternDetector().detect(ctx(SLOW_INPUT, [SLOW])) as ReturnType<ReturnType<typeof createPatternDetector>['detect']> & { error?: string; hit: boolean };
    expect(signal.hit).toBe(false);
    expect(signal.error).toMatch(/time budget/);
  });

  it('still proves a leak by the planted canary', () => {
    const signal = createPatternDetector().detect(ctx('the code is CANARY-123', [SLOW], 'CANARY-123')) as { hit: boolean; confidence: number };
    expect(signal.hit).toBe(true);
    expect(signal.confidence).toBeGreaterThan(0.95);
  });

  it('matches a literal pattern without regard to case', () => {
    const signal = createPatternDetector().detect(ctx('I Have Been PWNED(', ['i have been pwned('])) as { hit: boolean };
    expect(signal.hit).toBe(true);
  });
});

describe('stored pattern limits', () => {
  it('accepts patterns within the limits', () => {
    expect(patternListError(['a', 'b'])).toBeNull();
    expect(() => validateCustomProbePatterns([{ id: 'a1', forbiddenPatterns: ['x'.repeat(MAX_PATTERN_LENGTH)] }])).not.toThrow();
  });

  it('refuses too many patterns or a pattern that is too long', () => {
    expect(patternListError(Array.from({ length: MAX_PATTERNS_PER_ATTEMPT + 1 }, (_, i) => `p${i}`))).toMatch(/at most/);
    expect(() => validateCustomProbePatterns([{ id: 'a1', forbiddenPatterns: ['x'.repeat(MAX_PATTERN_LENGTH + 1)] }]))
      .toThrow(CustomProbeError);
  });
});
