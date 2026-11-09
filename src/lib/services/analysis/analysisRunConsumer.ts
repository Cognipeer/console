/**
 * Analysis run queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the OCR / evaluation / red-team consumers: on single-node (memory
 * queue) deployments it drains locally (so the run executes in the background,
 * off the HTTP request); on multi-node BullMQ deployments it executes runs
 * routed to this node.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { ANALYSIS_RUN_JOB, ANALYSIS_RUN_QUEUE, runDefinitionJob, type AnalysisRunJobPayload } from './analysisRunJob';

const log = createLogger('analysis:consumer');
let started = false;

/** How many analysis runs may execute concurrently on this node. */
const concurrency = () => getConfig().queues.analysisRunConcurrency;

export async function startAnalysisRunQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    ANALYSIS_RUN_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === ANALYSIS_RUN_JOB) {
        await runDefinitionJob(ctx.data as unknown as AnalysisRunJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown analysis job: ${ctx.name}`);
    },
    { concurrency: concurrency() },
  );
  started = true;
  log.info('Analysis run queue consumer registered', { concurrency: concurrency() });
}
