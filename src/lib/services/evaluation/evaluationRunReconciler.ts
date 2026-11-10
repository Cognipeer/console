/**
 * Crash-recovery reconciler for evaluation runs.
 *
 * A run executes on one node and heartbeats while it does. Without a sweep, a
 * node that dies mid-run leaves the row `running` for ever — and the suite's
 * duplicate guard then refuses every new run of it.
 *
 *  - Boot pass, over every tenant. With the in-memory queue the previous
 *    process took every job with it: `running` runs are failed ('The server
 *    restarted …') and `pending` runs are published again (the claim at the
 *    start of `executeRun` makes a duplicate harmless). With BullMQ the queue
 *    survives a restart, so only runs whose heartbeat has gone stale are failed.
 *  - Periodic pass (global lock, so one node sweeps per tick): `running` runs
 *    whose last heartbeat is older than `EVALUATION_RUN_STALE_MS` (default
 *    10 min) are failed, and `pending` runs older than 24 h — whose job is
 *    evidently gone — are failed too.
 *
 * Orphaned runs are failed, never re-executed: an agent target may already have
 * run tools with side effects.
 */

import { getDatabase } from '@/lib/database';
import type { IEvaluationRun } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import { getQueue } from '@/lib/core/queue';
import { runWithTenantDb } from '@/lib/services/agents/agentRunService';
import {
  EVALUATION_RUN_JOB,
  EVALUATION_RUN_QUEUE,
  type EvaluationRunJobPayload,
} from './evaluationRunJob';
import { EVAL_RUN_PENDING_MAX_AGE_MS } from './service';
import { getConfig } from '@/lib/core/config';

const logger = createLogger('evaluation:reconcile');

const CHECK_INTERVAL_MS = 60_000;
const SCHEDULER_LOCK_KEY = 'scheduler:evaluation-run-reconciler';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;
/** Bound on how many pending runs one pass republishes or fails per tenant. */
const PENDING_BATCH = 200;

const RESTART_MESSAGE = 'The server restarted while this run was in progress';
const PENDING_EXPIRED_MESSAGE =
  'The run never started: it waited in the queue for more than 24 hours and was not executed.';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export interface EvaluationSweepResult {
  tenantsScanned: number;
  failedRunning: number;
  requeuedPending: number;
  expiredPending: number;
}

const EMPTY_SWEEP: EvaluationSweepResult = { tenantsScanned: 0, failedRunning: 0, requeuedPending: 0, expiredPending: 0 };

/** How long a running run may go without a heartbeat before it is declared lost. */
export function evaluationRunStaleMs(): number {
  return getConfig().evaluation.runStaleMs;
}

function staleMessage(staleMs: number): string {
  const minutes = Math.max(1, Math.round(staleMs / 60_000));
  return `The run stopped responding (no heartbeat for ${minutes} minute${minutes === 1 ? '' : 's'}) and was marked as failed; the server running it probably stopped`;
}

function jobPayloadFor(run: IEvaluationRun): EvaluationRunJobPayload {
  return {
    tenantDbName: '',
    tenantId: run.tenantId,
    projectId: run.projectId,
    createdBy: run.createdBy,
    suiteKey: run.suiteKey,
    runId: String(run._id),
  };
}

async function sweep(mode: 'boot' | 'periodic'): Promise<EvaluationSweepResult> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const queue = mode === 'boot' ? await getQueue() : null;
  // Only the in-memory queue loses its jobs with the process.
  const queueLost = queue?.name === 'memory';
  const staleMs = evaluationRunStaleMs();
  const now = Date.now();

  const result: EvaluationSweepResult = { ...EMPTY_SWEEP };
  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    const tenantDbName = tenant.dbName;
    result.tenantsScanned += 1;
    try {
      await runWithTenantDb(tenantDbName, async (db) => {
        if (queueLost) {
          // A cutoff just ahead of now covers every running run: at boot none of them has a live executor.
          result.failedRunning += await db.failStaleEvaluationRuns(new Date(now + 1000), RESTART_MESSAGE);
        } else {
          result.failedRunning += await db.failStaleEvaluationRuns(new Date(now - staleMs), staleMessage(staleMs));
        }

        const expired = await db.listEvaluationRunsByStatus(['pending'], {
          createdBefore: new Date(now - EVAL_RUN_PENDING_MAX_AGE_MS),
          limit: PENDING_BATCH,
        });
        for (const run of expired) {
          await db.updateEvaluationRun(String(run._id), {
            status: 'failed',
            error: PENDING_EXPIRED_MESSAGE,
            finishedAt: new Date(),
          });
          result.expiredPending += 1;
        }

        if (queue && queueLost) {
          const pending = await db.listEvaluationRunsByStatus(['pending'], { limit: PENDING_BATCH });
          for (const run of pending) {
            try {
              await queue.publish(
                EVALUATION_RUN_QUEUE,
                EVALUATION_RUN_JOB,
                { ...jobPayloadFor(run), tenantDbName },
                { attempts: 1, backoffMs: 5000 },
              );
              result.requeuedPending += 1;
            } catch (error) {
              logger.warn('Failed to republish a pending evaluation run', {
                runId: String(run._id),
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      });
    } catch (error) {
      logger.warn('Evaluation run reconciliation failed for a tenant', {
        tenantDbName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function didWork(r: EvaluationSweepResult): boolean {
  return r.failedRunning + r.requeuedPending + r.expiredPending > 0;
}

/** One-shot recovery at process boot (see the module comment for what each queue provider means). */
export async function reconcileOrphanedEvaluationRuns(): Promise<EvaluationSweepResult> {
  const result = await sweep('boot');
  if (didWork(result)) logger.info('Reconciled evaluation runs at boot', { ...result });
  return result;
}

async function runOnce(): Promise<EvaluationSweepResult> {
  if (running) return EMPTY_SWEEP;
  running = true;
  let lockToken: string | undefined;
  try {
    const cache = await getCache();
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    // One coordinated sweep per tick: only the node holding the global lock does it.
    if (!lockToken) return EMPTY_SWEEP;
    const result = await sweep('periodic');
    if (didWork(result)) logger.info('Reconciled evaluation runs', { ...result });
    return result;
  } catch (error) {
    logger.error('Evaluation run reconciler error', { error: error instanceof Error ? error.message : String(error) });
    return EMPTY_SWEEP;
  } finally {
    if (lockToken) {
      try {
        const cache = await getCache();
        await cache.releaseLock(SCHEDULER_LOCK_KEY, lockToken);
      } catch (error) {
        logger.warn('Failed to release evaluation-run reconciler lock', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    running = false;
  }
}

export function startEvaluationRunReconciler(): void {
  if (timer !== null) return;
  logger.info(`Started (check interval: ${CHECK_INTERVAL_MS / 1000}s)`);
  timer = setInterval(() => {
    void runOnce();
  }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

export function stopEvaluationRunReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function triggerEvaluationRunReconcilerRun(): Promise<EvaluationSweepResult> {
  return runOnce();
}
