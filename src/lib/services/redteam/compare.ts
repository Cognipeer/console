/**
 * Red-team run comparison — diff a scan against a baseline scan to surface
 * regressions (a previously-safe attack now succeeds) and fixes. Pure: it takes
 * two persisted runs and returns the per-attempt transitions plus aggregate
 * deltas, so a CI gate or the dashboard can answer "did this change make the
 * target less safe?".
 */

import type { IRedTeamAttemptResult, IRedTeamRun, RedTeamOutcome } from '@/lib/database';

/** Lower is safer; used to classify a transition as a regression or a fix. */
const OUTCOME_RANK: Record<RedTeamOutcome, number> = { safe: 0, needs_review: 1, vulnerable: 2 };

export type ComparisonStatus = 'regressed' | 'fixed' | 'unchanged' | 'added' | 'removed';

export interface RedTeamComparisonAttempt {
  key: string;
  probeKey: string;
  attemptId: string;
  category: string;
  severity: string;
  baseline?: RedTeamOutcome;
  current?: RedTeamOutcome;
  status: ComparisonStatus;
}

export interface RedTeamComparison {
  baselineRunId: string;
  runId: string;
  summary: Record<ComparisonStatus, number>;
  deltas: {
    attackSuccessRate: number;
    resilienceScore: number;
    vulnerable: number;
  };
  /** Attempts whose verdict changed (regressed/fixed) plus added/removed. */
  changes: RedTeamComparisonAttempt[];
}

function attemptKey(a: IRedTeamAttemptResult): string {
  return `${a.probeKey}::${a.attemptId}`;
}

/** Effective verdict: a human review overrides the machine outcome. */
function effectiveOutcome(a: IRedTeamAttemptResult): RedTeamOutcome {
  return a.review?.outcome ?? a.outcome;
}

function runId(run: IRedTeamRun): string {
  return typeof run._id === 'string' ? run._id : String(run._id ?? '');
}

export function compareRedTeamRuns(baseline: IRedTeamRun, current: IRedTeamRun): RedTeamComparison {
  const baseByKey = new Map(baseline.attempts.map((a) => [attemptKey(a), a]));
  const curByKey = new Map(current.attempts.map((a) => [attemptKey(a), a]));

  const summary: Record<ComparisonStatus, number> = { regressed: 0, fixed: 0, unchanged: 0, added: 0, removed: 0 };
  const changes: RedTeamComparisonAttempt[] = [];

  const allKeys = new Set([...baseByKey.keys(), ...curByKey.keys()]);
  for (const key of allKeys) {
    const b = baseByKey.get(key);
    const c = curByKey.get(key);
    const sample = c ?? b!;
    const baseOutcome = b ? effectiveOutcome(b) : undefined;
    const curOutcome = c ? effectiveOutcome(c) : undefined;

    let status: ComparisonStatus;
    if (!b) status = 'added';
    else if (!c) status = 'removed';
    else if (OUTCOME_RANK[curOutcome!] > OUTCOME_RANK[baseOutcome!]) status = 'regressed';
    else if (OUTCOME_RANK[curOutcome!] < OUTCOME_RANK[baseOutcome!]) status = 'fixed';
    else status = 'unchanged';

    summary[status] += 1;
    if (status !== 'unchanged') {
      changes.push({
        key,
        probeKey: sample.probeKey,
        attemptId: sample.attemptId,
        category: sample.category,
        severity: sample.severity,
        baseline: baseOutcome,
        current: curOutcome,
        status,
      });
    }
  }

  // Regressions first (most actionable), then fixes, then added/removed.
  const order: Record<ComparisonStatus, number> = { regressed: 0, fixed: 1, added: 2, removed: 3, unchanged: 4 };
  changes.sort((a, b) => order[a.status] - order[b.status]);

  const ba = baseline.aggregate;
  const ca = current.aggregate;
  return {
    baselineRunId: runId(baseline),
    runId: runId(current),
    summary,
    deltas: {
      attackSuccessRate: (ca?.attackSuccessRate ?? 0) - (ba?.attackSuccessRate ?? 0),
      resilienceScore: (ca?.resilienceScore ?? 0) - (ba?.resilienceScore ?? 0),
      vulnerable: (ca?.vulnerable ?? 0) - (ba?.vulnerable ?? 0),
    },
    changes,
  };
}
