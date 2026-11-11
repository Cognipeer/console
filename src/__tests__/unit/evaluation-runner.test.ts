/**
 * Unit tests — evaluation runner.
 * Covers aggregation (pass-rate / avg score / latency), per-item target
 * failures, judge wiring, concurrency correctness, and the progress hook.
 */

import { describe, it, expect, vi } from 'vitest';
import { runEvaluation } from '@/lib/services/evaluation/runner';
import type { DatasetItem, ScorerConfig, TargetInvoker } from '@/lib/services/evaluation/types';

function items(n: number): DatasetItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    input: [{ role: 'user', content: `q${i}` }],
    expected: { mustContain: ['ok'] },
  }));
}

const ASSERTION: ScorerConfig[] = [{ type: 'assertion' }];

describe('runEvaluation', () => {
  it('aggregates pass-rate, score and latency across items', async () => {
    const invokeTarget: TargetInvoker = async (item) => ({
      text: item.id === 'i1' ? 'nope' : 'ok',
      latencyMs: 10,
    });
    const result = await runEvaluation({ items: items(4), scorers: ASSERTION, invokeTarget });
    expect(result.aggregate.total).toBe(4);
    expect(result.aggregate.completed).toBe(4);
    expect(result.aggregate.failed).toBe(0);
    expect(result.aggregate.passed).toBe(3);
    expect(result.aggregate.passRate).toBeCloseTo(0.75, 5);
    expect(result.aggregate.avgLatencyMs).toBe(10);
    expect(result.items).toHaveLength(4);
  });

  it('totals tokens as input + output: cached tokens are a subset, never added', async () => {
    const invokeTarget: TargetInvoker = async () => ({
      text: 'ok',
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, costUsd: 0.01 },
    });
    const result = await runEvaluation({ items: items(2), scorers: ASSERTION, invokeTarget });
    expect(result.aggregate.totalTokens).toBe(240);
  });

  it('records target failures without aborting the run', async () => {
    const invokeTarget: TargetInvoker = async (item) => {
      if (item.id === 'i2') throw new Error('boom');
      return { text: 'ok' };
    };
    const result = await runEvaluation({ items: items(4), scorers: ASSERTION, invokeTarget });
    expect(result.aggregate.failed).toBe(1);
    expect(result.aggregate.completed).toBe(3);
    const failedItem = result.items.find((i) => i.itemId === 'i2');
    expect(failedItem?.error).toMatch(/boom/);
    expect(failedItem?.passed).toBe(false);
  });

  it('wires the judge invoker into llm-judge scorers', async () => {
    const invokeTarget: TargetInvoker = async () => ({ text: 'ok' });
    const invokeJudge = vi.fn().mockResolvedValue('{"score":1,"passed":true}');
    const scorers: ScorerConfig[] = [{ type: 'assertion' }, { type: 'llm-judge', rubric: 'r' }];
    const result = await runEvaluation({ items: items(2), scorers, invokeTarget, invokeJudge });
    expect(invokeJudge).toHaveBeenCalledTimes(2);
    expect(result.aggregate.passed).toBe(2);
    expect(result.items[0].scores).toHaveLength(2);
  });

  it('processes every item exactly once under bounded concurrency', async () => {
    const seen = new Set<string>();
    let active = 0;
    let maxActive = 0;
    const invokeTarget: TargetInvoker = async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      seen.add(item.id);
      active -= 1;
      return { text: 'ok' };
    };
    const result = await runEvaluation({ items: items(10), scorers: ASSERTION, invokeTarget, config: { concurrency: 3 } });
    expect(seen.size).toBe(10);
    expect(result.items.every((i) => i)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('invokes the progress hook once per item', async () => {
    const invokeTarget: TargetInvoker = async () => ({ text: 'ok' });
    const onItem = vi.fn();
    await runEvaluation({ items: items(5), scorers: ASSERTION, invokeTarget, onItem });
    expect(onItem).toHaveBeenCalledTimes(5);
  });
});

describe('runEvaluation — outcomes and aggregate', () => {
  const okTarget: TargetInvoker = async () => ({ text: 'ok', latencyMs: 10 });

  it('turns a scorer error into an errored item that counts as failed, not completed', async () => {
    // No judge invoker configured: the llm-judge score carries an error.
    const scorers: ScorerConfig[] = [{ type: 'assertion' }, { type: 'llm-judge', rubric: 'r' }];
    const result = await runEvaluation({ items: items(2), scorers, invokeTarget: okTarget });
    expect(result.items[0].error).toMatch(/^Scoring failed — llm-judge: /);
    expect(result.items[0].passed).toBe(false);
    // The scorer that did run still contributes its score.
    expect(result.items[0].score).toBe(1);
    expect(result.aggregate).toMatchObject({ total: 2, completed: 0, failed: 2, passed: 0, errorRate: 1, passRate: 0 });
  });

  it('skips an item where no scorer applied and excludes it from pass rate and avg score', async () => {
    const mixed: DatasetItem[] = [
      { id: 'a', input: [{ role: 'user', content: 'q' }], expected: { mustContain: ['ok'] } },
      { id: 'b', input: [{ role: 'user', content: 'q' }] }, // nothing to assert
      { id: 'c', input: [{ role: 'user', content: 'q' }], expected: { mustContain: ['zzz'] } },
    ];
    const result = await runEvaluation({ items: mixed, scorers: ASSERTION, invokeTarget: okTarget });
    expect(result.items[1]).toMatchObject({ skipped: true, passed: false, score: 0 });
    expect(result.items[1].error).toBeUndefined();
    expect(result.aggregate).toMatchObject({ total: 3, completed: 3, failed: 0, skipped: 1, passed: 1, errorRate: 0 });
    expect(result.aggregate.passRate).toBeCloseTo(0.5, 5);
    expect(result.aggregate.avgScore).toBeCloseTo(0.5, 5);
  });

  it('skips an item when no scorers are configured at all', async () => {
    const result = await runEvaluation({ items: items(1), scorers: [], invokeTarget: okTarget });
    expect(result.items[0].skipped).toBe(true);
    expect(result.aggregate.skipped).toBe(1);
  });

  it('applyWhen skips a scorer for items it does not fit and the others still decide', async () => {
    const scorers: ScorerConfig[] = [{ type: 'assertion' }, { type: 'json-shape', applyWhen: 'has-reference' }];
    const result = await runEvaluation({ items: items(1), scorers, invokeTarget: okTarget });
    expect(result.items[0].scores[1]).toMatchObject({ scorerType: 'json-shape', skipped: true });
    expect(result.items[0].passed).toBe(true);
    expect(result.items[0].skipped).toBeUndefined();
  });

  it('ignores invalid weights and falls back to equal weights when all are zero', async () => {
    const target: TargetInvoker = async () => ({ text: 'ok' });
    const invokeJudge = vi.fn().mockResolvedValue('{"score":0.5}');
    const scorers: ScorerConfig[] = [
      { type: 'assertion', weight: 0 },
      { type: 'llm-judge', rubric: 'r', weight: -3 },
    ];
    const result = await runEvaluation({ items: items(1), scorers, invokeTarget: target, invokeJudge });
    // equal weights: (1 + 0.5) / 2
    expect(result.items[0].score).toBeCloseTo(0.75, 5);
  });

  it('averages latency over completed items only', async () => {
    const target: TargetInvoker = async (item) => {
      if (item.id === 'i1') throw new Error('boom');
      return { text: 'ok', latencyMs: 20 };
    };
    const result = await runEvaluation({ items: items(3), scorers: ASSERTION, invokeTarget: target });
    expect(result.aggregate.avgLatencyMs).toBe(20);
    expect(result.aggregate.errorRate).toBeCloseTo(1 / 3, 5);
  });

  it('counts truncated outputs and usage items', async () => {
    const target: TargetInvoker = async (item) => ({
      text: 'ok',
      ...(item.id === 'i0' ? { truncated: true } : {}),
      ...(item.id !== 'i2' ? { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 } } : {}),
    });
    const result = await runEvaluation({ items: items(3), scorers: ASSERTION, invokeTarget: target });
    expect(result.aggregate.truncatedCount).toBe(1);
    expect(result.aggregate.usageItems).toBe(2);
    expect(result.aggregate.totalTokens).toBe(30);
  });

  it('keeps judge spend apart from the target totals', async () => {
    const invokeJudge = vi.fn().mockResolvedValue({
      text: '{"score":1}',
      usage: { inputTokens: 40, outputTokens: 10, costUsd: 0.02 },
    });
    const target: TargetInvoker = async () => ({ text: 'ok', usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 } });
    const scorers: ScorerConfig[] = [{ type: 'llm-judge', rubric: 'r' }];
    const result = await runEvaluation({ items: items(2), scorers, invokeTarget: target, invokeJudge });
    expect(result.items[0].scoringUsage).toEqual({ inputTokens: 40, outputTokens: 10, costUsd: 0.02 });
    expect(result.aggregate.scoringTokens).toBe(100);
    expect(result.aggregate.scoringCostUsd).toBeCloseTo(0.04, 5);
    expect(result.aggregate.totalTokens).toBe(240);
    expect(result.aggregate.totalCostUsd).toBeCloseTo(1, 5);
  });

  it('leaves scoring totals absent when no judge reported usage', async () => {
    const result = await runEvaluation({ items: items(1), scorers: ASSERTION, invokeTarget: okTarget });
    expect(result.aggregate.scoringCostUsd).toBeUndefined();
    expect(result.aggregate.scoringTokens).toBeUndefined();
  });
});

