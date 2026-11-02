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

export function toSuiteView(suite: WithId<IEvaluationSuite>): Record<string, unknown> {
  return {
    key: suite.key,
    name: suite.name,
    description: suite.description,
    target_key: suite.targetKey,
    dataset_key: suite.datasetKey,
    judge_model_key: suite.judgeModelKey,
    scorers: suite.scorers.map((s) => ({
      type: s.type,
      weight: s.weight,
      rubric: s.rubric,
      threshold: s.threshold,
    })),
    created_at: suite.createdAt,
  };
}

function toAggregate(a?: IEvaluationRunAggregate): Record<string, unknown> | undefined {
  if (!a) return undefined;
  return {
    total: a.total,
    completed: a.completed,
    failed: a.failed,
    passed: a.passed,
    pass_rate: a.passRate,
    avg_score: a.avgScore,
    avg_latency_ms: a.avgLatencyMs,
  };
}

/** Run envelope without the (potentially large) per-item array. */
export function toRunSummary(run: WithId<IEvaluationRun>): Record<string, unknown> {
  return {
    id: run.id,
    suite_key: run.suiteKey,
    target_key: run.targetKey,
    dataset_key: run.datasetKey,
    status: run.status,
    agent_revision: agentRevisionApiView(run.agentRevision),
    aggregate: toAggregate(run.aggregate),
    error: run.error,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    created_at: run.createdAt,
  };
}

/** Full run envelope, including per-item scores. */
export function toRunView(run: WithId<IEvaluationRun>): Record<string, unknown> {
  return {
    ...toRunSummary(run),
    items: (run.items ?? []).map((it) => ({
      item_id: it.itemId,
      passed: it.passed,
      score: it.score,
      latency_ms: it.latencyMs,
      output_text: it.output?.text,
      error: it.error,
      ...(it.restricted ? { restricted: true } : {}),
      scores: it.scores.map((s) => ({
        scorer_type: s.scorerType,
        score: s.score,
        passed: s.passed,
        weight: s.weight,
        error: s.error,
      })),
    })),
  };
}
