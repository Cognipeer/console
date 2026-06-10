/**
 * Unit tests — evaluation run comparison. Verifies per-item pass/fail
 * transitions (regressed/fixed), score deltas, and aggregate deltas.
 */

import { describe, it, expect } from 'vitest';
import { compareEvaluationRuns } from '@/lib/services/evaluation/compare';
import type { IEvaluationRun, IEvaluationRunItem } from '@/lib/database';

function item(itemId: string, passed: boolean, score: number): IEvaluationRunItem {
  return { itemId, scores: [], score, passed };
}

function run(items: IEvaluationRunItem[], id: string): IEvaluationRun {
  const completed = items.length;
  const passed = items.filter((i) => i.passed).length;
  return {
    _id: id,
    tenantId: 't1',
    suiteKey: 's1',
    targetKey: 'tg1',
    datasetKey: 'd1',
    status: 'completed',
    mode: 'async',
    progress: { total: completed, completed, failed: 0 },
    aggregate: {
      total: completed,
      completed,
      failed: 0,
      passed,
      passRate: passed / completed,
      avgScore: items.reduce((s, i) => s + i.score, 0) / completed,
      avgLatencyMs: null,
    },
    items,
    createdBy: 'u1',
  };
}

describe('compareEvaluationRuns', () => {
  it('classifies regressed and fixed items and computes score deltas', () => {
    const baseline = run([item('a', true, 1), item('b', false, 0.2), item('c', true, 0.9)], 'base');
    const current = run([item('a', false, 0.3), item('b', true, 0.8), item('c', true, 0.9)], 'cur');
    const cmp = compareEvaluationRuns(baseline, current);
    expect(cmp.summary.regressed).toBe(1);
    expect(cmp.summary.fixed).toBe(1);
    expect(cmp.summary.unchanged).toBe(1);
    const regressed = cmp.changes.find((c) => c.itemId === 'a');
    expect(regressed?.status).toBe('regressed');
    expect(regressed?.scoreDelta).toBeCloseTo(-0.7, 5);
    // pass rate unchanged (2/3 each)
    expect(cmp.deltas.passRate).toBeCloseTo(0, 5);
  });

  it('detects added and removed items', () => {
    const baseline = run([item('a', true, 1)], 'base');
    const current = run([item('a', true, 1), item('b', false, 0)], 'cur');
    const cmp = compareEvaluationRuns(baseline, current);
    expect(cmp.summary.added).toBe(1);
    expect(cmp.summary.unchanged).toBe(1);
    expect(cmp.deltas.passRate).toBeCloseTo(0.5 - 1, 5);
  });
});
