/**
 * Shared serializers for the client Evaluation surface.
 *
 * The external client API (`/api/client/v1/evaluation/*`) is read- and
 * trigger-oriented: callers discover their configured **suites**, trigger a
 * **run**, and read back **run** results. Suite/target/dataset *authoring*
 * stays on the dashboard surface (an admin concern).
 *
 * These helpers shape the internal camelCase records into the snake_case
 * envelope the other client modules use, so both the served Fastify plugin and
 * the route handlers below share one source of truth.
 */

import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';
import {
  getRun,
  listRuns,
  listSuites,
  runSuite,
  type WithId,
} from '@/lib/services/evaluation/service';
import type {
  IEvaluationRun,
  IEvaluationRunAggregate,
  IEvaluationSuite,
} from '@/lib/database';

const logger = createLogger('client-evaluation');

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

function clampLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 200);
}

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : 'Internal error';
  logger.error(`${scope} error`, { error });
  return NextResponse.json(
    { error: message },
    { status: message.toLowerCase().includes('not found') ? 404 : 500 },
  );
}

// ── Route handlers (mirror layer; shared with the Fastify plugin) ──────────

/** GET /client/v1/evaluation/suites — list configured suites. */
export const suitesListHandler = withRequestContext(async (request: NextRequest) => {
  try {
    const ctx = await requireApiToken(request);
    const suites = await listSuites(ctx.tenantDbName, { projectId: ctx.projectId });
    return NextResponse.json({ suites: suites.map(toSuiteView) });
  } catch (error) {
    return handleError(error, 'List suites');
  }
});

/** POST /client/v1/evaluation/suites/:key/run — trigger a run (synchronous). */
export const suiteRunHandler = withRequestContext(
  async (request: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
    try {
      const ctx = await requireApiToken(request);
      const { key } = await params;
      if (!key) return NextResponse.json({ error: 'suite key is required' }, { status: 400 });
      const run = await runSuite({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        createdBy: ctx.tokenRecord.userId ?? 'api-token',
        suiteKey: key,
      });
      return NextResponse.json({ run: toRunView(run) }, { status: 201 });
    } catch (error) {
      return handleError(error, 'Run suite');
    }
  },
);

/** GET /client/v1/evaluation/runs — list runs, newest first. */
export const runsListHandler = withRequestContext(async (request: NextRequest) => {
  try {
    const ctx = await requireApiToken(request);
    const { searchParams } = new URL(request.url);
    const runs = await listRuns(ctx.tenantDbName, {
      projectId: ctx.projectId,
      suiteKey: searchParams.get('suite_key') ?? undefined,
      limit: clampLimit(searchParams.get('limit')),
    });
    return NextResponse.json({ runs: runs.map(toRunSummary) });
  } catch (error) {
    return handleError(error, 'List runs');
  }
});

/** GET /client/v1/evaluation/runs/:id — get one run with its per-item scores. */
export const runGetHandler = withRequestContext(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    try {
      const ctx = await requireApiToken(request);
      const { id } = await params;
      const run = await getRun(ctx.tenantDbName, id);
      if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
      return NextResponse.json({ run: toRunView(run) });
    } catch (error) {
      return handleError(error, 'Get run');
    }
  },
);
