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
