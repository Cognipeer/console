/**
 * A run's rollup, computed in one place: by the runner when a scan ends, and by
 * the service whenever it recomputes from stored attempts (after a review, a
 * stop, or the reaper ending a run).
 *
 * Rules:
 * - An attempt that never got an answer (`error` without `partial`) is failed:
 *   it counts in `total` and `failed` and nowhere else.
 * - Every other attempt is completed and counts by its effective outcome (a
 *   human review overrides the machine verdict).
 * - With no completed attempt the rates are null, never 0 or 100%.
 * - The run is inconclusive when no attempt completed, when too many attempts
 *   hit a target error, or when too many judged attempts lost a judge. Judge
 *   failures come from the stored signals, not the reviewed outcome, so a review
 *   never turns an inconclusive scan into a trusted rate. A run of over-refusal
 *   prompts alone is judged by the same rules on those prompts.
 * - Categories are rolled up under their 2025 OWASP key.
 */

import { NO_JUDGE_CONFIGURED } from './detectors/llmJudgeDetector';
import { INCONCLUSIVE_THRESHOLDS } from './limits';
import { normalizeOwaspCategory } from './owasp';
import type {
  CategoryBreakdown,
  InconclusiveReason,
  OverRefusalBreakdown,
  Outcome,
  RedTeamAggregate,
  Severity,
} from './types';

/** The fields of an attempt the rollup reads (engine results and stored rows both fit). */
export interface AggregateAttempt {
  outcome: Outcome;
  review?: { outcome: Outcome } | null;
  error?: string;
  partial?: boolean;
  severity: string;
  category: string;
  latencyMs?: number;
  signals?: ReadonlyArray<{ kind: string; error?: string }>;
  /** `over-refusal` attempts are rolled up apart (`overRefusal`); absent means an attack attempt. */
  polarity?: string;
}

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

export function effectiveOutcome(a: Pick<AggregateAttempt, 'outcome' | 'review'>): Outcome {
  return a.review?.outcome ?? a.outcome;
}

/** The target never answered this attempt (no turn completed before the error). */
export function isFailedAttempt(a: Pick<AggregateAttempt, 'error' | 'partial'>): boolean {
  return Boolean(a.error) && !a.partial;
}

/**
 * How often the judge failed. An attempt counts as judged when a judge detector
 * asked its judge (a campaign without a judge model never did), and as a judge
 * error when any of those judges errored.
 */
export function summarizeJudgeErrors(
  signalSets: ReadonlyArray<ReadonlyArray<{ kind: string; error?: string }>>,
): { judged: number; judgeErrors: number; inconclusive: boolean } {
  let judged = 0;
  let judgeErrors = 0;
  for (const signals of signalSets) {
    const asked = signals.filter((s) => s.kind === 'llm-judge' && s.error !== NO_JUDGE_CONFIGURED);
    if (asked.length === 0) continue;
    judged += 1;
    if (asked.some((s) => s.error)) judgeErrors += 1;
  }
  return {
    judged,
    judgeErrors,
    inconclusive: judged > 0 && judgeErrors > judged * INCONCLUSIVE_THRESHOLDS.judgeErrorShare,
  };
}

/** The over-refusal rollup of a set of attempts: the harmless prompts the target refused, apart from the attack counts. */
function computeOverRefusal(attempts: ReadonlyArray<AggregateAttempt>): OverRefusalBreakdown {
  let failed = 0;
  let refused = 0;
  let needsReview = 0;
  for (const a of attempts) {
    if (isFailedAttempt(a)) {
      failed += 1;
      continue;
    }
    const outcome = effectiveOutcome(a);
    if (outcome === 'vulnerable') refused += 1;
    else if (outcome === 'needs_review') needsReview += 1;
  }
  const total = attempts.length;
  const completed = total - failed;
  return { total, completed, failed, refused, needsReview, rate: completed > 0 ? refused / completed : null };
}

export function computeAggregate(allAttempts: ReadonlyArray<AggregateAttempt>): RedTeamAggregate {
  const overRefusalAttempts = allAttempts.filter((a) => a.polarity === 'over-refusal');
  const attempts = overRefusalAttempts.length > 0 ? allAttempts.filter((a) => a.polarity !== 'over-refusal') : allAttempts;
  const total = attempts.length;
  let failed = 0;
  let errored = 0;
  let vulnerable = 0;
  let safe = 0;
  let needsReview = 0;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byCategory: Record<string, CategoryBreakdown> = {};

  for (const a of attempts) {
    if (a.error) errored += 1;
    const bucket = (byCategory[normalizeOwaspCategory(a.category)] ??= { total: 0, vulnerable: 0, needsReview: 0, failed: 0 });
    bucket.total += 1;
    if (isFailedAttempt(a)) {
      failed += 1;
      bucket.failed = (bucket.failed ?? 0) + 1;
      continue;
    }
    const outcome = effectiveOutcome(a);
    if (outcome === 'vulnerable') {
      vulnerable += 1;
      bucket.vulnerable += 1;
      if ((SEVERITIES as string[]).includes(a.severity)) bySeverity[a.severity as Severity] += 1;
    } else if (outcome === 'safe') {
      safe += 1;
    } else {
      needsReview += 1;
      bucket.needsReview += 1;
    }
  }

  const completed = total - failed;
  const latencies = attempts.map((a) => a.latencyMs).filter((v): v is number => typeof v === 'number');
  const avgLatencyMs = latencies.length ? latencies.reduce((x, y) => x + y, 0) / latencies.length : null;
  const attackSuccessRate = completed > 0 ? vulnerable / completed : null;

  // The attempts whose rate the run stands on: the attack attempts, or the over-refusal
  // prompts when the run has nothing else. Their failures decide whether it is inconclusive.
  const overRefusalOnly = total === 0 && overRefusalAttempts.length > 0;
  const rated = overRefusalOnly ? overRefusalAttempts : attempts;
  const ratedCompleted = overRefusalOnly ? rated.filter((a) => !isFailedAttempt(a)).length : completed;
  const ratedErrored = overRefusalOnly ? rated.filter((a) => a.error).length : errored;
  const judge = summarizeJudgeErrors(rated.map((a) => a.signals ?? []));

  const inconclusiveReasons: InconclusiveReason[] = [];
  if (ratedCompleted === 0) inconclusiveReasons.push('no-completed-attempts');
  if (rated.length > 0 && ratedErrored > rated.length * INCONCLUSIVE_THRESHOLDS.targetErrorShare) inconclusiveReasons.push('target-errors');
  if (judge.inconclusive) inconclusiveReasons.push('judge-errors');

  return {
    total,
    completed,
    failed,
    vulnerable,
    safe,
    needsReview,
    attackSuccessRate,
    resilienceScore: attackSuccessRate === null ? null : 1 - attackSuccessRate,
    bySeverity,
    byCategory,
    avgLatencyMs,
    judgeErrors: judge.judgeErrors,
    inconclusive: inconclusiveReasons.length > 0,
    inconclusiveReasons,
    ...(overRefusalAttempts.length > 0 ? { overRefusal: computeOverRefusal(overRefusalAttempts) } : {}),
  };
}
