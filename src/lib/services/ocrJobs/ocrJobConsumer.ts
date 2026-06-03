/**
 * OCR job queue consumer – registered on every node at bootstrap.
 *
 * On single-node (memory queue) deployments this is effectively a no-op
 * because `routeInstanceCall` short-circuits to the local handler. On
 * multi-node BullMQ deployments this executes jobs forwarded to this node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { processOcrItem } from './ocrJobRunner';
import type { OcrJobContext } from './types';

const log = createLogger('ocr-job:consumer');
let started = false;

interface ItemPayload {
  ctx: OcrJobContext;
  itemId: string;
}

/** Per-item processing concurrency (BullMQ worker / memory drain). */
const CONCURRENCY = Math.max(1, Number(process.env.OCR_ITEM_CONCURRENCY ?? 5) || 5);

export async function startOcrJobQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    queueNameFor('ocr'),
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === 'ocr.item') {
        const payload = ctx.data as unknown as ItemPayload;
        await processOcrItem(payload.ctx, payload.itemId);
        return { ok: true };
      }
      throw new Error(`Unknown OCR job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('OCR job queue consumer registered', { concurrency: CONCURRENCY });
}
