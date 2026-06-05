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
import { createAsyncRun, executeRun, type RunSuiteParams, type WithId } from './service';
import type { IEvaluationRun } from '@/lib/database';

const logger = createLogger('evaluation:job');

export const EVALUATION_RUN_QUEUE = 'evaluation-run';
export const EVALUATION_RUN_JOB = 'evaluation.run';

export interface EvaluationRunJobPayload extends QueuePayload, RunSuiteParams {
  runId: string;
}

/**
 * Create the pending run and publish the job. Returns the run immediately
 * (status `pending`) so the caller can respond fast.
 */
export async function enqueueSuiteRun(params: RunSuiteParams): Promise<WithId<IEvaluationRun>> {
  const run = await createAsyncRun(params);

  const payload: EvaluationRunJobPayload = { ...params, runId: run.id };
  const queue = await getQueue();
  await queue.publish(EVALUATION_RUN_QUEUE, EVALUATION_RUN_JOB, payload, { attempts: 1, backoffMs: 5000 });
  logger.info('Evaluation run enqueued', { runId: run.id, suiteKey: params.suiteKey });

  return run;
}

/** Execute one queued run. Throws on a fatal error so the queue can record it. */
export async function runSuiteJob(payload: EvaluationRunJobPayload): Promise<void> {
  await executeRun({
    tenantDbName: payload.tenantDbName,
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    createdBy: payload.createdBy,
    suiteKey: payload.suiteKey,
    runId: payload.runId,
  });
  logger.info('Evaluation run completed', { runId: payload.runId, suiteKey: payload.suiteKey });
}
