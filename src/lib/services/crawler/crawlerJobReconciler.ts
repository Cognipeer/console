/**
 * Startup reconciliation for orphaned crawl jobs.
 *
 * Mirrors `reconcileOrphanedBrowserSessions()`: on a fresh boot (crash,
 * OOM kill, redeploy, manual restart, ...) any job this node was in the
 * middle of running has no way to ever reach a terminal state on its own —
 * `runCrawlJobLocal`'s `finally` block (which persists `succeeded` /
 * `partial` / `failed` / `canceled`) never got a chance to run, so the DB
 * row is stuck at `running` forever. Cancel doesn't help either: it only
 * stamps `cancelRequestedAt`, which the (now-dead) runner's poll loop was
 * responsible for observing.
 *
 * On top of that, this deployment's default queue provider is the
 * in-memory one (no Redis configured — see docker-compose.yml). A job
 * dispatched with `mode: 'async'` (the dashboard default) is published to
 * an in-process queue; if the process dies before the message is consumed,
 * the message is lost outright but the job's DB row is still `queued`,
 * so it sits there forever too.
 *
 * This reconciler runs once at bootstrap, before the queue consumer/
 * scheduler start taking new work, and:
 *  - marks any `running` job as `failed` (nothing is executing it anymore);
 *  - re-publishes any `queued` job so it actually gets picked up now that
 *    the crawler queue consumer is back online.
 */

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import type { CrawlerContext } from './types';

const logger = createLogger('crawler:reconcile');

const ORPHANED_RUNNING_MESSAGE =
  'Crawl job orphaned by a server restart before it finished. Please re-run the crawler.';

export async function reconcileOrphanedCrawlJobs(): Promise<{
  tenantsScanned: number;
  failedRunningJobs: number;
  requeuedJobs: number;
}> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const queue = await getQueue();

  let tenantsScanned = 0;
  let failedRunningJobs = 0;
  let requeuedJobs = 0;

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    tenantsScanned += 1;
    const tenantId = String(tenant._id);

    try {
      const tenantDb = await getTenantDatabase(tenant.dbName);

      const runningJobs = await tenantDb.listCrawlJobs(tenantId, { status: 'running' });
      for (const job of runningJobs) {
        const endedAt = new Date();
        const finalized = await tenantDb.finalizeCrawlJob(String(job._id), tenantId, {
          status: 'failed',
          endedAt,
          durationMs: job.startedAt ? endedAt.getTime() - job.startedAt.getTime() : undefined,
          errorMessage: ORPHANED_RUNNING_MESSAGE,
        });
        if (finalized) failedRunningJobs += 1;
      }

      const queuedJobs = await tenantDb.listCrawlJobs(tenantId, { status: 'queued' });
      for (const job of queuedJobs) {
        const ctx: CrawlerContext = {
          tenantDbName: tenant.dbName,
          tenantId,
          projectId: job.projectId,
        };
        const payload = { ctx, jobId: String(job._id) } as unknown as QueuePayload;
        await queue.publish(queueNameFor('crawler'), 'crawler.run', payload, { attempts: 1 });
        requeuedJobs += 1;
      }
    } catch (error) {
      logger.warn('Failed to reconcile tenant crawl jobs', {
        error: error instanceof Error ? error.message : String(error),
        tenantDbName: tenant.dbName,
        tenantSlug: tenant.slug,
      });
    }
  }

  if (failedRunningJobs > 0 || requeuedJobs > 0) {
    logger.info('Reconciled orphaned crawl jobs', {
      tenantsScanned,
      failedRunningJobs,
      requeuedJobs,
    });
  }

  return { tenantsScanned, failedRunningJobs, requeuedJobs };
}
