/**
 * Evaluation run queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the OCR / red-team consumers: on single-node (memory queue)
 * deployments it drains locally (so the run executes in the background, off the
 * HTTP request); on multi-node BullMQ deployments it executes runs routed to
 * this node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { EVALUATION_RUN_JOB, EVALUATION_RUN_QUEUE, runSuiteJob, type EvaluationRunJobPayload } from './evaluationRunJob';

const log = createLogger('evaluation:consumer');
let started = false;

/** How many evaluation runs may execute concurrently on this node. */
const CONCURRENCY = Math.max(1, Number(process.env.EVALUATION_RUN_CONCURRENCY ?? 2) || 2);

export async function startEvaluationRunQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    EVALUATION_RUN_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === EVALUATION_RUN_JOB) {
        await runSuiteJob(ctx.data as unknown as EvaluationRunJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown evaluation job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Evaluation run queue consumer registered', { concurrency: CONCURRENCY });
}
