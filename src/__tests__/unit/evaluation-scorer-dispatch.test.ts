/**
 * Unit tests — `runScorers` applicability: `applyWhen`, the built-in skips
 * (no reference, nothing to assert) and error isolation between scorers.
 */

import { describe, it, expect, vi } from 'vitest';
import { runScorers } from '@/lib/services/evaluation/scorers';
import type { DatasetItem, TargetOutput } from '@/lib/services/evaluation/types';

const WITH_REF: DatasetItem = { id: 'a', input: [{ role: 'user', content: 'q' }], expected: { reference: 'gold' } };
const NO_REF: DatasetItem = { id: 'b', input: [{ role: 'user', content: 'q' }] };
const OUT: TargetOutput = { text: 'gold' };
const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));

describe('runScorers — built-in skips', () => {
  it('skips semantic / context-recall / context-precision without a reference', async () => {
    const scores = await runScorers(
      NO_REF,
      { text: 'x', retrieved: [{ content: 'c', score: 1 }] } as TargetOutput,
      [{ type: 'semantic' }, { type: 'context-recall' }, { type: 'context-precision' }],
      { invokeEmbed: embed },
    );
    expect(scores.map((s) => s.skipped)).toEqual([true, true, true]);
    expect(scores.every((s) => !s.error && !s.passed && s.score === 0)).toBe(true);
    expect(embed).not.toHaveBeenCalled();
  });

  it('runs semantic when the item has a reference', async () => {
    const [score] = await runScorers(WITH_REF, OUT, [{ type: 'semantic' }], { invokeEmbed: embed });
    expect(score.skipped).toBeUndefined();
    expect(score.passed).toBe(true);
  });

  it('keeps the judge and tool-call abstention applicable without a reference', async () => {
    const invokeJudge = vi.fn().mockResolvedValue('{"score":1}');
    const scores = await runScorers(NO_REF, OUT, [{ type: 'llm-judge', rubric: 'r' }, { type: 'tool-call' }], { invokeJudge });
    expect(scores[0].skipped).toBeUndefined();
    expect(scores[0].passed).toBe(true);
    expect(scores[1]).toMatchObject({ scorerType: 'tool-call', passed: true, score: 1 });
  });

  it('skips json-shape without a JSON reference and assertion without checks', async () => {
    const scores = await runScorers(NO_REF, OUT, [{ type: 'json-shape' }, { type: 'assertion' }]);
    expect(scores.map((s) => s.skipped)).toEqual([true, true]);
  });
});

describe('runScorers — applyWhen', () => {
  it('has-reference skips an otherwise always-applicable scorer', async () => {
    const invokeJudge = vi.fn().mockResolvedValue('{"score":1}');
    const [skipped] = await runScorers(NO_REF, OUT, [{ type: 'llm-judge', rubric: 'r', applyWhen: 'has-reference' }], { invokeJudge });
    expect(skipped.skipped).toBe(true);
    expect(skipped.detail?.reason).toMatch(/no reference/);
    expect(invokeJudge).not.toHaveBeenCalled();
    const [ran] = await runScorers(WITH_REF, OUT, [{ type: 'llm-judge', rubric: 'r', applyWhen: 'has-reference' }], { invokeJudge });
    expect(ran.skipped).toBeUndefined();
  });

  it('has-expected-tool-calls skips the tool-call scorer on items without expected calls', async () => {
    const [skipped] = await runScorers(NO_REF, { text: '', toolCalls: [{ name: 'x', args: {} }] }, [{ type: 'tool-call', applyWhen: 'has-expected-tool-calls' }]);
    expect(skipped.skipped).toBe(true);
    const withCalls: DatasetItem = { ...NO_REF, expected: { toolCalls: [{ name: 'x', argsMatch: 'ignore' }] } };
    const [ran] = await runScorers(withCalls, { text: '', toolCalls: [{ name: 'x', args: {} }] }, [{ type: 'tool-call', applyWhen: 'has-expected-tool-calls' }]);
    expect(ran.skipped).toBeUndefined();
    expect(ran.passed).toBe(true);
  });

  it('keeps the scorer weight on a skipped score', async () => {
    const [skipped] = await runScorers(NO_REF, OUT, [{ type: 'json-shape', weight: 3, applyWhen: 'has-reference' }]);
    expect(skipped.weight).toBe(3);
  });
});

describe('runScorers — isolation', () => {
  it('turns a throwing scorer into an error score without losing the others', async () => {
    const invokeEmbed = vi.fn().mockImplementation(() => {
      throw new Error('embed exploded synchronously');
    });
    const scores = await runScorers(WITH_REF, { text: 'gold' }, [{ type: 'semantic' }, { type: 'assertion' }], { invokeEmbed });
    expect(scores).toHaveLength(2);
    expect(scores[0].error).toBeTruthy();
    expect(scores[1].scorerType).toBe('assertion');
  });
});
