/**
 * Review finding #1 — `word_filter.regexes` ran with NO ReDoS budget.
 *
 * `policy.regexes` is tenant-authored and `POLICY_VALID_HOOKS.word_filter`
 * includes `tool.post`, so attacker-shaped tool output reaches these patterns.
 * They were compiled with a bare `new RegExp(source, 'giu')` and `exec`'d on
 * the main thread — none of the vm/budget machinery the `regex` family got.
 * `(a+)+$` on thirty characters pinned the event loop for ~10 s and every other
 * tenant on the process waited behind it.
 *
 * The fix routes them through the regex family's bounded executor (same 50 ms
 * per-policy budget, same source and input caps, same V8 timeout), and a
 * pattern that could not run surfaces as a DEGRADED policy so `failMode`
 * decides — never as a silent pass.
 */

import { describe, expect, it, vi } from 'vitest';

// The family adapter reaches the word-list resolver, which boots the database
// on import. Nothing here references a custom list, so it is stubbed out.
vi.mock('@/lib/services/guardrail/wordListService', () => ({
  resolveCustomWordLists: vi.fn(async () => []),
}));

import { runWordFilterPolicy } from '@/lib/services/guardrail/families/wordFilter';
import { DEFAULT_REGEX_BUDGET_MS, MAX_REGEX_SOURCE_CHARS } from '@/lib/services/guardrail/families/regex';
import { textSubject } from '@/lib/services/guardrail/hooks/contract';
import type { HookScope, WordFilterPolicyConfig } from '@/lib/services/guardrail/hooks/contract';
import { runWordFilter, scanWordFilter } from '@/lib/services/guardrail/wordFilter';
import type { IGuardrailWordFilterPolicy } from '@/lib/database';

const CATASTROPHIC = '(a+)+$';
/** 29 'a's then a '!' — the '!' forces the engine to backtrack. */
const ATTACK_INPUT = `${'a'.repeat(29)}!`;
/** Generous: the point is the order of magnitude, not the millisecond. */
const MAX_ELAPSED_MS = 500;

const NO_BUILTINS = { 'profanity-en': false, 'profanity-tr': false };

function legacyPolicy(regexes: string[]): IGuardrailWordFilterPolicy {
  return { enabled: true, action: 'block', builtinLists: NO_BUILTINS, regexes };
}

function policy(regexes: string[]): WordFilterPolicyConfig {
  return {
    id: 'wf',
    family: 'word_filter',
    enabled: true,
    hooks: ['input.pre', 'output.pre', 'tool.post'],
    schedule: { timing: 'sync', onFail: 'block' },
    builtinLists: NO_BUILTINS,
    regexes,
  } as WordFilterPolicyConfig;
}

const scope: HookScope = {
  tenantId: 'tenant-a',
  tenantDbName: 't_tenant_a',
  actor: { id: 'u1', kind: 'user', roles: [] },
  surface: 'api',
  source: 'unit-test',
  traceId: 'trace-wf-redos',
};

describe('word_filter regexes: a catastrophic pattern is cut off, not waited on', () => {
  it('the matcher returns within the budget and reports the pattern as skipped', () => {
    const started = Date.now();
    const scan = scanWordFilter(ATTACK_INPUT, legacyPolicy([CATASTROPHIC]));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(MAX_ELAPSED_MS);
    expect(scan.findings).toHaveLength(0);
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]?.index).toBe(0);
    expect(scan.skipped[0]?.reason).toMatch(/backtrack/i);
  });

  it('the family reports the policy DEGRADED, not skipped, on a tool.post subject', async () => {
    const started = Date.now();
    const result = await runWordFilterPolicy(textSubject(ATTACK_INPUT), policy([CATASTROPHIC]), {
      hook: 'tool.post',
      scope,
      action: 'block',
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(MAX_ELAPSED_MS);
    expect(result.findings).toHaveLength(0);
    // The load-bearing assertion: `failMode` gets to decide because the policy
    // says it could not run. A `skipped` that reached nobody is the bug.
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded?.[0]?.family).toBe('word_filter');
    expect(result.degraded?.[0]?.reason).toMatch(/budget|backtrack/i);
  });

  it('one budget for the whole list — six bad patterns cost about what one does', () => {
    const started = Date.now();
    const scan = scanWordFilter(ATTACK_INPUT, legacyPolicy(Array(6).fill(CATASTROPHIC)));

    expect(Date.now() - started).toBeLessThan(MAX_ELAPSED_MS);
    // Every pattern is accounted for: the ones that ran and timed out, and the
    // ones that never got to run.
    expect(scan.skipped).toHaveLength(6);
    const reasons = scan.skipped.map((s) => s.reason).join(' | ');
    expect(reasons).toMatch(/backtrack/i);
  });

  it('refuses a pattern source over the cap before compiling it', () => {
    const scan = scanWordFilter('hello', legacyPolicy([`(${'a'.repeat(MAX_REGEX_SOURCE_CHARS + 1)})`]));
    expect(scan.findings).toHaveLength(0);
    expect(scan.skipped[0]?.reason).toContain(String(MAX_REGEX_SOURCE_CHARS));
  });

  it('an uncompilable pattern is reported instead of silently continued past', async () => {
    const scan = scanWordFilter('hello', legacyPolicy(['([invalid']));
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]?.reason).toMatch(/does not compile/i);

    const result = await runWordFilterPolicy(textSubject('hello'), policy(['([invalid']), {
      hook: 'input.pre',
      scope,
      action: 'block',
    });
    expect(result.degraded?.[0]?.reason).toMatch(/does not compile/i);
    // ...and the legacy findings-only view still does not throw.
    expect(() => runWordFilter('hello', legacyPolicy(['([invalid']))).not.toThrow();
  });
});

describe('word_filter regexes: the budget does not change what benign patterns do', () => {
  it('still reports ONE finding per pattern with the first matched value', () => {
    const scan = scanWordFilter('code secret-42 then secret-43', legacyPolicy(['secret-\\d+']));
    expect(scan.skipped).toHaveLength(0);
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]?.category).toBe('custom_pattern');
    expect(scan.findings[0]?.value).toBe('secret-42');
    // The findings-only wrapper is byte-identical to the report's findings.
    expect(runWordFilter('code secret-42 then secret-43', legacyPolicy(['secret-\\d+']))).toEqual(scan.findings);
  });

  it('keeps the case-insensitive, unicode-aware legacy flags', () => {
    const scan = scanWordFilter('the WORD here', legacyPolicy(['w\\p{L}rd']));
    expect(scan.findings.map((f) => f.value)).toEqual(['WORD']);
  });

  it('the family emits findings and proposes redactions exactly as before', async () => {
    const result = await runWordFilterPolicy(textSubject('code secret-42'), policy(['secret-\\d+']), {
      hook: 'input.pre',
      scope,
      action: 'redact',
    });
    expect(result.degraded).toBeUndefined();
    expect(result.findings.map((f) => f.code)).toEqual(['custom_pattern']);
    expect(result.mutations).toEqual([
      expect.objectContaining({ op: 'replace_value', value: 'secret-42', replacement: '[REDACTED:custom_pattern]' }),
    ]);
  });

  it('spends the same budget the regex family does', () => {
    expect(DEFAULT_REGEX_BUDGET_MS).toBe(50);
  });
});
