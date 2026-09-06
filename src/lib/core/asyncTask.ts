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
 *
 * `criticalFireAndForget` is the same non-blocking shape for work whose loss
 * should be loud rather than routine — today, the audit log write. It is
 * NOT durability: a lost promise on SIGKILL is lost either way, and this
 * module cannot change that without a persisted, replayable queue (a
 * transactional outbox), which is real, separately-scoped work. What it DOES
 * do is stop a failure from reading exactly like a dropped cache write:
 * logged at `error` (not `warn`) with a `critical: true` marker a log
 * pipeline can alert on, tracked in its own pending set so shutdown drain
 * reports a critical backlog distinctly from routine background noise, and
 * drained before the general set so it gets first claim on the timeout
 * budget.
 */

import { createLogger } from './logger';
import { captureRequestContext, runWithRequestContext } from './requestContext';

const log = createLogger('async-task');

/** Track pending promises so we can drain on shutdown. */
const pending = new Set<Promise<void>>();
/** Same tracking, for `criticalFireAndForget` — reported and drained separately. */
const criticalPending = new Set<Promise<void>>();

function schedule(
  pendingSet: Set<Promise<void>>,
  fn: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  // Reopen the caller's request context around the task so attribution
  // (userId/apiTokenId/source) survives even if execution outlives the
  // request's AsyncLocalStorage scope.
  const snapshot = captureRequestContext();
  const task = (snapshot ? runWithRequestContext(snapshot, fn) : fn())
    .catch(onError)
    .finally(() => {
      pendingSet.delete(task);
    });

  pendingSet.add(task);
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
export function fireAndForget(label: string, fn: () => Promise<void>): void {
  schedule(pending, fn, (error) => {
    log.error(`Async task "${label}" failed`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });
}

/**
 * Same as `fireAndForget`, for work whose failure should stand out from
 * routine background noise (the audit log write). See the module doc
 * comment above for exactly what this does and does not guarantee.
 *
 * @param label  Short descriptive label for logging (e.g. 'api-audit-log')
 * @param fn     Async function to execute
 */
export function criticalFireAndForget(label: string, fn: () => Promise<void>): void {
  schedule(criticalPending, fn, (error) => {
    log.error(`Critical async task "${label}" failed — record may be lost`, {
      critical: true,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });
}

/**
 * Wait for all pending fire-and-forget tasks to complete.
 * Call this during graceful shutdown to avoid data loss.
 *
 * @param timeoutMs  Maximum time to wait (default: 5000ms)
 */
export async function drainPendingTasks(timeoutMs = 5000): Promise<void> {
  const total = pending.size + criticalPending.size;
  if (total === 0) return;

  log.info(
    `Draining ${criticalPending.size} critical + ${pending.size} routine async task(s)…`,
  );

  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (criticalPending.size > 0) {
        log.error(
          `Drain timeout (${timeoutMs}ms) — ${criticalPending.size} CRITICAL task(s) `
          + `still pending (possible audit data loss), ${pending.size} routine task(s) also pending`,
        );
      } else {
        log.warn(`Drain timeout (${timeoutMs}ms) — ${pending.size} task(s) still pending`);
      }
      resolve();
    }, timeoutMs);
    timer.unref();
  });

  // Critical tasks first: on a tight timeout budget, the audit write gets the
  // Promise.race's outcome, not whichever background task happened to be
  // fastest — draining a shared array top-to-bottom does not change which
  // ones actually finish (allSettled waits for all of them regardless of
  // order), but it does mean the critical set alone decides whether that
  // race resolves before the routine set is even added to it.
  await Promise.race([
    Promise.allSettled(Array.from(criticalPending)),
    deadline,
  ]);
  await Promise.race([
    Promise.allSettled(Array.from(pending)),
    deadline,
  ]);
}

/**
 * Current count of pending routine tasks (for monitoring / health).
 */
export function pendingTaskCount(): number {
  return pending.size;
}

/**
 * Current count of pending CRITICAL tasks (e.g. audit writes still in
 * flight) — for monitoring / health / shutdown reporting, kept separate from
 * `pendingTaskCount()` so a routine background backlog does not mask one.
 */
export function pendingCriticalTaskCount(): number {
  return criticalPending.size;
}
