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
 * Webhooks ride the same tick: deliveries that are `pending` and due are
 * enqueued again (a retry's wait is a row, not a timer), and an agent-run
 * callback left `pending` / `failed` with attempts to spare is sent again, so
 * neither depends on the queue having kept its messages.
 *
 * A `queued` run whose message was lost (memory-queue restart, matching the
 * crawler's documented failure mode) IS safe to republish as-is, since it
 * never started executing: every queued run at boot, and on each tick those
 * older than `runRequeueAfterMs`. `claimAgentRun` is a CAS, so a duplicate
 * delivery no-ops. A run published within the last requeue window is left
 * alone (its job may still be waiting), and a republish carries a job id of
 * its own time bucket (`ar_<id>_<generation>_r<bucket>`): the queue drops a job
 * under an id it still remembers, finished or failed, so the first id cannot be
 * reused. Deferred rows are never swept this way: the deferred dispatcher
 * hands them out within their class cap on every tick.
 *
 * Scheduled rows (`run_at` / `delay_seconds`) are promoted to `queued` when
 * due; a deferred or scheduled run that has not started within
 * `AGENT_DEFERRED_MAX_WAIT_MS` of becoming due fails as `expired`.
 */

import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { AgentRunConflictError } from '@/lib/database';
import type { DatabaseProvider, IAgentRun } from '@/lib/database';
import {
  AGENT_RUN_CALLBACK_MAX_ATTEMPTS,
  agentRunRetainedUntil,
  dispatchDeferredRuns,
  fireAgentRunCallback,
  isAbandonedSyncReservation,
  publishAgentRunJob,
  redeliverAgentRunCallback,
  resolveAgentRunLimits,
  runWithTenantDb,
  type AgentRunLimits,
} from './agentRunService';
import { cleanupWebhookDeliveries, sweepDueWebhookDeliveries } from '@/lib/services/webhooks/webhookService';
import { sweepExpiredPendingActions } from './agentActionResolution';
import { cleanupExpiredSessionFiles } from './sessionFiles';

const logger = createLogger('agent-run:reconcile');

const CHECK_INTERVAL_MS = 30_000;
const SCHEDULER_LOCK_KEY = 'scheduler:agent-run-reconciler';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;

const ORPHANED_RUNNING_MESSAGE =
  'Agent run orphaned by a worker that stopped sending heartbeats before it finished (crash, OOM, or redeploy).';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastRetentionAt = 0;
/** Retention is a housekeeping sweep, not a per-tick one — hourly is plenty. */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Bound on how many queued runs one tick republishes per tenant. */
const REQUEUE_BATCH = 100;
/** Bound on how many due scheduled runs one tick promotes (and expired ones it fails) per tenant. */
const SCHEDULED_BATCH = 100;

const EXPIRED_RUN_MESSAGE = 'The run did not start in time (it waited longer than the deferred / scheduled wait limit) and was not executed.';

interface SweepResult {
  tenantsScanned: number;
  failedRunningRuns: number;
  deletedSyncRuns: number;
  requeuedRuns: number;
  /** Scheduled runs that came due and were queued. */
  promotedRuns: number;
  /** Deferred / scheduled runs that waited too long and were failed as `expired`. */
  expiredRuns: number;
  /** Deferred runs handed to their queue. */
  dispatchedDeferredRuns: number;
  retentionDeleted: number;
  /** Pending approvals / questions whose time ran out (dropped, or denied and continued). */
  expiredActions: number;
  /** Webhook deliveries that were due and are enqueued again. */
  requeuedWebhookDeliveries: number;
  /** Agent-run callbacks that never settled and are sent again. */
  redeliveredCallbacks: number;
}

const EMPTY_SWEEP: SweepResult = {
  tenantsScanned: 0, failedRunningRuns: 0, deletedSyncRuns: 0, requeuedRuns: 0, promotedRuns: 0, expiredRuns: 0,
  dispatchedDeferredRuns: 0, retentionDeleted: 0, expiredActions: 0, requeuedWebhookDeliveries: 0, redeliveredCallbacks: 0,
};

/**
 * Would one more default-class run go over the active caps of its tenant or
 * project? Asked before a scheduled run is promoted: over the cap it stays
 * scheduled for the next tick (a scheduled row is uncapped until then).
 */
async function promotionOverCap(
  db: DatabaseProvider,
  run: IAgentRun,
  limitsFor: (run: IAgentRun) => Promise<AgentRunLimits>,
): Promise<boolean> {
  const limits = await limitsFor(run);
  if (limits.maxActivePerTenant > 0
    && await db.countActiveAgentRuns(run.tenantId, undefined, { runClass: 'default' }) >= limits.maxActivePerTenant) return true;
  if (limits.maxActivePerProject > 0
    && await db.countActiveAgentRuns(run.tenantId, run.projectId, { runClass: 'default' }) >= limits.maxActivePerProject) return true;
  return false;
}

/** Whether a sweep did anything worth a log line. */
function sweepDidWork(sweep: SweepResult): boolean {
  return Object.entries(sweep).some(([key, value]) => key !== 'tenantsScanned' && value > 0);
}

/**
 * One pass over every tenant, in this order:
 *  - `running` inline / background runs whose heartbeat went stale →
 *    `worker_lost` (notified only when async: an inline run nobody stopped
 *    waiting on gets no callback);
 *  - sync reservations past their own ceiling (+ grace) → deleted. A sync
 *    row never heartbeats, so "stale heartbeat" alone would delete a live
 *    long turn's reservation and let a second turn start on its conversation;
 *  - due `scheduled` runs → `queued` (taking the conversation slot; a slot
 *    held by another run leaves the row scheduled for the next tick);
 *  - deferred / scheduled runs past `AGENT_DEFERRED_MAX_WAIT_MS` → `expired`;
 *  - `queued` runs older than `runRequeueAfterMs` → republished (a lost queue
 *    message, a memory queue on a pod that died). Safe: the claim is a CAS,
 *    a duplicate delivery just no-ops;
 *  - deferred runs → dispatched within their class's running cap;
 *  - pending approvals / questions past their `expiresAt` → the agent's own
 *    `onTimeout` (drop them, or deny and let the agent continue as a job);
 *  - webhook deliveries that are pending and due → enqueued again;
 *  - agent-run callbacks still pending / failed with attempts left → sent again;
 *  - hourly, retention (runs, session events, webhook deliveries, session files,
 *    expired scheduler claims).
 */
async function sweepStaleRunningAgentRuns(options: { requeueAllQueued?: boolean } = {}): Promise<SweepResult> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const cfg = getConfig();
  const now = Date.now();
  const staleBefore = new Date(now - cfg.agent.runHeartbeatStaleMs);
  // Boot requeues every queued run — no age cut-off at all (`< now` missed a
  // run created in the same millisecond as the sweep).
  const requeueBefore = options.requeueAllQueued ? undefined : new Date(now - cfg.agent.runRequeueAfterMs);
  const doRetention = now - lastRetentionAt > RETENTION_INTERVAL_MS;
  if (doRetention) lastRetentionAt = now;

  let tenantsScanned = 0;
  let failedRunningRuns = 0;
  let deletedSyncRuns = 0;
  let requeuedRuns = 0;
  let promotedRuns = 0;
  let expiredRuns = 0;
  let dispatchedDeferredRuns = 0;
  let retentionDeleted = 0;
  let expiredActions = 0;
  let requeuedWebhookDeliveries = 0;
  let redeliveredCallbacks = 0;

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    tenantsScanned += 1;
    const tenantId = String(tenant._id);

    try {
      await runWithTenantDb(tenant.dbName, async (tenantDb) => {
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

          const completedAt = new Date();
          const finalized = await tenantDb.finalizeAgentRun(runId, tenantId, {
            status: 'failed',
            errorReason: 'worker_lost',
            errorMessage: ORPHANED_RUNNING_MESSAGE,
            stopReason: 'error',
            completedAt,
            runtimeContext: null,
            expiresAt: agentRunRetainedUntil(completedAt),
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

        // Scheduled runs that came due. A default-class run is published at once,
        // within its class's active caps (min(env, tenant quota) for whom it
        // counts against); a deferred one waits for the dispatcher below.
        const limitsCache = new Map<string, Promise<AgentRunLimits>>();
        const limitsFor = (run: IAgentRun): Promise<AgentRunLimits> => {
          const userId = run.accountableUserId ?? run.userId;
          const tokenId = run.accountableUserId ? run.accountableTokenId ?? undefined : run.apiTokenId;
          const key = `${run.projectId}:${userId ?? ''}:${tokenId ?? ''}`;
          let limits = limitsCache.get(key);
          if (!limits) {
            limits = resolveAgentRunLimits({
              quotaContext: {
                tenantDbName: tenant.dbName!,
                tenantId,
                projectId: run.projectId,
                ...(tenant.licenseType ? { licenseType: tenant.licenseType as never } : {}),
                ...(userId ? { userId } : {}),
                ...(tokenId ? { tokenId } : {}),
              },
            });
            limitsCache.set(key, limits);
          }
          return limits;
        };
        const due = await tenantDb.listDueScheduledAgentRuns(tenantId, new Date(now), SCHEDULED_BATCH);
        for (const run of due) {
          const runId = String(run._id);
          try {
            if (run.runClass !== 'deferred' && await promotionOverCap(tenantDb, run, limitsFor)) continue;
            const promoted = await tenantDb.promoteScheduledAgentRun(runId, tenantId);
            if (!promoted) continue;
            promotedRuns += 1;
            if (promoted.runClass !== 'deferred') await publishAgentRunJob(promoted);
          } catch (error) {
            // Another run holds the conversation: stays scheduled, tried again next tick.
            if (error instanceof AgentRunConflictError) continue;
            logger.warn('Failed to promote a scheduled agent run', {
              runId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Waited too long to start: failed as `expired`, with its notifications.
        const expired = await tenantDb.listExpiredWaitingAgentRuns(tenantId, {
          dueBefore: new Date(now - cfg.agent.deferredMaxWaitMs),
          limit: SCHEDULED_BATCH,
        });
        for (const run of expired) {
          const finalized = await tenantDb.expireWaitingAgentRun(String(run._id), tenantId, EXPIRED_RUN_MESSAGE, agentRunRetainedUntil());
          if (!finalized) continue;
          expiredRuns += 1;
          await fireAgentRunCallback(finalized, 'failed', { errorReason: 'expired', message: EXPIRED_RUN_MESSAGE }).catch((error) => {
            logger.warn('Failed to deliver expired callback', {
              runId: String(run._id),
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }

        const queued = await tenantDb.listQueuedAgentRuns(tenantId, { createdBefore: requeueBefore, limit: REQUEUE_BATCH });
        for (const run of queued) {
          // Published within the last requeue window: its job may still be waiting (at boot every run goes again).
          if (requeueBefore && run.lastPublishedAt && new Date(run.lastPublishedAt).getTime() > requeueBefore.getTime()) continue;
          try {
            await publishAgentRunJob(run, { republish: true });
            requeuedRuns += 1;
          } catch (error) {
            logger.warn('Failed to republish a queued agent run', {
              runId: String(run._id),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        dispatchedDeferredRuns += await dispatchDeferredRuns(tenant.dbName!, tenantId).catch((error) => {
          logger.warn('Failed to dispatch deferred agent runs', {
            error: error instanceof Error ? error.message : String(error),
          });
          return 0;
        });

        // Callbacks nobody delivered: the row says `pending` / `failed`, the run
        // is past the point of sending one, and it has been quiet for longer than
        // the queue's own retries take (a live retry would have touched the row).
        const stuckCallbacks = await tenantDb.listAgentRunsWithUndeliveredCallbacks(tenantId, {
          // At boot an in-memory queue lost every job, so nothing is "in flight".
          updatedBefore: options.requeueAllQueued ? new Date(now + 1) : new Date(now - cfg.agent.runRequeueAfterMs),
          maxAttempts: AGENT_RUN_CALLBACK_MAX_ATTEMPTS,
          limit: REQUEUE_BATCH,
        });
        for (const run of stuckCallbacks) {
          try {
            if (await redeliverAgentRunCallback(run)) redeliveredCallbacks += 1;
          } catch (error) {
            logger.warn('Failed to re-deliver an agent-run callback', {
              runId: String(run._id),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        requeuedWebhookDeliveries += await sweepDueWebhookDeliveries(
          tenantDb,
          { tenantId, tenantDbName: tenant.dbName! },
          new Date(now),
        );

        const timedOut = await sweepExpiredPendingActions(tenantDb, tenant.dbName!, new Date(now));
        expiredActions += timedOut.expired + timedOut.denied;

        if (doRetention) {
          const { deletedCount } = await tenantDb.cleanupAgentRunRetention({ olderThan: new Date(now), batchSize: 1000 });
          retentionDeleted += deletedCount;
          // The session event log keeps its own, separate retention (each row
          // carries the `expiresAt` it was written with). Mongo also has a TTL
          // index; SQLite has only this sweep.
          const events = await tenantDb.cleanupAgentSessionEventRetention({ olderThan: new Date(now), batchSize: 1000 });
          retentionDeleted += events.deletedCount;
          retentionDeleted += await cleanupWebhookDeliveries(tenantDb, new Date(now));
          // Incoming webhook delivery logs: each row carries its own expiresAt (7 days).
          retentionDeleted += (await tenantDb.cleanupAgentTriggerDeliveryRetention({ olderThan: new Date(now), batchSize: 1000 })).deletedCount;
          // Files attached to sessions live as long as the agent's `attachments.retentionDays`
          // (stamped on each file as `expiresAt` when it was uploaded).
          retentionDeleted += await cleanupExpiredSessionFiles(tenantDb, tenant.dbName!, new Date(now));
          // Exactly-once claims (trigger fires, crawler slots) only matter until they expire.
          retentionDeleted += await tenantDb.cleanupSchedulerClaims(new Date(now)).catch((error) => {
            logger.warn('Scheduler claim cleanup failed', {
              tenantDbName: tenant.dbName,
              error: error instanceof Error ? error.message : String(error),
            });
            return 0;
          });
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

  return {
    tenantsScanned, failedRunningRuns, deletedSyncRuns, requeuedRuns, promotedRuns, expiredRuns, dispatchedDeferredRuns,
    retentionDeleted, expiredActions, requeuedWebhookDeliveries, redeliveredCallbacks,
  };
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
  if (sweepDidWork(sweep)) {
    logger.info('Reconciled orphaned agent runs at boot', { ...sweep });
  }
  return sweep;
}

async function runOnce(): Promise<SweepResult> {
  if (running) return EMPTY_SWEEP;
  running = true;
  let lockToken: string | undefined;

  try {
    const cache = await getCache();
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    // Single coordinated task, not per-entity work (unlike the trigger
    // scheduler's per-slot claims) — only the node holding the global
    // lock sweeps on a given tick, exactly like crawlerScheduler's
    // unassigned-bucket lock.
    if (!lockToken) {
      return EMPTY_SWEEP;
    }

    const result = await sweepStaleRunningAgentRuns();
    if (sweepDidWork(result)) {
      logger.info('Reconciled orphaned agent runs', result);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Fatal agent-run reconciler error', { error: message });
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

export async function triggerAgentRunReconcilerRun(): Promise<SweepResult> {
  return runOnce();
}
