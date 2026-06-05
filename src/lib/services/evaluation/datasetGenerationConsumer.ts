/**
 * Dataset generation queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the OCR job consumer: on single-node (memory queue) deployments it
 * drains locally; on multi-node BullMQ deployments it executes jobs routed to
 * this node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import {
  DATASET_GEN_JOB,
  DATASET_GEN_QUEUE,
  runDatasetGenerationJob,
  type DatasetGenerationJobPayload,
} from './datasetGenerationJob';

const log = createLogger('eval-dataset-gen:consumer');
let started = false;

/** How many generation jobs may run concurrently on this node. */
const CONCURRENCY = Math.max(1, Number(process.env.DATASET_GEN_CONCURRENCY ?? 2) || 2);

export async function startDatasetGenerationConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    DATASET_GEN_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === DATASET_GEN_JOB) {
        await runDatasetGenerationJob(ctx.data as unknown as DatasetGenerationJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown dataset generation job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Dataset generation queue consumer registered', { concurrency: CONCURRENCY });
}
