/**
 * Background alert evaluation scheduler.
 *
 * Runs every ALERT_CHECK_INTERVAL_MS (default 60 s), iterates all tenants,
 * and evaluates active alert rules for each one.
 *
 * Follows the same sequential-per-tenant pattern as the inference poll
 * scheduler to avoid cross-tenant DB races on the shared MongoDB singleton.
 */

import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { evaluateTenantAlerts } from './alertEvaluator';

const logger = createLogger('alert-scheduler');

const ALERT_CHECK_INTERVAL_MS = 60_000; // 60 seconds

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const mainDb = await getDatabase();
    const tenants = await mainDb.listTenants();

    for (const tenant of tenants) {
      if (!tenant.dbName) continue;

      try {
        const firedCount = await evaluateTenantAlerts({
          tenantDbName: tenant.dbName,
          tenantId: String(tenant._id),
          tenantSlug: tenant.slug,
          companyName: tenant.companyName,
        });

        if (firedCount > 0) {
          logger.info(`Tenant ${tenant.slug}: ${firedCount} alert(s) fired`);
        }
      } catch (err) {
        logger.error(`Error evaluating alerts for tenant ${tenant.slug}`, {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
  } catch (err) {
    logger.error('Fatal error during run', {
      error: err instanceof Error ? err.message : err,
    });
  } finally {
    running = false;
  }
}

/**
 * Start the alert evaluation background scheduler.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startAlertScheduler(): void {
  if (schedulerTimer !== null) return;
  logger.info(`Started (check interval: ${ALERT_CHECK_INTERVAL_MS / 1000}s)`);

  // Wait a few seconds after startup to let other services initialize.
  setTimeout(() => {
    void runOnce();
  }, 5_000);

  schedulerTimer = setInterval(() => {
    void runOnce();
  }, ALERT_CHECK_INTERVAL_MS);

  if (schedulerTimer.unref) {
    schedulerTimer.unref();
  }
}

/**
 * Stop the scheduler (useful for graceful shutdown / tests).
 */
export function stopAlertScheduler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('Stopped');
  }
}
