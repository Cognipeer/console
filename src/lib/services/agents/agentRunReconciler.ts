/**
 * Crash-recovery reconciler for orphaned agent runs (§7.1 of
 * docs/guide/agent-background-execution.md).
 *
 * Deliberately diverges from `crawlerJobReconciler.ts` (§12.1):
 *
 *  - **Heartbeat, not boot-only.** A periodic sweep (not only at process
 *    boot) scans for `running` `AgentRun` rows whose `heartbeatAt` is older
 *    than a threshold — this catches a worker dying at any point, not only
 *    "everyone rebooted together," and does not falsely touch a run whose
 *    owning node is healthy and simply belongs to a DIFFERENT still-running
 *    node (the gap the crawler's boot-only, node-blind sweep has, §12.1).
 *  - **Default outcome is `failed`, not restart.** Unlike a crawl (whose
 *    partial results can be discarded and re-fetched with no external
 *    consequence), an orphaned agent run may have already executed tool
 *    calls with real side effects (an email sent, a record updated).
 *    Re-running it from scratch would repeat those. An orphaned
 *    `background` run is finalized `failed` / `worker_lost` and never
 *    automatically resubmitted.
 *  - **Orphaned `sync` rows are deleted, not finalized** (§6) — a `sync` row
 *    is a reservation slot, not a terminal record; there is no run status
 *    for a caller to poll (a synchronous call persists no queryable
 *    artifact by design), only a `conversationId` slot to free.
 *
 * A `queued` run whose message was lost (memory-queue restart, matching the
 * crawler's documented failure mode) IS safe to republish as-is, since it
 * never started executing — that recovery is boot-specific (an in-memory
 * queue's contents are only ever lost by a process restart), so it runs
 * once at `reconcileOrphanedAgentRuns()` (called from bootstrap), not on
 * every periodic tick — redundantly republishing an already-durably-queued
 * BullMQ job on every tick would be wasteful (though harmless: `claimAgentRun`'s
 * CAS makes a duplicate delivery safe either way).
 */

import { getDatabase } from '@/lib/database';
import type { DatabaseProvider } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { fireAgentRunCallback, isAbandonedSyncReservation, republishAgentRun } from './agentRunService';

const logger = createLogger('agent-run:reconcile');

const CHECK_INTERVAL_MS = 30_000;
const SCHEDULER_LOCK_KEY = 'scheduler:agent-run-reconciler';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;

const ORPHANED_RUNNING_MESSAGE =
  'Agent run orphaned by a worker that stopped sending heartbeats before it finished (crash, OOM, or redeploy).';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let paused = false;
let lastStartedAt: Date | null = null;
let lastCompletedAt: Date | null = null;
let lastDurationMs: number | null = null;
let lastError: string | null = null;
let lastLockProvider = 'unknown';
let lastProcessedTenants = 0;
let lastFailedRunningRuns = 0;
let lastDeletedSyncRuns = 0;
let lastRequeuedRuns = 0;
let lastRetentionDeleted = 0;
let lastRetentionAt = 0;
/** Retention is a housekeeping sweep, not a per-tick one — hourly is plenty. */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Bound on how many queued runs one tick republishes per tenant. */
const REQUEUE_BATCH = 100;

interface SweepResult {
  tenantsScanned: number;
  failedRunningRuns: number;
  deletedSyncRuns: number;
  requeuedRuns: number;
  retentionDeleted: number;
}

const EMPTY_SWEEP: SweepResult = { tenantsScanned: 0, failedRunningRuns: 0, deletedSyncRuns: 0, requeuedRuns: 0, retentionDeleted: 0 };

/**
 * Binds `fn` to `tenantDbName` for its whole execution via the ALREADY-
 * RESOLVED `mainDb` handle's own `runWithTenant` (a real AsyncLocalStorage
 * scope), rather than the separate `runWithTenantScope` export — which
 * would call `getDatabase()` again through `@/lib/database`'s OWN internal
 * reference, invisible to a test that only overrides this file's top-level
 * `getDatabase` import. Reusing the handle already in scope sidesteps that
 * entirely while keeping the identical AsyncLocalStorage guarantee
 * `runWithTenantScope` exists for (§12.11-adjacent — never the
 * process-global `switchToTenant` fallback for a background task
 * iterating every tenant).
 */
