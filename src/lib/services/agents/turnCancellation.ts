/**
 * Stopping an agent turn that is running RIGHT NOW, whichever door it came in
 * by: the Studio/playground (JSON or SSE), the client API (`/responses`,
 * chat completions, A2A) or a background run.
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
import type { DatabaseProvider, IAgentRun } from '@/lib/database';
import { cancelPendingForNewMessage } from './agentPendingActions';
import { cancelAgentRun, runWithTenantDb } from './agentRunService';
import { abortLocalTurns } from './turnWatch';

const logger = createLogger('agent-turn-cancel');

export interface CancelConversationTurnInput {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  conversationId: string;
  /** When set, only a turn of this agent is stopped (the caller's scope is the agent, not the project). */
  agentKey?: string;
  /** Who asked, recorded on the actions this cancels. */
  requestedBy?: string;
  /**
   * Whether the open approvals/questions of a paused conversation are cancelled too (default true). A caller
   * who may stop a turn but may not answer its approvals passes `false`: ending a request is answering it "no".
   */
  cancelActions?: boolean;
}

export interface CancelConversationTurnOutcome {
  /** A running turn was told to stop, or open approvals/questions were cancelled. */
  cancelled: boolean;
  /** Run-slot rows that were told to stop (a background run's id is the one clients know). */
  runIds: string[];
  /** Open approvals/questions that were cancelled with it. */
  cancelledActions: boolean;
}

/**
 * Stops the conversation's running turn and cancels what a paused one waits on.
 * A run (inline or queued, running or paused) goes through `cancelAgentRun`, so
 * a paused run's row is settled `canceled` with its notifications, not left
 * `requires_action`. Nothing to stop is not an error (`cancelled: false`).
 */
export async function cancelConversationTurn(input: CancelConversationTurnInput): Promise<CancelConversationTurnOutcome> {
  const runIds: string[] = [];
  // Ending a paused run answers its open requests "no": only for a caller allowed to.
  const statuses: IAgentRun['status'][] = input.cancelActions === false ? ['queued', 'running'] : ['queued', 'running', 'requires_action'];

  const rows = await runWithTenantDb(input.tenantDbName, async (db) => {
    const active = await db.listAgentRuns({
      tenantId: input.tenantId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      status: statuses,
      limit: 5,
    });
    return active.filter((row) => !input.agentKey || row.agentKey === input.agentKey);
  });

  let stoppedRunning = false;
  let settledPaused = false;
  for (const row of rows) {
    const id = String(row._id);
    if (row.mode === 'sync') {
      // A dashboard reservation: the turn's node finds the stamp on its next poll.
      const stamped = await runWithTenantDb(input.tenantDbName, (db) => db.requestAgentRunCancel(id, input.tenantId, input.projectId));
      if (stamped) runIds.push(id);
      stoppedRunning = true;
      continue;
    }
    // Owns the callback, the queued fast path and the paused-run settlement.
    const outcome = await cancelAgentRun({ tenantDbName: input.tenantDbName, tenantId: input.tenantId, projectId: input.projectId, runId: id });
    if (outcome.kind === 'accepted') runIds.push(id);
    if (row.status !== 'requires_action') stoppedRunning = true;
    else if (outcome.kind === 'accepted') settledPaused = true;
  }

  // This node's own turn stops now, not on the next poll.
  if (stoppedRunning) abortLocalTurns(input.tenantId, input.conversationId);

  // A settled paused run has already cancelled its open requests (and reset the session).
  const cancelledActions = input.cancelActions === false ? false : (await cancelOpenActions(input)) || settledPaused;
  return { cancelled: runIds.length > 0 || cancelledActions, runIds, cancelledActions };
}

async function cancelOpenActions(input: CancelConversationTurnInput): Promise<boolean> {
  try {
    return await runWithTenantDb(input.tenantDbName, async (db: DatabaseProvider) => {
      const conversation = await db.findAgentConversationById(input.conversationId);
      if (!conversation || conversation.runtimeStatus !== 'requires_action') return false;
      if (String(conversation.projectId) !== input.projectId) return false;
      if (input.agentKey && conversation.agentKey !== input.agentKey) return false;
      await cancelPendingForNewMessage(db, conversation, undefined, input.requestedBy ? `user:${input.requestedBy}` : 'system:stop');
      return true;
    });
  } catch (error) {
    logger.warn('Could not cancel the open actions of a stopped conversation', {
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** The run row that holds a conversation's slot, if any (for callers that need its id). */
export async function findActiveTurnRow(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  conversationId: string,
): Promise<IAgentRun | null> {
  return runWithTenantDb(tenantDbName, async (db) => {
    const [row] = await db.listAgentRuns({ tenantId, projectId, conversationId, status: ['queued', 'running'], limit: 1 });
    return row ?? null;
  });
}
