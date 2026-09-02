/**
 * Review finding #2 — PII policy `customPatterns` ran with NO ReDoS budget.
 *
 * `IPiiPolicy.customPatterns[].pattern` is tenant-authored, compiled with a
 * bare `new RegExp` and swept on the main thread from `scanWithPolicy`, which
 * the `pii` guardrail family calls on the request path — once for the whole
 * subject and again per segment in the obfuscation pass. No source cap, no
 * input cap, no timeout.
 *
 * The fix: custom patterns sweep through the regex family's bounded executor
 * with ONE budget shared across every `detect()` call under a
 * `withCustomPatternBudget`; the source is capped at compile time (512 chars,
 * the same cap a `regex` rule has); and what could not run reaches the family,
 * which reports the policy DEGRADED.
 */

import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  scanWithPolicy: vi.fn(),
}));

// The family reads its PII policy through the service; the test stands in for
// the policy READ and hands the text to the real detector, so what is under
// test is the detector's sweep and the family's reporting, not a database.
vi.mock('@/lib/services/pii/piiService', () => ({ scanWithPolicy: hoisted.scanWithPolicy }));
vi.mock('@/lib/database', () => ({
  runWithTenantScope: (_tenantDbName: string, fn: () => unknown) => fn(),
}));

import type { IPiiCustomPattern } from '@/lib/database';
import { runPiiPolicy } from '@/lib/services/guardrail/families/pii';
import { textSubject } from '@/lib/services/guardrail/hooks/contract';
import type { HookScope, PiiPolicyConfig } from '@/lib/services/guardrail/hooks/contract';
import {
  MAX_CUSTOM_PATTERN_SOURCE_CHARS,
  detect,
  explainCustomPatternError,
  withCustomPatternBudget,
} from '@/lib/services/pii/detector';

const CATASTROPHIC = '(a+)+$';
const ATTACK_INPUT = `${'a'.repeat(29)}!`;
const MAX_ELAPSED_MS = 500;

function custom(overrides: Partial<IPiiCustomPattern> & { pattern: string }): IPiiCustomPattern {
  return {
    id: overrides.id ?? 'p1',
    categoryId: overrides.categoryId ?? 'custom_id',
    label: overrides.label ?? 'Custom',
    enabled: true,
    ...overrides,
  };
}

const EVIL = custom({ id: 'evil', categoryId: 'evil', pattern: CATASTROPHIC });
const ORDER = custom({ id: 'order', categoryId: 'order_id', pattern: 'CUS-\\d{5}', severity: 'medium' });

const scope: HookScope = {
  tenantId: 'tenant-a',
  tenantDbName: 't_tenant_a',
  actor: { id: 'u1', kind: 'user', roles: [] },
  surface: 'api',
  source: 'unit-test',
  traceId: 'trace-pii-redos',
};

function policy(overrides: Partial<PiiPolicyConfig> = {}): PiiPolicyConfig {
  return {
    id: 'pii-1',
    family: 'pii',
    enabled: true,
    hooks: ['input.pre'],
    schedule: { timing: 'sync', onFail: 'block' },
    piiPolicyKey: 'hr-policy',
    detectObfuscated: false,
    ...overrides,
  } as PiiPolicyConfig;
}

/** `scanWithPolicy` stand-in: the real detector over the given custom patterns. */
function serveCustomPatterns(patterns: IPiiCustomPattern[]): void {
  hoisted.scanWithPolicy.mockImplementation(
    async (params: { text: string; actionOverride?: 'detect' | 'redact' | 'mask' | 'block' | 'tokenize' }) => ({
      findings: detect(params.text, { categories: {}, customPatterns: patterns }, params.actionOverride ?? 'detect'),
    }),
  );
}

