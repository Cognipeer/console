/**
 * Shared serializers for the client Evaluation surface.
 *
 * The external client API (`/api/client/v1/evaluation/*`) is read- and
 * trigger-oriented: callers discover their configured **suites**, trigger a
 * **run**, and read back **run** results. Suite/target/dataset *authoring*
 * stays on the dashboard surface (an admin concern).
 *
 * These helpers shape the internal camelCase records into the snake_case
 * envelope the other client modules use, so both the Fastify plugin and
 * its tests share one source of truth.
 */

import { agentRevisionApiView } from '@/lib/shared/agentRevision';
import type { WithId } from '@/lib/services/evaluation/service';
import type {
  IEvaluationRun,
  IEvaluationRunAggregate,
  IEvaluationSuite,
} from '@/lib/database';

/**
 * Drop `null`/`undefined` members. Mongo hands optional fields back as `null`
 * after a write that carried `undefined`; the client API treats both as absent
 * rather than leaking `null` into a typed SDK field.
 */
function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
}

export function toSuiteView(suite: WithId<IEvaluationSuite>): Record<string, unknown> {
  return {
    key: suite.key,
    name: suite.name,
    description: suite.description,
    target_key: suite.targetKey,
    dataset_key: suite.datasetKey,
    judge_model_key: suite.judgeModelKey,
    scorers: suite.scorers.map((s) =>
      compact({
        type: s.type,
        weight: s.weight,
        rubric: s.rubric,
        threshold: s.threshold,
        apply_when: s.applyWhen,
        allow_extra_calls: s.allowExtraCalls,
        strict: s.strict,
      }),
    ),
    created_at: suite.createdAt,
  };
}

function toAggregate(a?: IEvaluationRunAggregate): Record<string, unknown> | undefined {
  if (!a) return undefined;
  // Runs written before these fields existed lack them; they are simply left out.
  return compact({
    total: a.total,
    completed: a.completed,
    failed: a.failed,
    passed: a.passed,
    skipped: a.skipped,
    pass_rate: a.passRate,
    // A run from before `errorRate` existed derives it, as the dashboard does.
    error_rate: a.errorRate ?? (a.total > 0 ? a.failed / a.total : 0),
    avg_score: a.avgScore,
    avg_latency_ms: a.avgLatencyMs,
    truncated_count: a.truncatedCount,
    usage_items: a.usageItems,
    scoring_cost_usd: a.scoringCostUsd,
    scoring_tokens: a.scoringTokens,
  });
}

/** Run envelope without the (potentially large) per-item array. */
export function toRunSummary(run: WithId<IEvaluationRun>): Record<string, unknown> {
  // `status` is one of pending | running | completed | failed | cancelled.
  return compact({
    id: run.id,
    suite_key: run.suiteKey,
    target_key: run.targetKey,
    dataset_key: run.datasetKey,
    status: run.status,
    agent_revision: agentRevisionApiView(run.agentRevision),
    aggregate: toAggregate(run.aggregate),
    error: run.error || undefined,
    cancel_requested_at: run.cancelRequestedAt,
    items_truncated: run.itemsTruncated ? true : undefined,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    created_at: run.createdAt,
  });
}

/** Full run envelope, including per-item scores. */
export function toRunView(run: WithId<IEvaluationRun>): Record<string, unknown> {
  return {
    ...toRunSummary(run),
    items: (run.items ?? []).map((it) =>
      compact({
        item_id: it.itemId,
        passed: it.passed,
        score: it.score,
        latency_ms: it.latencyMs,
        output_text: it.output?.text,
        output_truncated: it.output?.truncated ? true : undefined,
        error: it.error,
        skipped: it.skipped ? true : undefined,
        ...(it.restricted ? { restricted: true } : {}),
        scores: it.scores.map((s) =>
          compact({
            scorer_type: s.scorerType,
            score: s.score,
            passed: s.passed,
            weight: s.weight,
            error: s.error,
            skipped: s.skipped ? true : undefined,
          }),
        ),
      }),
    ),
  };
}
