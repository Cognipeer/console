/**
 * Async analysis run — queue enqueue + job runner.
 *
 * Analyzing a corpus (N conversations × extraction, optional judge/accuracy)
 * can take many model calls, so the interactive dashboard must not block the
 * HTTP request on it:
 *   1. `enqueueDefinitionRun` creates a `pending` run and publishes a job.
 *   2. The queue consumer (see `analysisRunConsumer`) calls `runDefinitionJob`,
 *      which drives `executeRun` to completion.
 *
 * Progress + results live on the run row, so the dashboard polls the normal run
 * detail endpoint to watch a run finish.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { createAsyncRun, executeRun, type RunDefinitionParams, type WithId } from './service';
import type { IAnalysisRun } from '@/lib/database';

const logger = createLogger('analysis:job');

export const ANALYSIS_RUN_QUEUE = 'analysis-run';
export const ANALYSIS_RUN_JOB = 'analysis.run';

export interface AnalysisRunJobPayload extends QueuePayload, RunDefinitionParams {
  runId: string;
}

/** Create the pending run and publish the job. Returns the run immediately. */
export async function enqueueDefinitionRun(params: RunDefinitionParams): Promise<WithId<IAnalysisRun>> {
  const { run, conversationKeys } = await createAsyncRun(params);

  // Pin the job to the exact resolved keys so a random/unanalyzed selection is
  // sampled once (at enqueue time) and not re-sampled by the consumer.
  const payload: AnalysisRunJobPayload = { ...params, selection: undefined, conversationKeys, runId: run.id };
  const queue = await getQueue();
  await queue.publish(ANALYSIS_RUN_QUEUE, ANALYSIS_RUN_JOB, payload, { attempts: 1, backoffMs: 5000 });
  logger.info('Analysis run enqueued', { runId: run.id, definitionKey: params.definitionKey });

  return run;
}

/** Execute one queued analysis run. Throws on a fatal error so the queue records it. */
export async function runDefinitionJob(payload: AnalysisRunJobPayload): Promise<void> {
  await executeRun({
    tenantDbName: payload.tenantDbName,
    tenantId: payload.tenantId,
    projectId: payload.projectId,
    createdBy: payload.createdBy,
    definitionKey: payload.definitionKey,
    conversationKeys: payload.conversationKeys,
    runId: payload.runId,
  });
  logger.info('Analysis run completed', { runId: payload.runId, definitionKey: payload.definitionKey });
}
