/**
 * Background auto-poll scheduler for inference monitoring servers.
 *
 * Each server has a `pollIntervalSeconds` field.  Every CHECK_INTERVAL_MS
 * (default 30 s) the scheduler iterates all tenants and, for each active
 * server whose last poll is older than its configured interval, fires a poll.
 *
 * In multi-instance deployments the run is protected by the active cache
 * provider's lock implementation. Use CACHE_PROVIDER=redis for a true
 * cross-process lock. Tenants are still processed sequentially so one tick
 * does not fan out across every tenant database at once.
 */

import { getDatabase, runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import {
  findInstanceAssignment,
  getThisNodeName,
  resolveDefaultNodeName,
} from '@/lib/core/cluster';
import { InferenceMonitoringService } from './inferenceMonitoringService';

const logger = createLogger('poll-scheduler');

const CHECK_INTERVAL_MS = 30_000; // how often to scan for due servers
const SCHEDULER_LOCK_KEY = 'scheduler:inference-monitoring-poll';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let paused = false;
let loggedNonDistributedLockProvider = false;
let lastStartedAt: Date | null = null;
let lastCompletedAt: Date | null = null;
let lastDurationMs: number | null = null;
let lastError: string | null = null;
let lastLockProvider = 'unknown';
let lastProcessedTenants = 0;
let lastDueServers = 0;

async function runOnce(manual = false): Promise<{ dueServers: number; processedTenants: number }> {
  if (paused && !manual) return { dueServers: 0, processedTenants: 0 };
  if (running) return { dueServers: 0, processedTenants: 0 }; // skip if previous tick is still in progress
  running = true;
  let lockToken: string | undefined;
  const startedAt = new Date();
  lastStartedAt = startedAt;
  let processedTenants = 0;
  let dueServersCount = 0;

  try {
    const cache = await getCache();
    lastLockProvider = cache.name;
    if (cache.name !== 'redis' && !loggedNonDistributedLockProvider) {
      loggedNonDistributedLockProvider = true;
      logger.warn(
        `Scheduler lock is using ${cache.name} cache provider; use CACHE_PROVIDER=redis for multi-instance deployments`,
      );
    }

    // Try the global lock for the unassigned-server bucket. Servers with
    // explicit assignments are filtered per node below regardless of who
    // holds the lock, so each assigned server still gets exactly one
    // poller.
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    const holdsGlobalLock = Boolean(lockToken);
    const thisNode = getThisNodeName();
    const defaultNode = await resolveDefaultNodeName();

    // 1. Fetch all tenants from the main database (no tenant switch needed).
    const mainDb = await getDatabase();
    const tenants = await mainDb.listTenants();

    for (const tenant of tenants) {
      if (!tenant.dbName) continue;
      processedTenants += 1;

      try {
        // 2. Bind the tenant DB for the whole per-tenant block (timer context:
        // switchToTenant alone falls back to the process-global handle that
        // concurrent requests for other tenants overwrite).
        await runWithTenantScope(tenant.dbName, async (tenantDb) => {
        const tenantId = String(tenant._id);
        const servers = await tenantDb.listInferenceServers(tenantId);

        const now = Date.now();
        const dueServersAll = servers.filter((s) => {
          if (s.status === 'disabled') return false;
          if (!s.lastPolledAt) return true;
          const lastPollMs = new Date(s.lastPolledAt).getTime();
          return now - lastPollMs >= s.pollIntervalSeconds * 1000;
        });

        // Per-server routing: a server runs on its assigned node, or — if
        // unassigned — on whichever node currently holds the global lock.
        const dueServers = [] as typeof dueServersAll;
        for (const server of dueServersAll) {
          const assignment = await findInstanceAssignment(
            'inference-server',
            `${tenantId}:${server.key}`,
          );
          const target = assignment?.nodeName ?? defaultNode;
          if (assignment) {
            if (target === thisNode) dueServers.push(server);
          } else if (holdsGlobalLock) {
            dueServers.push(server);
          }
        }

        if (dueServers.length === 0) return;
        dueServersCount += dueServers.length;

        // 3. Poll all due servers for this tenant concurrently.
        //    The enclosing runWithTenantScope keeps them on this tenant's DB.
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
        });
      } catch (err) {
        logger.error(`Error processing tenant ${tenant.slug}`, {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    lastError = null;
    lastProcessedTenants = processedTenants;
    lastDueServers = dueServersCount;
    return { dueServers: dueServersCount, processedTenants };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.error('Fatal error during run', { error: err instanceof Error ? err.message : err });
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

export function pausePollScheduler(): void {
  paused = true;
}

export function resumePollScheduler(): void {
  paused = false;
}

export async function triggerPollSchedulerRun(): Promise<{ dueServers: number; processedTenants: number }> {
  return runOnce(true);
}

export function getPollSchedulerStatus() {
  return {
    checkIntervalMs: CHECK_INTERVAL_MS,
    distributedLock: lastLockProvider === 'redis',
    key: 'inference-monitoring-poll',
    lastCompletedAt,
    lastDueServers,
    lastDurationMs,
    lastError,
    lastLockProvider,
    lastProcessedTenants,
    lastStartedAt,
    paused,
    running,
  };
}
