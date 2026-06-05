/**
 * Crawler queue consumer – registered on every node at bootstrap.
 *
 * Drains the crawler queue and runs each job via `runCrawlJobLocal`. It is
 * the executor for:
 *   - async runs (the default for the HTTP API / dashboard): the service
 *     `publish()`es the job and returns immediately, and this consumer picks
 *     it up — including on single-node in-memory deployments;
 *   - multi-node BullMQ sync runs forwarded to a specific node via
 *     `routeInstanceCall`.
 *
 * For single-node sync runs the service short-circuits to the local handler
 * directly, so this consumer isn't involved.
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
