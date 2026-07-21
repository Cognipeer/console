/**
 * Background alert evaluation scheduler.
 *
 * Runs every ALERT_CHECK_INTERVAL_MS (default 60 s), iterates all tenants,
 * and evaluates active alert rules for each one.
 *
 * In multi-instance deployments the run is protected by the active cache
 * provider's lock implementation. Use CACHE_PROVIDER=redis for a true
 * cross-process lock. Tenants are processed sequentially to keep load
 * predictable across tenant databases.
 */

import { getDatabase, runWithTenantScope } from '@/lib/database';
import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import {
  findInstanceAssignment,
  getThisNodeName,
} from '@/lib/core/cluster';
import { evaluateTenantAlerts } from './alertEvaluator';

const logger = createLogger('alert-scheduler');

const ALERT_CHECK_INTERVAL_MS = 60_000; // 60 seconds
const SCHEDULER_LOCK_KEY = 'scheduler:alert-evaluation';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let paused = false;
let loggedNonDistributedLockProvider = false;
let lastStartedAt: Date | null = null;
let lastCompletedAt: Date | null = null;
let lastDurationMs: number | null = null;
let lastError: string | null = null;
let lastFiredCount = 0;
let lastProcessedTenants = 0;
let lastLockProvider = 'unknown';

async function runOnce(manual = false): Promise<{ firedCount: number; processedTenants: number }> {
  if (paused && !manual) return { firedCount: 0, processedTenants: 0 };
  if (running) return { firedCount: 0, processedTenants: 0 };
  running = true;
  let lockToken: string | undefined;
  const startedAt = new Date();
  lastStartedAt = startedAt;
  let firedCount = 0;
  let processedTenants = 0;

  try {
    const cache = await getCache();
    lastLockProvider = cache.name;
    if (cache.name !== 'redis' && !loggedNonDistributedLockProvider) {
      loggedNonDistributedLockProvider = true;
      logger.warn(
        `Scheduler lock is using ${cache.name} cache provider; use CACHE_PROVIDER=redis for multi-instance deployments`,
      );
    }

    // Try the global lock for unassigned rules. Rules with explicit
    // assignments are handled per node regardless of who holds the lock.
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    const holdsGlobalLock = Boolean(lockToken);
    const thisNode = getThisNodeName();

    const mainDb = await getDatabase();
    const tenants = await mainDb.listTenants();

    for (const tenant of tenants) {
      if (!tenant.dbName) continue;
      processedTenants += 1;
      const tenantId = String(tenant._id);

      try {
        // Timer context: bind the tenant for the whole evaluation — rule
        // listing, event creation and lastTriggeredAt updates must not run on
        // the process-global fallback handle.
        const tenantFiredCount = await runWithTenantScope(tenant.dbName, () =>
          evaluateTenantAlerts(
          {
            tenantDbName: tenant.dbName!,
            tenantId,
            tenantSlug: tenant.slug,
            companyName: tenant.companyName,
          },
          {
            ruleFilter: async (rule) => {
              const ruleId = String(rule._id ?? '');
              if (!ruleId) return false;
              const assignment = await findInstanceAssignment(
                'alert-rule',
                `${tenantId}:${ruleId}`,
              );
              if (assignment) return assignment.nodeName === thisNode;
              // Unassigned rules: only the global-lock holder runs them,
              // preserving the pre-cluster default.
              return holdsGlobalLock;
            },
          },
        ));

        firedCount += tenantFiredCount;

        if (tenantFiredCount > 0) {
          logger.info(`Tenant ${tenant.slug}: ${tenantFiredCount} alert(s) fired`);
        }
      } catch (err) {
        logger.error(`Error evaluating alerts for tenant ${tenant.slug}`, {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    lastError = null;
    lastFiredCount = firedCount;
    lastProcessedTenants = processedTenants;
    return { firedCount, processedTenants };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.error('Fatal error during run', {
      error: err instanceof Error ? err.message : err,
    });
    throw err;
  } finally {
    if (lockToken) {
      try {
        const cache = await getCache();
        await cache.releaseLock(SCHEDULER_LOCK_KEY, lockToken);
      } catch (err) {
        logger.warn('Failed to release scheduler lock', {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    lastCompletedAt = new Date();
    lastDurationMs = lastCompletedAt.getTime() - startedAt.getTime();
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

export function pauseAlertScheduler(): void {
  paused = true;
}

export function resumeAlertScheduler(): void {
  paused = false;
}

export async function triggerAlertSchedulerRun(): Promise<{ firedCount: number; processedTenants: number }> {
  return runOnce(true);
}

export function getAlertSchedulerStatus() {
  return {
    checkIntervalMs: ALERT_CHECK_INTERVAL_MS,
    distributedLock: lastLockProvider === 'redis',
    key: 'alert-evaluation',
    lastCompletedAt,
    lastDurationMs,
    lastError,
    lastFiredCount,
    lastLockProvider,
    lastProcessedTenants,
    lastStartedAt,
    paused,
    running,
  };
}
