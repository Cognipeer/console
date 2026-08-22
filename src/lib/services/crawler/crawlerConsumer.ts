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

/**
 * Concurrent crawl jobs per node.
 *
 * Kept lower than the other consumers on purpose: a single job already fans out
 * to as many as 16 concurrent fetches and may drive a Chromium instance, so the
 * real footprint is this number multiplied by that fan-out.
 */
const CONCURRENCY = Math.max(1, Number(process.env.CRAWLER_RUN_CONCURRENCY ?? 2) || 2);

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
  }, { concurrency: CONCURRENCY });
  started = true;
  log.info('Crawler queue consumer registered', { concurrency: CONCURRENCY });
}