describe('pii detector: a catastrophic custom pattern is cut off, not waited on', () => {
  it('detect() returns within the budget instead of hanging', () => {
    const started = Date.now();
    const findings = detect(ATTACK_INPUT, { categories: {}, customPatterns: [EVIL] });
    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
    expect(findings).toHaveLength(0);
  });

  it('reports the pattern it could not finish through withCustomPatternBudget', async () => {
    const { skipped } = await withCustomPatternBudget(async () =>
      detect(ATTACK_INPUT, { categories: {}, customPatterns: [EVIL] }),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.patternId).toBe('evil');
    expect(skipped[0]?.reason).toMatch(/backtrack/i);
  });

  it('ONE budget covers every detect() under the wrapper — segments cannot each buy a stall', async () => {
    const started = Date.now();
    const { skipped } = await withCustomPatternBudget(async () => {
      for (let segment = 0; segment < 6; segment += 1) {
        detect(ATTACK_INPUT, { categories: {}, customPatterns: [EVIL] });
      }
    });
    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
    // Six calls, six reports: the ones that ran out of time and the ones that
    // never started because the shared budget was already spent.
    expect(skipped).toHaveLength(6);
    expect(skipped.map((s) => s.reason).join(' | ')).toMatch(/budget|backtrack/i);
  });

  it('rejects a pattern source over 512 characters at compile time', async () => {
    const long = custom({ id: 'long', categoryId: 'long', pattern: 'x'.repeat(MAX_CUSTOM_PATTERN_SOURCE_CHARS + 1) });
    expect(MAX_CUSTOM_PATTERN_SOURCE_CHARS).toBe(512);
    // The validator the save path can call says the same thing the scan does.
    expect(explainCustomPatternError(long)).toMatch(/512/);
    expect(explainCustomPatternError(ORDER)).toBeNull();

    // Without the cap this would match: the text IS the pattern.
    const { result, skipped } = await withCustomPatternBudget(async () =>
      detect('x'.repeat(MAX_CUSTOM_PATTERN_SOURCE_CHARS + 1), { categories: {}, customPatterns: [long] }),
    );
    expect(result).toHaveLength(0);
    expect(skipped[0]?.reason).toMatch(/512/);
  });

  it('still finds benign custom patterns with correct offsets and source', () => {
    const text = 'Order CUS-12345 then CUS-67890 for pickup';
    const findings = detect(text, { categories: {}, customPatterns: [ORDER] });
    expect(findings.map((f) => f.value)).toEqual(['CUS-12345', 'CUS-67890']);
    for (const f of findings) {
      expect(text.slice(f.start, f.end)).toBe(f.value);
      expect(f.source).toBe('custom');
      expect(f.category).toBe('order_id');
    }
  });
});

describe('pii family: a custom pattern that could not run degrades the policy', () => {
  it('reports DEGRADED within the budget on a catastrophic pattern', async () => {
    serveCustomPatterns([EVIL]);
    const started = Date.now();
    const result = await runPiiPolicy({
      policy: policy(),
      subject: textSubject(ATTACK_INPUT),
      hook: 'input.pre',
      scope,
      action: 'block',
    });

    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
    expect(result.findings).toHaveLength(0);
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded?.[0]?.family).toBe('pii');
    expect(result.degraded?.[0]?.reason).toMatch(/custom pattern "evil"/);
    expect(result.degraded?.[0]?.reason).toMatch(/budget|backtrack/i);
  });

  it('a benign custom pattern still yields findings and no degradation', async () => {
    serveCustomPatterns([ORDER]);
    const result = await runPiiPolicy({
      policy: policy(),
      subject: textSubject('Order CUS-12345 for pickup'),
      hook: 'input.pre',
      scope,
      action: 'redact',
    });

    expect(result.degraded).toBeUndefined();
    expect(result.findings.map((f) => f.category)).toEqual(['order_id']);
    expect(result.mutations).toEqual([
      expect.objectContaining({ op: 'replace_span', path: '/text', start: 6, end: 15 }),
    ]);
  });
});
