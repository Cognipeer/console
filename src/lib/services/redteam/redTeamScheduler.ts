/**
 * Background red-team scheduler.
 *
 * Every REDTEAM_CHECK_INTERVAL_MS it iterates tenants and enqueues a scan for
 * any campaign whose cron schedule is due (e.g. nightly safety regression). A
 * distributed lock (Redis cache provider in multi-instance deployments) keeps a
 * single instance firing each tick. Mirrors the analysis scheduler; the actual
 * scans run on the queue, so the tick stays cheap.
 */

import { getDatabase, runWithTenantScope } from '@/lib/database';
import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import { runScheduledScans } from './campaignJob';

const logger = createLogger('redteam-scheduler');

const REDTEAM_CHECK_INTERVAL_MS = 60_000;
const SCHEDULER_LOCK_KEY = 'scheduler:redteam-scans';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  let lockToken: string | undefined;
  try {
    const cache = await getCache();
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    if (!lockToken) return; // another instance owns this tick

    const mainDb = await getDatabase();
    const tenants = await mainDb.listTenants();
    for (const tenant of tenants) {
      if (!tenant.dbName) continue;
      try {
        // Timer context: bind the tenant for the whole per-tenant run (see
        // runWithTenantScope — switchToTenant alone races cross-tenant).
        const { fired, errors } = await runWithTenantScope(tenant.dbName, () =>
          runScheduledScans(tenant.dbName!, String(tenant._id)));
        if (fired.length > 0) {
          logger.info(`Tenant ${tenant.slug}: enqueued ${fired.length} scheduled red-team scan(s)`, { campaigns: fired });
        }
        if (errors.length > 0) {
          logger.warn(`Tenant ${tenant.slug}: ${errors.length} scheduled red-team skip/error(s)`, { errors });
        }
      } catch (err) {
        logger.error(`Error running scheduled scans for tenant ${tenant.slug}`, {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  } catch (err) {
    logger.error('Fatal error during run', { error: err instanceof Error ? err.message : err });
  } finally {
    if (lockToken) {
      try {
        const cache = await getCache();
        await cache.releaseLock(SCHEDULER_LOCK_KEY, lockToken);
      } catch (err) {
        logger.warn('Failed to release scheduler lock', { error: err instanceof Error ? err.message : err });
      }
    }
    running = false;
  }
}

/** Start the background scheduler. Safe to call multiple times. */
export function startRedTeamScheduler(): void {
  if (schedulerTimer !== null) return;
  logger.info(`Started (check interval: ${REDTEAM_CHECK_INTERVAL_MS / 1000}s)`);
  setTimeout(() => void runOnce(), 9_000);
  schedulerTimer = setInterval(() => void runOnce(), REDTEAM_CHECK_INTERVAL_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

export function stopRedTeamScheduler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('Stopped');
  }
}
