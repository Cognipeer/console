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
 * This is a MULTI-POD deployment, so a `running` job is not necessarily
 * orphaned by the node that's currently booting — it may be genuinely,
 * successfully executing on a live sibling node right now. `claimCrawlJob`
 * stamps the claiming node's identity onto the job (`nodeId`); this
 * reconciler only fails a `running` job when its owning node is NOT
 * currently online (heartbeating), so it never steals/fails work that
 * another still-alive pod is legitimately doing. Jobs claimed before this
 * `nodeId` tracking existed have no recorded owner and are treated as
 * orphaned (matches the old, pre-fix behavior).
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
 *  - marks any `running` job whose owning node is no longer online as
 *    `failed` (nothing is executing it anymore);
 *  - re-publishes any `queued` job so it actually gets picked up now that
 *    the crawler queue consumer is back online (safe even if another node
 *    concurrently republishes the same job — `claimCrawlJob`'s atomic CAS
 *    ensures only one runner wins).
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

  // This deployment is multi-pod (see `cluster.node-registry`): a job
  // `running` in the DB may genuinely be executing on a live sibling node,
  // not the node that happens to be booting right now. Only nodes still
  // heartbeating count as "online" here — a crashed node's row is flipped
  // to offline by `sweepStaleNodes()` once its heartbeat goes stale. Jobs
  // claimed before `nodeId` tracking existed have no owner on record and
  // are treated as orphaned, matching the old (pre-fix) behavior.
  const onlineNodeNames = new Set((await mainDb.listNodes({ status: 'online' })).map((n) => n.name));

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
        // Owned by a node that's still alive elsewhere — not orphaned,
        // leave it alone so its real result can persist when it finishes.
        if (job.nodeId && onlineNodeNames.has(job.nodeId)) continue;

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