async function runWithTenantDb<T>(
  mainDb: DatabaseProvider,
  tenantDbName: string,
  fn: (db: DatabaseProvider) => T | Promise<T>,
): Promise<T> {
  if (typeof mainDb.runWithTenant === 'function') {
    return mainDb.runWithTenant(tenantDbName, () => fn(mainDb));
  }
  await mainDb.switchToTenant(tenantDbName);
  return fn(mainDb);
}

/**
 * The heartbeat-staleness sweep itself — shared by both the one-shot boot
 * call and the periodic scheduler.
 */
/**
 * One pass over every tenant:
 *  - `running` background runs whose heartbeat went stale → `worker_lost`;
 *  - sync reservations past their own ceiling (+ grace) → deleted. A sync
 *    row never heartbeats, so "stale heartbeat" alone would delete a live
 *    long turn's reservation and let a second turn start on its conversation;
 *  - `queued` runs older than `runRequeueAfterMs` → republished (a lost queue
 *    message, a memory queue on a pod that died). Safe: the claim is a CAS,
 *    a duplicate delivery just no-ops;
 *  - hourly, retention.
 */
async function sweepStaleRunningAgentRuns(options: { requeueAllQueued?: boolean } = {}): Promise<SweepResult> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const cfg = getConfig();
  const now = Date.now();
  const staleBefore = new Date(now - cfg.agent.runHeartbeatStaleMs);
  const requeueBefore = options.requeueAllQueued ? new Date(now) : new Date(now - cfg.agent.runRequeueAfterMs);
  const doRetention = now - lastRetentionAt > RETENTION_INTERVAL_MS;
  if (doRetention) lastRetentionAt = now;

  let tenantsScanned = 0;
  let failedRunningRuns = 0;
  let deletedSyncRuns = 0;
  let requeuedRuns = 0;
  let retentionDeleted = 0;

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    tenantsScanned += 1;
    const tenantId = String(tenant._id);

    try {
      await runWithTenantDb(mainDb, tenant.dbName, async (tenantDb) => {
        const staleRuns = await tenantDb.listStaleAgentRuns(tenantId, staleBefore);
        for (const run of staleRuns) {
          const runId = String(run._id);
          if (run.mode === 'sync') {
            // A reservation slot, not a terminal record — nothing to
            // finalize, no caller left polling it. Deleting frees the
            // conversationId's active-run slot for future requests. Only once
            // it is past its own ceiling: a live long sync turn has a stale
            // heartbeat too (sync rows never heartbeat).
            if (!isAbandonedSyncReservation(run, now)) continue;
            const deleted = await tenantDb.deleteAgentRun(runId);
            if (deleted) deletedSyncRuns += 1;
            continue;
          }

          const finalized = await tenantDb.finalizeAgentRun(runId, tenantId, {
            status: 'failed',
            errorReason: 'worker_lost',
            errorMessage: ORPHANED_RUNNING_MESSAGE,
            completedAt: new Date(),
          });
          if (finalized) {
            failedRunningRuns += 1;
            await fireAgentRunCallback(finalized, 'failed', { errorReason: 'worker_lost' }).catch((error) => {
              logger.warn('Failed to deliver worker_lost callback', {
                runId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }

        const queued = await tenantDb.listQueuedAgentRuns(tenantId, { createdBefore: requeueBefore, limit: REQUEUE_BATCH });
        for (const run of queued) {
          try {
            await republishAgentRun(run);
            requeuedRuns += 1;
          } catch (error) {
            logger.warn('Failed to republish a queued agent run', {
              runId: String(run._id),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (doRetention) {
          const { deletedCount } = await tenantDb.cleanupAgentRunRetention({ olderThan: new Date(now), batchSize: 1000 });
          retentionDeleted += deletedCount;
        }
      });
    } catch (error) {
      logger.warn('Failed to reconcile tenant agent runs', {
        error: error instanceof Error ? error.message : String(error),
        tenantDbName: tenant.dbName,
        tenantSlug: tenant.slug,
      });
    }
  }

  return { tenantsScanned, failedRunningRuns, deletedSyncRuns, requeuedRuns, retentionDeleted };
}

/**
 * One-shot, boot-time recovery (called from `bootstrap.ts`, mirroring
 * `reconcileOrphanedCrawlJobs()`'s call site): republishes any `queued`
 * `AgentRun` whose in-memory queue message a prior process death may have
 * lost, then runs one immediate heartbeat-staleness sweep pass so a crash
 * is recovered from without waiting for the first periodic tick.
 */
export async function reconcileOrphanedAgentRuns(): Promise<SweepResult> {
  // At boot every queued run is republished, not just old ones: an in-memory
  // queue lost them all with the previous process.
  const sweep = await sweepStaleRunningAgentRuns({ requeueAllQueued: true });
  if (sweep.failedRunningRuns > 0 || sweep.deletedSyncRuns > 0 || sweep.requeuedRuns > 0) {
    logger.info('Reconciled orphaned agent runs at boot', { ...sweep });
  }
  return sweep;
}

async function runOnce(manual = false): Promise<SweepResult> {
  if (paused && !manual) return EMPTY_SWEEP;
  if (running) return EMPTY_SWEEP;
  running = true;
  let lockToken: string | undefined;
  const startedAt = new Date();
  lastStartedAt = startedAt;

  try {
    const cache = await getCache();
    lastLockProvider = cache.name;
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    // Single coordinated task, not per-entity work (unlike agentScheduler's
    // per-agent instance assignment) — only the node holding the global
    // lock sweeps on a given tick, exactly like crawlerScheduler's
    // unassigned-bucket lock.
    if (!lockToken) {
      return EMPTY_SWEEP;
    }

    const result = await sweepStaleRunningAgentRuns();
    lastError = null;
    lastProcessedTenants = result.tenantsScanned;
    lastFailedRunningRuns = result.failedRunningRuns;
    lastDeletedSyncRuns = result.deletedSyncRuns;
    lastRequeuedRuns = result.requeuedRuns;
    if (result.retentionDeleted > 0) lastRetentionDeleted = result.retentionDeleted;
    if (result.failedRunningRuns > 0 || result.deletedSyncRuns > 0 || result.requeuedRuns > 0) {
      logger.info('Reconciled orphaned agent runs', result);
    }
    return result;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logger.error('Fatal agent-run reconciler error', { error: lastError });
    throw error;
  } finally {
    if (lockToken) {
      try {
        const cache = await getCache();
        await cache.releaseLock(SCHEDULER_LOCK_KEY, lockToken);
      } catch (error) {
        logger.warn('Failed to release agent-run reconciler lock', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    lastCompletedAt = new Date();
    lastDurationMs = lastCompletedAt.getTime() - startedAt.getTime();
    running = false;
  }
}

export function startAgentRunReconciler(): void {
  if (schedulerTimer !== null) return;
  logger.info(`Started (check interval: ${CHECK_INTERVAL_MS / 1000}s)`);
  schedulerTimer = setInterval(() => {
    void runOnce();
  }, CHECK_INTERVAL_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

export function stopAgentRunReconciler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('Stopped');
  }
}

export function pauseAgentRunReconciler(): void {
  paused = true;
}

export function resumeAgentRunReconciler(): void {
  paused = false;
}

export async function triggerAgentRunReconcilerRun(): Promise<SweepResult> {
  return runOnce(true);
}

export function getAgentRunReconcilerStatus() {
  return {
    checkIntervalMs: CHECK_INTERVAL_MS,
    running,
    paused,
    started: schedulerTimer !== null,
    lastStartedAt,
    lastCompletedAt,
    lastDurationMs,
    lastError,
    lastLockProvider,
    lastProcessedTenants,
    lastFailedRunningRuns,
    lastDeletedSyncRuns,
    lastRequeuedRuns,
    lastRetentionDeleted,
  };
}
