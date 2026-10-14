/**
 * Tokens a single agent RUN has spent so far, whatever becomes of the run.
 *
 * The quota for agent runs (agentQuota.ts) charges a run's tokens once it is over.
 * A run that fails late - a provider error on the last step, a guardrail block on
 * the output, a client that hangs up just before the answer - has still spent its
 * tokens, and charging only the runs that END WELL would let a caller stay under a
 * token limit by aborting every run a moment before it finishes.
 *
 * The gateway chat model (gatewayChatModel.ts) settles every model call of a run, including
 * the ones of a run that is then cancelled or fails, and adds what it saw here. The
 * sink travels with the run through AsyncLocalStorage, so nothing has to be threaded
 * through the runtime. A run that is executed on ANOTHER node (cluster routing) takes
 * its tally with it and only reports a total when it succeeds; there a failed run is
 * not charged, which is the same as before this existed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RunUsageSink {
  /** Total tokens of every model call the run made so far. */
  totalTokens: number;
}

const storage = new AsyncLocalStorage<RunUsageSink>();

export function createRunUsageSink(): RunUsageSink {
  return { totalTokens: 0 };
}

/** Run `fn` with `sink` collecting the usage of the model calls it makes. */
export function runWithUsageSink<T>(sink: RunUsageSink, fn: () => Promise<T>): Promise<T> {
  return storage.run(sink, fn);
}

/** Called by the gateway chat model for every model call; a no-op outside a run that has a sink. */
export function addRunUsage(totalTokens: number | undefined): void {
  const sink = storage.getStore();
  if (!sink || typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
  sink.totalTokens += Math.ceil(totalTokens);
}
