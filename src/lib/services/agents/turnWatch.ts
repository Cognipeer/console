/**
 * Stopping an agent turn that is running RIGHT NOW, whichever door it came in
 * by: the Studio/playground (JSON or SSE), the client API (`/responses`,
 * chat completions, A2A, Assistants) or a background run.
 *
 * Every inline turn holds the conversation's single run slot (a `mode: 'sync'`
 * `AgentRun` row). That row is the one place every node can see, so a stop is
 * one write on it (`cancelRequestedAt`) and the node that runs the turn finds
 * it on its next poll and aborts the turn's `AbortSignal` — the same signal a
 * disconnected client or a caller's own abort uses. A stop that lands on the
 * node that runs the turn does not wait for the poll: the controller is in
 * this process's registry and is aborted at once.
 *
 * The signal (not the cancellation cell) is what a user's Stop uses on
 * purpose: a turn the cell supersedes is NOT persisted, a turn its signal
 * ends resolves with what it had streamed and keeps that as the answer
 * (`AgentChatRequest.signal`). The abort also reaches the provider call, so
 * the model request stops generating (and billing) instead of finishing for
 * nobody.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';

const logger = createLogger('agent-turn-cancel');

/** How often the node that runs a turn reads its row for a stop that landed elsewhere. */
const TURN_CANCEL_POLL_MS = 1_000;

const liveTurns = new Map<string, Set<() => void>>();

const liveKey = (tenantId: string, conversationId: string) => `${tenantId}:${conversationId}`;

export interface TurnWatchInput {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  conversationId: string;
  /** The run-slot row the turn holds (`reserveConversationForSyncTurn().run._id`). */
  runId?: string;
  /** A signal that also ends the turn (a disconnected client, a caller's own abort). */
  parent?: AbortSignal;
}

export interface TurnWatch {
  /** Pass as the turn's `signal`. */
  signal: AbortSignal;
  /** Whether a stop (not the parent signal) ended the turn. */
  stopRequested: () => boolean;
  /** Always called when the turn is over. */
  stop: () => void;
}

/**
 * Makes a running turn stoppable: the returned signal aborts when
 * {@link cancelConversationTurn} is called for the conversation — on this node
 * at once, on another within {@link TURN_CANCEL_POLL_MS} — or when `parent`
 * aborts.
 */
export function watchTurnCancellation(input: TurnWatchInput): TurnWatch {
  const controller = new AbortController();
  const key = liveKey(input.tenantId, input.conversationId);
  let requested = false;
  let polling = false;

  const abortForStop = () => {
    requested = true;
    if (!controller.signal.aborted) controller.abort();
  };
  let set = liveTurns.get(key);
  if (!set) {
    set = new Set();
    liveTurns.set(key, set);
  }
  set.add(abortForStop);

  const onParentAbort = () => { if (!controller.signal.aborted) controller.abort(input.parent?.reason); };
  if (input.parent?.aborted) onParentAbort();
  else input.parent?.addEventListener('abort', onParentAbort, { once: true });

  const timer = input.runId
    ? setInterval(() => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      void readRow(input)
        .then((row) => { if (row?.cancelRequestedAt) abortForStop(); })
        .catch((error) => {
          logger.warn('Turn cancel poll failed', { runId: input.runId, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => { polling = false; });
    }, TURN_CANCEL_POLL_MS)
    : undefined;
  timer?.unref?.();

  return {
    signal: controller.signal,
    stopRequested: () => requested,
    stop: () => {
      if (timer) clearInterval(timer);
      input.parent?.removeEventListener('abort', onParentAbort);
      const live = liveTurns.get(key);
      live?.delete(abortForStop);
      if (live && live.size === 0) liveTurns.delete(key);
    },
  };
}


async function readRow(input: TurnWatchInput) {
  const db = await getDatabase();
  const read = () => db.getAgentRunById(input.runId!, input.tenantId, input.projectId);
  // Bound to the tenant for the whole read: the turn outlives the request that started it.
  return db.runWithTenant ? db.runWithTenant(input.tenantDbName, read) : (await db.switchToTenant(input.tenantDbName), read());
}

/** Aborts this node's own turns of the conversation at once (the poll covers other nodes). */
export function abortLocalTurns(tenantId: string, conversationId: string): number {
  const live = [...(liveTurns.get(liveKey(tenantId, conversationId)) ?? [])];
  for (const abort of live) abort();
  return live.length;
}
