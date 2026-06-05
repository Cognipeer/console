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

const log = createLogger('async-task');

/** Track pending promises so we can drain on shutdown. */
const pending = new Set<Promise<void>>();

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
  const task = fn()
    .catch((error) => {
      log.error(`Async task "${label}" failed`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    })
    .finally(() => {
      pending.delete(task);
    });

  pending.add(task);
}

/**
 * Wait for all pending fire-and-forget tasks to complete.
 * Call this during graceful shutdown to avoid data loss.
 *
 * @param timeoutMs  Maximum time to wait (default: 5000ms)
 */
export async function drainPendingTasks(timeoutMs = 5000): Promise<void> {
  if (pending.size === 0) return;

  log.info(`Draining ${pending.size} pending async task(s)…`);

  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn(`Drain timeout (${timeoutMs}ms) — ${pending.size} task(s) still pending`);
      resolve();
    }, timeoutMs);
    timer.unref();
  });

  await Promise.race([
    Promise.allSettled(Array.from(pending)),
    deadline,
  ]);
}

/**
 * Current count of pending tasks (for monitoring / health).
 */
export function pendingTaskCount(): number {
  return pending.size;
}
