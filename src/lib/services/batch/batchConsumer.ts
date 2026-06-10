/**
 * Batch queue consumer – registered on every node at bootstrap.
 *
 * On single-node (memory queue) deployments the in-process driver drains the
 * fan-out; on multi-node BullMQ deployments this executes items forwarded to
 * this node.
 */

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
const CONCURRENCY = Math.max(1, Number(process.env.BATCH_ITEM_CONCURRENCY ?? 4) || 4);

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
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Batch queue consumer registered', { concurrency: CONCURRENCY });
}
