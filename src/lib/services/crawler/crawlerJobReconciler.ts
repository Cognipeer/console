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
 *  - re-publishes any `queued` job so it actually gets picked up now that
 *    the crawler queue consumer is back online;
 *  - for `running` jobs (nothing is executing them anymore) by default
 *    restarts them from scratch — clears the partial results the dead run
 *    wrote, resets the job to `queued`, bumps a bounded per-job restart
 *    counter and re-publishes it — so an interrupted crawl recovers on its
 *    own. After MAX_ORPHAN_RESTARTS the job is failed instead (guards against
 *    a crash-looping crawl). Set CRAWLER_RESTART_ORPHANED_RUNS=false to skip
 *    auto-restart and fail orphaned runs outright for manual re-run.
 */

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import type { CrawlerContext } from './types';

const logger = createLogger('crawler:reconcile');

const ORPHANED_RUNNING_MESSAGE =
  'Crawl job orphaned by a server restart before it finished. Please re-run the crawler.';

// How many times a single job may be auto-restarted after being orphaned by a
// restart. Bounded on purpose: a crawl that reliably crashes the process (e.g.
// OOM on a huge PDF) would otherwise restart → crash → restart forever and take
// the whole service down with it (see [[prod-crash-analysis-crawler]]). After
// the cap the job is failed so an operator can look at it.
const MAX_ORPHAN_RESTARTS = 2;

export async function reconcileOrphanedCrawlJobs(): Promise<{
  tenantsScanned: number;
  failedRunningJobs: number;
  restartedRunningJobs: number;
  requeuedJobs: number;
}> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const queue = await getQueue();
  // Auto-restart interrupted crawls by default (bounded per job below). Set
  // CRAWLER_RESTART_ORPHANED_RUNS=false to instead fail them for manual re-run.
  const autoRestart = process.env.CRAWLER_RESTART_ORPHANED_RUNS !== 'false';

  let tenantsScanned = 0;
  let failedRunningJobs = 0;
  let restartedRunningJobs = 0;
  let requeuedJobs = 0;

  const republish = async (
    tenantDbName: string,
    tenantId: string,
    job: { _id?: unknown; projectId?: string },
  ): Promise<void> => {
    const ctx: CrawlerContext = { tenantDbName, tenantId, projectId: job.projectId };
    const payload = { ctx, jobId: String(job._id) } as unknown as QueuePayload;
    await queue.publish(queueNameFor('crawler'), 'crawler.run', payload, { attempts: 1 });
  };

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    tenantsScanned += 1;
    const tenantId = String(tenant._id);

    try {
      const tenantDb = await getTenantDatabase(tenant.dbName);

      const runningJobs = await tenantDb.listCrawlJobs(tenantId, { status: 'running' });
      for (const job of runningJobs) {
        const jobId = String(job._id);
        const priorRestarts = Number(
          (job.metadata as Record<string, unknown> | undefined)?.orphanRestarts ?? 0,
        );
        const canRestart = autoRestart && priorRestarts < MAX_ORPHAN_RESTARTS;
        if (canRestart) {
          // Restart from scratch: drop the partial results the dead run wrote
          // (so the fresh run doesn't append duplicates), reset counters to
          // `queued`, bump the restart tally, and re-publish. Idempotent claim
          // (claimCrawlJob) still guards against a redelivered message
          // double-running it.
          await tenantDb.deleteCrawlResultsByJob(jobId);
          const reset = await tenantDb.updateCrawlJob(jobId, {
            status: 'queued',
            startedAt: undefined,
            endedAt: undefined,
            durationMs: undefined,
            pagesProcessed: 0,
            filesProcessed: 0,
            errorsCount: 0,
            limitReached: false,
            errorMessage: undefined,
            metadata: { ...(job.metadata ?? {}), orphanRestarts: priorRestarts + 1 },
          });
          if (reset) {
            await republish(tenant.dbName, tenantId, job);
            restartedRunningJobs += 1;
          }
        } else {
          const endedAt = new Date();
          const finalized = await tenantDb.finalizeCrawlJob(jobId, tenantId, {
            status: 'failed',
            endedAt,
            durationMs: job.startedAt ? endedAt.getTime() - job.startedAt.getTime() : undefined,
            errorMessage: autoRestart
              ? `${ORPHANED_RUNNING_MESSAGE} (gave up after ${MAX_ORPHAN_RESTARTS} auto-restarts)`
              : ORPHANED_RUNNING_MESSAGE,
          });
          if (finalized) failedRunningJobs += 1;
        }
      }

      const queuedJobs = await tenantDb.listCrawlJobs(tenantId, { status: 'queued' });
      for (const job of queuedJobs) {
        await republish(tenant.dbName, tenantId, job);
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

  if (failedRunningJobs > 0 || restartedRunningJobs > 0 || requeuedJobs > 0) {
    logger.info('Reconciled orphaned crawl jobs', {
      tenantsScanned,
      failedRunningJobs,
      restartedRunningJobs,
      requeuedJobs,
    });
  }

  return { tenantsScanned, failedRunningJobs, restartedRunningJobs, requeuedJobs };
}