describe('runEvaluation — concurrency clamp and shouldStop', () => {
  it('clamps concurrency into [1, 32]', async () => {
    let active = 0;
    let maxActive = 0;
    const target: TargetInvoker = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      return { text: 'ok' };
    };
    await runEvaluation({ items: items(40), scorers: ASSERTION, invokeTarget: target, config: { concurrency: 1000 } });
    expect(maxActive).toBeLessThanOrEqual(32);
    maxActive = 0;
    await runEvaluation({ items: items(4), scorers: ASSERTION, invokeTarget: target, config: { concurrency: -5 } });
    expect(maxActive).toBe(1);
    maxActive = 0;
    await runEvaluation({ items: items(4), scorers: ASSERTION, invokeTarget: target, config: { concurrency: 2.9 } });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('stops dispatching once shouldStop is true and reports only processed items', async () => {
    let started = 0;
    const target: TargetInvoker = async () => {
      started += 1;
      return { text: 'ok' };
    };
    const result = await runEvaluation({
      items: items(10),
      scorers: ASSERTION,
      invokeTarget: target,
      config: { concurrency: 1 },
      shouldStop: () => started >= 3,
    });
    expect(result.stopped).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.aggregate.total).toBe(3);
    expect(result.items.map((i) => i.itemId)).toEqual(['i0', 'i1', 'i2']);
  });

  it('does not flag stopped when every item was already dispatched', async () => {
    const result = await runEvaluation({
      items: items(2),
      scorers: ASSERTION,
      invokeTarget: async () => ({ text: 'ok' }),
      config: { concurrency: 1 },
      shouldStop: () => false,
    });
    expect(result.stopped).toBeUndefined();
    expect(result.items).toHaveLength(2);
  });
});
