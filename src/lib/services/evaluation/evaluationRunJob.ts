/**
 * Async evaluation run — queue enqueue + job runner.
 *
 * A suite run (N dataset items × target call × scorers, possibly with an LLM
 * judge or embeddings) can take many model calls, so the interactive dashboard
 * must not block the HTTP request on it:
 *   1. `enqueueSuiteRun` creates a `pending` run and publishes a job.
 *   2. The queue consumer (see `evaluationRunConsumer`) calls `runSuiteJob`,
 *      which drives `executeRun` to completion.
 *
 * Progress + results live on the run row, so the dashboard polls the normal run
 * detail endpoint to watch a run finish.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { createAsyncRun, executeRun, markRunFailed, type RunSuiteParams, type WithId } from './service';
import type { EvaluationRunActorType, IEvaluationRun } from '@/lib/database';

const logger = createLogger('evaluation:job');

export const EVALUATION_RUN_QUEUE = 'evaluation-run';
export const EVALUATION_RUN_JOB = 'evaluation.run';

/**
 * What a queued run carries: the run's parameters without the hook that answered for the request that made it. The
 * caller (`actorType`, `apiTokenId`) rides along and must match the one stored with the run; a job queued before runs
 * recorded their caller has none, and its run is failed rather than run as anybody (see `executeRun`).
 */
export interface EvaluationRunJobPayload extends QueuePayload, Omit<RunSuiteParams, 'authorizeAgentRun' | 'actorType'> {
  actorType?: EvaluationRunActorType;
  runId: string;
}

/**
 * Create the pending run and publish the job. Returns the run immediately
 * (status `pending`) so the caller can respond fast.
 */
export async function enqueueSuiteRun(params: RunSuiteParams): Promise<WithId<IEvaluationRun>> {
  const run = await createAsyncRun(params);

  const payload: EvaluationRunJobPayload = {
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    projectId: params.projectId,
    createdBy: params.createdBy,
    actorType: params.actorType,
    ...(params.apiTokenId ? { apiTokenId: params.apiTokenId } : {}),
    suiteKey: params.suiteKey,
    agentVersion: params.agentVersion,
    runId: run.id,
  };
  try {
    const queue = await getQueue();
    await queue.publish(EVALUATION_RUN_QUEUE, EVALUATION_RUN_JOB, payload, { attempts: 1, backoffMs: 5000 });
  } catch (error) {
    // The row exists but nothing will ever run it: leaving it pending would
    // block the suite's next run (the duplicate guard counts pending runs).
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Could not queue the evaluation run', { runId: run.id, error: message });
    await markRunFailed(params.tenantDbName, run.id, `Could not queue the run: ${message}`).catch(() => undefined);
    throw error;
  }
  logger.info('Evaluation run enqueued', { runId: run.id, suiteKey: params.suiteKey });

  return run;
}

/** Execute one queued run. Throws on a fatal error so the queue can record it. */
export async function runSuiteJob(payload: EvaluationRunJobPayload): Promise<void> {
  const run = await executeRun({
    tenantDbName: payload.tenantDbName,
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    createdBy: payload.createdBy,
    ...(payload.actorType ? { actorType: payload.actorType } : {}),
    ...(payload.apiTokenId ? { apiTokenId: payload.apiTokenId } : {}),
    suiteKey: payload.suiteKey,
    runId: payload.runId,
    agentVersion: payload.agentVersion,
  });
  logger.info('Evaluation run finished', { runId: payload.runId, suiteKey: payload.suiteKey, status: run.status });
}
