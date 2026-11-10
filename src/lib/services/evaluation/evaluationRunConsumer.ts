/**
 * Evaluation run queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the OCR / red-team consumers: on single-node (memory queue)
 * deployments it drains locally (so the run executes in the background, off the
 * HTTP request); on multi-node BullMQ deployments it executes runs routed to
 * this node.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { runJobUnderLease } from '@/lib/services/planLeases';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { EVALUATION_RUN_JOB, EVALUATION_RUN_QUEUE, runSuiteJob, type EvaluationRunJobPayload } from './evaluationRunJob';

const log = createLogger('evaluation:consumer');
let started = false;

/** How many evaluation runs may execute concurrently on this node. */
const concurrency = () => getConfig().queues.evaluationRunConcurrency;

export async function startEvaluationRunQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    EVALUATION_RUN_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === EVALUATION_RUN_JOB) {
        const payload = ctx.data as unknown as EvaluationRunJobPayload;
        // Plan limit (background jobs): one 'job' lease per run; a full pool requeues the run with a delay.
        const leased = await runJobUnderLease({
          tenantId: payload.tenantId,
          holderId: payload.runId,
          queueName: EVALUATION_RUN_QUEUE,
          jobName: EVALUATION_RUN_JOB,
          payload,
          run: () => runSuiteJob(payload),
        });
        return { ok: true, ...(leased.deferred ? { deferred: true } : {}) };
      }
      throw new Error(`Unknown evaluation job: ${ctx.name}`);
    },
    { concurrency: concurrency() },
  );
  started = true;
  log.info('Evaluation run queue consumer registered', { concurrency: concurrency() });
}
