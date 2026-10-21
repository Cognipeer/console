/**
 * The abort signal of the agent turn the current code runs inside.
 *
 * The agent SDK hands a tool only its arguments, so a tool that talks to the
 * network cannot be given the turn's signal as a parameter. The turn binds it
 * here for the whole of `invoke()` (it follows every `await`), and the tool
 * executors read it, so a Stop aborts an upstream request that is in flight
 * instead of waiting for it to finish.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<AbortSignal>();

/** Runs `fn` with `signal` as the current turn's signal (no-op binding when it is undefined). */
export function runWithTurnSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? storage.run(signal, fn) : fn();
}

/** The signal of the turn this code runs inside, if any. */
export function currentTurnSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/**
 * Waits for `promise` until the current turn is stopped, then rejects instead.
 * For work this process cannot abort itself (a call handed to another node):
 * the turn stops waiting, the work finishes where it runs.
 */
export function untilTurnStops<T>(promise: Promise<T>): Promise<T> {
  const signal = currentTurnSignal();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('The call was cancelled'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
