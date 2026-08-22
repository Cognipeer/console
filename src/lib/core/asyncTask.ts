/**
 * Async Task Runner — fire-and-forget with error logging.
 *
 * Use this to run non-critical background work (usage logging,
 * tracing ingestion, cache writes) without blocking the main
 * request–response cycle.
 *
 * Usage:
 *   import { fireAndForget, drainPendingTasks } from '@/lib/core/asyncTask';
 *
 *   // In a route handler — log usage without blocking response:
 *   fireAndForget('log-usage', () => logModelUsage(db, model, payload));
 *
 *   // In shutdown handler:
 *   await drainPendingTasks();
 */

import { createLogger } from './logger';
import { captureRequestContext, runWithRequestContext } from './requestContext';

const log = createLogger('async-task');

/**
 * Background work used to be started the moment it was handed over: every
 * request's usage write, audit row and trace payload became a live promise in
 * an unbounded set. The response returned fast, but under a burst the
 * background writes grew with the request rate, competed with foreground
 * queries for the same small connection pool, and held their payloads —
 * trace bodies run to megabytes — in heap until they drained.
 *
 * So the work is queued and executed by a bounded number of runners.
 */

/** Background tasks executing at once. */
const MAX_IN_FLIGHT = Math.max(
  1,
  Number(process.env.ASYNC_TASK_MAX_CONCURRENT ?? 32) || 32,
);

/**
 * Queue depth for droppable work.
 *
 * Only droppable tasks are shed. Usage, billing and audit writes are always
 * accepted: losing them silently corrupts records the product bills and
 * answers audits from, which is worse than the memory they cost.
 */
const MAX_QUEUED_DROPPABLE = Math.max(
  1,
  Number(process.env.ASYNC_TASK_MAX_QUEUED ?? 1000) || 1000,
);

export interface FireAndForgetOptions {
  /**
   * Shed this task when the queue is saturated. Set it on telemetry whose loss
   * costs visibility rather than correctness — trace payloads, last-used
   * timestamps. Never on usage, billing or audit writes.
   */
  droppable?: boolean;
}

interface QueuedTask {
  label: string;
  run: () => Promise<void>;
  droppable: boolean;
}

const queue: QueuedTask[] = [];
const inFlight = new Set<Promise<void>>();

let droppedSinceLastReport = 0;
let lastDropReportAt = 0;

function noteDropped(label: string): void {
  droppedSinceLastReport += 1;
  const now = Date.now();
  // One line per 10s rather than one per drop: the whole point of shedding is
  // that the process is already under pressure.
  if (now - lastDropReportAt >= 10_000) {
    log.warn('Background task queue saturated; dropping telemetry', {
      dropped: droppedSinceLastReport,
      lastLabel: label,
      inFlight: inFlight.size,
      queued: queue.length,
    });
    droppedSinceLastReport = 0;
    lastDropReportAt = now;
  }
}

function pump(): void {
  while (inFlight.size < MAX_IN_FLIGHT && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;

    const task: Promise<void> = next
      .run()
      .catch((error) => {
        log.error(`Async task "${next.label}" failed`, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      })
      .finally(() => {
        inFlight.delete(task);
        pump();
      });

    inFlight.add(task);
  }
}

/**
 * Schedule a non-critical async operation that should not block the caller.
 *
 * - Errors are caught and logged — they never propagate to the caller.
 * - The promise is tracked so `drainPendingTasks()` can wait for it.
 *
 * @param label  Short descriptive label for logging (e.g. 'log-usage')
 * @param fn     Async function to execute
 */
export function fireAndForget(
  label: string,
  fn: () => Promise<void>,
  options: FireAndForgetOptions = {},
): void {
  // Reopen the caller's request context around the task so attribution
  // (userId/apiTokenId/source) survives even if execution outlives the
  // request's AsyncLocalStorage scope.
  const snapshot = captureRequestContext();
  const droppable = options.droppable === true;
  const task: QueuedTask = {
    label,
    droppable,
    run: () => (snapshot ? runWithRequestContext(snapshot, fn) : fn()),
  };

  if (droppable) {
    const queuedDroppable = queue.reduce((n, t) => (t.droppable ? n + 1 : n), 0);
    if (queuedDroppable >= MAX_QUEUED_DROPPABLE) {
      // Shed the oldest queued telemetry rather than the newest: the fresher
      // sample is the more useful one to keep.
      const oldest = queue.findIndex((t) => t.droppable);
      if (oldest >= 0) {
        const [victim] = queue.splice(oldest, 1);
        noteDropped(victim.label);
      } else {
        noteDropped(label);
        return;
      }
    }
  }

  queue.push(task);
  pump();
}

/**
 * Wait for all pending fire-and-forget tasks to complete.
 * Call this during graceful shutdown to avoid data loss.
 *
 * @param timeoutMs  Maximum time to wait (default: 5000ms)
 */
export async function drainPendingTasks(timeoutMs = 5000): Promise<void> {
  if (pendingTaskCount() === 0) return;

  log.info(`Draining ${pendingTaskCount()} pending async task(s)…`);

  let timedOut = false;
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn(`Drain timeout (${timeoutMs}ms) — ${pendingTaskCount()} task(s) still pending`);
      resolve();
    }, timeoutMs);
    timer.unref();
  });

  // The queue drains in waves of MAX_IN_FLIGHT, so awaiting the current wave
  // once is not enough — keep going until both the queue and the runners are
  // empty, or the deadline fires.
  while (!timedOut && pendingTaskCount() > 0) {
    pump();
    if (inFlight.size === 0) break;
    await Promise.race([
      Promise.allSettled(Array.from(inFlight)),
      deadline,
    ]);
  }
}

/**
 * Current count of pending tasks (for monitoring / health).
 */
export function pendingTaskCount(): number {
  return queue.length + inFlight.size;
}

/** Split view of the backlog, for health endpoints and load debugging. */
export function backgroundTaskStats(): {
  queued: number;
  inFlight: number;
  maxInFlight: number;
} {
  return { queued: queue.length, inFlight: inFlight.size, maxInFlight: MAX_IN_FLIGHT };
}
