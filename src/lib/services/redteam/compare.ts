/**
 * Red-team run comparison — diff a scan against a baseline scan to surface
 * regressions (a previously-safe attack now succeeds) and fixes. Pure: it takes
 * two persisted runs and returns the per-attempt transitions plus aggregate
 * deltas, so a CI gate or the dashboard can answer "did this change make the
 * target less safe?".
 *
 * Only attempts present in both runs (same attempt key) can regress or be
 * fixed. An attempt that got no answer on either side is `errored`: it says
 * nothing about the target, so it is never counted as a regression or a fix.
 * Attempts only one run has are listed as the probe-set difference.
 */

import type { IRedTeamAttemptResult, IRedTeamRun, RedTeamOutcome } from '@/lib/database';
import { effectiveOutcome, isFailedAttempt } from './aggregate';
import { attemptKeyOf } from './attemptKey';

/** Lower is safer; used to classify a transition as a regression or a fix. */
const OUTCOME_RANK: Record<RedTeamOutcome, number> = { safe: 0, needs_review: 1, vulnerable: 2 };

export type ComparisonStatus = 'regressed' | 'fixed' | 'unchanged' | 'errored' | 'added' | 'removed';

export interface RedTeamComparisonAttempt {
  key: string;
  probeKey: string;
  attemptId: string;
  category: string;
  severity: string;
  /** Left out for a side that got no answer (`errored`). */
  baseline?: RedTeamOutcome;
  current?: RedTeamOutcome;
  status: ComparisonStatus;
}

export interface RedTeamComparison {
  baselineRunId: string;
  runId: string;
  summary: Record<ComparisonStatus, number>;
  deltas: {
    /** null when either run has no rate (nothing completed). */
    attackSuccessRate: number | null;
    resilienceScore: number | null;
    vulnerable: number;
  };
  /** The two runs did not run the same attempts: their rates are not like for like. */
  probeSetChanged: boolean;
  /** Attempt keys only the baseline ran. */
  onlyInBaseline: string[];
  /** Attempt keys only the current run ran. */
  onlyInCurrent: string[];
  /** Attempts whose verdict changed (regressed/fixed), errored ones, plus added/removed. */
  changes: RedTeamComparisonAttempt[];
}

/** The attempts to compare when they are not the runs' embedded ones (runs that keep attempts as rows). */
export interface RedTeamComparisonAttempts {
  baseline?: IRedTeamAttemptResult[];
  current?: IRedTeamAttemptResult[];
}

function keyOf(a: IRedTeamAttemptResult): string {
  return a.attemptKey ?? attemptKeyOf(a);
}

function runId(run: IRedTeamRun): string {
  return typeof run._id === 'string' ? run._id : String(run._id ?? '');
}

function indexByKey(attempts: IRedTeamAttemptResult[]): Map<string, IRedTeamAttemptResult> {
  return new Map(attempts.map((a) => [keyOf(a), a]));
}

function delta(current: number | null | undefined, baseline: number | null | undefined): number | null {
  if (typeof current !== 'number' || typeof baseline !== 'number') return null;
  return current - baseline;
}

export function compareRedTeamRuns(
  baseline: IRedTeamRun,
  current: IRedTeamRun,
  attempts: RedTeamComparisonAttempts = {},
): RedTeamComparison {
  const baseByKey = indexByKey(attempts.baseline ?? baseline.attempts ?? []);
  const curByKey = indexByKey(attempts.current ?? current.attempts ?? []);

  const summary: Record<ComparisonStatus, number> = { regressed: 0, fixed: 0, unchanged: 0, errored: 0, added: 0, removed: 0 };
  const changes: RedTeamComparisonAttempt[] = [];
  const onlyInBaseline: string[] = [];
  const onlyInCurrent: string[] = [];

  const allKeys = new Set([...baseByKey.keys(), ...curByKey.keys()]);
  for (const key of allKeys) {
    const b = baseByKey.get(key);
    const c = curByKey.get(key);
    const sample = c ?? b!;
    const baseFailed = b ? isFailedAttempt(b) : false;
    const curFailed = c ? isFailedAttempt(c) : false;
    const baseOutcome = b && !baseFailed ? effectiveOutcome(b) : undefined;
    const curOutcome = c && !curFailed ? effectiveOutcome(c) : undefined;

    let status: ComparisonStatus;
    if (!b) {
      status = 'added';
      onlyInCurrent.push(key);
    } else if (!c) {
      status = 'removed';
      onlyInBaseline.push(key);
    } else if (baseOutcome === undefined || curOutcome === undefined) {
      status = 'errored';
    } else if (OUTCOME_RANK[curOutcome] > OUTCOME_RANK[baseOutcome]) status = 'regressed';
    else if (OUTCOME_RANK[curOutcome] < OUTCOME_RANK[baseOutcome]) status = 'fixed';
    else status = 'unchanged';

    summary[status] += 1;
    if (status !== 'unchanged') {
      changes.push({
        key,
        probeKey: sample.probeKey,
        attemptId: sample.attemptId,
        category: sample.category,
        severity: sample.severity,
        ...(baseOutcome !== undefined ? { baseline: baseOutcome } : {}),
        ...(curOutcome !== undefined ? { current: curOutcome } : {}),
        status,
      });
    }
  }

  // Regressions first (most actionable), then fixes, errors, and added/removed; a stable order inside each group.
  const order: Record<ComparisonStatus, number> = { regressed: 0, fixed: 1, errored: 2, added: 3, removed: 4, unchanged: 5 };
  changes.sort((a, b) => order[a.status] - order[b.status] || a.key.localeCompare(b.key));
  onlyInBaseline.sort();
  onlyInCurrent.sort();

  const ba = baseline.aggregate;
  const ca = current.aggregate;
  return {
    baselineRunId: runId(baseline),
    runId: runId(current),
    summary,
    deltas: {
      attackSuccessRate: delta(ca?.attackSuccessRate, ba?.attackSuccessRate),
      resilienceScore: delta(ca?.resilienceScore, ba?.resilienceScore),
      vulnerable: (ca?.vulnerable ?? 0) - (ba?.vulnerable ?? 0),
    },
    probeSetChanged: onlyInBaseline.length > 0 || onlyInCurrent.length > 0,
    onlyInBaseline,
    onlyInCurrent,
    changes,
  };
}
