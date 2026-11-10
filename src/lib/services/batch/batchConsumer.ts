/**
 * Batch queue consumer – registered on every node at bootstrap.
 *
 * On single-node (memory queue) deployments the in-process driver drains the
 * fan-out; on multi-node BullMQ deployments this executes items forwarded to
 * this node.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { processBatchItem } from './batchRunner';
import type { BatchContext } from './types';

const log = createLogger('batch:consumer');
let started = false;

interface ItemPayload {
  ctx: BatchContext;
  itemId: string;
}

/** Per-item processing concurrency (BullMQ worker / memory drain). */
const concurrency = () => getConfig().queues.batchItemConcurrency;

export async function startBatchQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    queueNameFor('batch'),
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === 'batch.item') {
        const payload = ctx.data as unknown as ItemPayload;
        await processBatchItem(payload.ctx, payload.itemId);
        return { ok: true };
      }
      throw new Error(`Unknown batch job: ${ctx.name}`);
    },
    { concurrency: concurrency() },
  );
  started = true;
  log.info('Batch queue consumer registered', { concurrency: concurrency() });
}
