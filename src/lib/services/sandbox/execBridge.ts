/**
 * Synchronous exec correlation.
 *
 * `exec` / `code-run` commands are dispatched through the async command queue,
 * but AI-agent callers want a request/response. We bridge the two with an
 * in-process registry keyed by `execId`: the client API registers a waiter,
 * enqueues the command, and awaits; the event ingestor resolves the waiter
 * when the matching `exec-result` event arrives.
 *
 * This is single-process (single-node) by design — the runner agent posts its
 * events to the same console process that is awaiting. Multi-node would swap
 * this for a shared pub/sub, behind the same interface.
 */

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

interface Waiter {
  resolve: (result: ExecResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WAITERS = new Map<string, Waiter>();

/** Register a waiter for `execId`; resolves on result or after `timeoutMs`. */
export function awaitExecResult(execId: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const timer = setTimeout(() => {
      WAITERS.delete(execId);
      resolve({ exitCode: -1, stdout: '', stderr: 'exec timed out', timedOut: true });
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    WAITERS.set(execId, { resolve, timer });
  });
}

/** Resolve a pending waiter (called by the event ingestor). No-op if none. */
export function resolveExecResult(execId: string, result: ExecResult): void {
  const waiter = WAITERS.get(execId);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  WAITERS.delete(execId);
  waiter.resolve(result);
}
