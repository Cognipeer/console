/**
 * Analysis run queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the OCR / evaluation / red-team consumers: on single-node (memory
 * queue) deployments it drains locally (so the run executes in the background,
 * off the HTTP request); on multi-node BullMQ deployments it executes runs
 * routed to this node.
 */

import { createLogger } from '@/lib/core/logger';
import { runJobUnderLease } from '@/lib/services/planLeases';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { ANALYSIS_RUN_JOB, ANALYSIS_RUN_QUEUE, runDefinitionJob, type AnalysisRunJobPayload } from './analysisRunJob';

const log = createLogger('analysis:consumer');
let started = false;

/** How many analysis runs may execute concurrently on this node. */
const CONCURRENCY = Math.max(1, Number(process.env.ANALYSIS_RUN_CONCURRENCY ?? 2) || 2);

export async function startAnalysisRunQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    ANALYSIS_RUN_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === ANALYSIS_RUN_JOB) {
        const payload = ctx.data as unknown as AnalysisRunJobPayload;
        // Plan limit (background jobs): one 'job' lease per run; a full pool requeues the run with a delay.
        const leased = await runJobUnderLease({
          tenantId: payload.tenantId,
          holderId: payload.runId,
          queueName: ANALYSIS_RUN_QUEUE,
          jobName: ANALYSIS_RUN_JOB,
          payload,
          run: () => runDefinitionJob(payload),
        });
        return { ok: true, ...(leased.deferred ? { deferred: true } : {}) };
      }
      throw new Error(`Unknown analysis job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Analysis run queue consumer registered', { concurrency: CONCURRENCY });
}
