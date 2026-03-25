/**
 * Background auto-poll scheduler for inference monitoring servers.
 *
 * Each server has a `pollIntervalSeconds` field.  Every CHECK_INTERVAL_MS
 * (default 30 s) the scheduler iterates all tenants and, for each active
 * server whose last poll is older than its configured interval, fires a poll.
 *
 * IMPORTANT: The MongoDB provider is a shared singleton with mutable
 * `tenantDb` state.  To avoid cross-tenant data races we process tenants
 * ONE AT A TIME (for…of, not Promise.all across tenants).  Within a single
 * tenant we can poll multiple due servers concurrently because they all
 * target the same tenant DB.
 */

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { InferenceMonitoringService } from './inferenceMonitoringService';

const logger = createLogger('poll-scheduler');

const CHECK_INTERVAL_MS = 30_000; // how often to scan for due servers

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return; // skip if previous tick is still in progress
  running = true;

  try {
    // 1. Fetch all tenants from the main database (no tenant switch needed).
    const mainDb = await getDatabase();
    const tenants = await mainDb.listTenants();

    for (const tenant of tenants) {
      if (!tenant.dbName) continue;

      try {
        // 2. Switch to the tenant DB and list active servers.
        const tenantDb = await getTenantDatabase(tenant.dbName);
        const tenantId = String(tenant._id);
        const servers = await tenantDb.listInferenceServers(tenantId);

        const now = Date.now();
        const dueServers = servers.filter((s) => {
          if (s.status === 'disabled') return false;
          if (!s.lastPolledAt) return true; // never polled yet → always due
          const lastPollMs = new Date(s.lastPolledAt).getTime();
          return now - lastPollMs >= s.pollIntervalSeconds * 1000;
        });

        if (dueServers.length === 0) continue;

        // 3. Poll all due servers for this tenant concurrently.
        //    All of them use the same tenant DB so concurrent access is safe.
        await Promise.allSettled(
          dueServers.map((server) =>
            InferenceMonitoringService.pollServer(tenant.dbName, tenantId, server.key).catch(
              (err) => {
                logger.error(`Error polling ${tenant.slug}/${server.key}`, {
                  error: err instanceof Error ? err.message : err,
                });
              },
            ),
          ),
        );
      } catch (err) {
        logger.error(`Error processing tenant ${tenant.slug}`, {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  } catch (err) {
    logger.error('Fatal error during run', { error: err instanceof Error ? err.message : err });
  } finally {
    running = false;
  }
}

/**
 * Start the auto-poll background scheduler.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startPollScheduler(): void {
  if (schedulerTimer !== null) return;
  logger.info(`Started (check interval: ${CHECK_INTERVAL_MS / 1000}s)`);

  // Run once immediately on startup (don't block server boot).
  void runOnce();

  schedulerTimer = setInterval(() => {
    void runOnce();
  }, CHECK_INTERVAL_MS);

  // Prevent the timer from keeping the process alive in test environments.
  if (schedulerTimer.unref) {
    schedulerTimer.unref();
  }
}

/**
 * Stop the scheduler (useful for graceful shutdown / tests).
 */
export function stopPollScheduler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('Stopped');
  }
}
