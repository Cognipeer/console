/**
 * Evaluation run comparison — diff a run against a baseline run of the same
 * suite to surface regressions (a previously-passing item now fails) and fixes,
 * plus per-item score deltas. Pure: takes two persisted runs, returns the
 * per-item transitions and aggregate deltas for a CI gate or the dashboard.
 */

import type { IEvaluationRun, IEvaluationRunItem } from '@/lib/database';

export type EvalComparisonStatus = 'regressed' | 'fixed' | 'unchanged' | 'added' | 'removed';

export interface EvalComparisonItem {
  itemId: string;
  baselinePassed?: boolean;
  currentPassed?: boolean;
  baselineScore?: number;
  currentScore?: number;
  /** currentScore - baselineScore, when both present. */
  scoreDelta?: number;
  status: EvalComparisonStatus;
}

export interface EvalComparison {
  baselineRunId: string;
  runId: string;
  summary: Record<EvalComparisonStatus, number>;
  deltas: {
    passRate: number;
    avgScore: number;
  };
  /** Items whose pass/fail changed plus added/removed (unchanged omitted). */
  changes: EvalComparisonItem[];
}

function runId(run: IEvaluationRun): string {
  return typeof run._id === 'string' ? run._id : String(run._id ?? '');
}

export function compareEvaluationRuns(baseline: IEvaluationRun, current: IEvaluationRun): EvalComparison {
  const baseByItem = new Map<string, IEvaluationRunItem>(baseline.items.map((i) => [i.itemId, i]));
  const curByItem = new Map<string, IEvaluationRunItem>(current.items.map((i) => [i.itemId, i]));

  const summary: Record<EvalComparisonStatus, number> = { regressed: 0, fixed: 0, unchanged: 0, added: 0, removed: 0 };
  const changes: EvalComparisonItem[] = [];

  const allIds = new Set([...baseByItem.keys(), ...curByItem.keys()]);
  for (const itemId of allIds) {
    const b = baseByItem.get(itemId);
    const c = curByItem.get(itemId);

    let status: EvalComparisonStatus;
    if (!b) status = 'added';
    else if (!c) status = 'removed';
    else if (b.passed && !c.passed) status = 'regressed';
    else if (!b.passed && c.passed) status = 'fixed';
    else status = 'unchanged';

    summary[status] += 1;
    if (status !== 'unchanged') {
      const baselineScore = b?.score;
      const currentScore = c?.score;
      changes.push({
        itemId,
        baselinePassed: b?.passed,
        currentPassed: c?.passed,
        baselineScore,
        currentScore,
        scoreDelta: baselineScore !== undefined && currentScore !== undefined ? currentScore - baselineScore : undefined,
        status,
      });
    }
  }

  const order: Record<EvalComparisonStatus, number> = { regressed: 0, fixed: 1, added: 2, removed: 3, unchanged: 4 };
  changes.sort((a, b) => order[a.status] - order[b.status]);

  const ba = baseline.aggregate;
  const ca = current.aggregate;
  return {
    baselineRunId: runId(baseline),
    runId: runId(current),
    summary,
    deltas: {
      passRate: (ca?.passRate ?? 0) - (ba?.passRate ?? 0),
      avgScore: (ca?.avgScore ?? 0) - (ba?.avgScore ?? 0),
    },
    changes,
  };
}
