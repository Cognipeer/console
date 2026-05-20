/**
 * Crawler queue consumer – registered on every node at bootstrap.
 *
 * On single-node deployments using the in-memory queue this is a no-op
 * because `routeInstanceCall` short-circuits to the local handler. On
 * multi-node BullMQ deployments this is what executes runs forwarded
 * to a specific node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { runCrawlJobLocal } from './crawlerJobService';
import type { CrawlerContext } from './types';

const log = createLogger('crawler.consumer');
let started = false;

interface RunPayload {
  ctx: CrawlerContext;
  jobId: string;
}

export async function startCrawlerQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(queueNameFor('crawler'), async (ctx: JobContext<QueuePayload>) => {
    if (ctx.name === 'crawler.run') {
      const payload = ctx.data as unknown as RunPayload;
      await runCrawlJobLocal(payload.ctx, payload.jobId);
      return { ok: true };
    }
    throw new Error(`Unknown crawler job: ${ctx.name}`);
  });
  started = true;
  log.info('Crawler queue consumer registered');
}
