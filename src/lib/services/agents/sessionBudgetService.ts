/**
 * Changing a session's budget after it started — the dashboard
 * (`PATCH /agents/:agentId/sessions/:sessionId`) and the client API
 * (`PATCH /client/v1/agents/sessions/:conversationId`) both come through here.
 *
 * Unlike a fixed cap, a session's budget can be ADDED later, raised, lowered
 * or removed (`null`). The only refusal is a budget the session has already
 * spent past: the next turn would be refused at once, which is never what the
 * caller meant. The stop reason and `budget_paused` status a budget stop left
 * are not touched here — continuing a paused session is a separate step
 * (`executeAgentContinueLocal`), so an increase can be made without resuming.
 * The one exception is a session whose turn FINISHED when it crossed the budget:
 * it ended with its answer, so there is nothing to continue and it goes back to
 * idle (see below).
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider, type IAgentConversation } from '@/lib/database';
import { loadConversationState } from './agentTurnState';
import {
  endsInAnswer,
  parseSessionBudget,
  roundUsd,
  sessionSpentUsd,
  withSessionSpend,
  type SessionSpendAccount,
} from './sessionBudget';

const logger = createLogger('agents:session-budget');

export type UpdateSessionBudgetOutcome =
  | {
    kind: 'ok';
    conversation: IAgentConversation;
    /**
     * The session was `budget_paused` before the change and has a turn to carry
     * on: it can be continued now. False for a session whose turn ended with its
     * answer — that one is simply idle again.
     */
    wasBudgetPaused: boolean;
  }
  | { kind: 'invalid'; message: string }
  | { kind: 'not_found' };

export async function updateSessionBudget(input: {
  tenantDbName: string;
  projectId: string;
  conversationId: string;
  /** `{ maxCostUsd, onReach }`, or `null` to remove the budget. */
  budget: unknown;
}): Promise<UpdateSessionBudgetOutcome> {
  const db = await getDatabase();
  await db.switchToTenant(input.tenantDbName);
  const conversation = await db.findAgentConversationById(input.conversationId);
  if (!conversation || conversation.projectId !== input.projectId) return { kind: 'not_found' };

  let next: IAgentConversation['budget'] = null;
  if (input.budget !== null) {
    const parsed = parseSessionBudget(input.budget);
    if (!parsed.ok) return { kind: 'invalid', message: parsed.message };
    const spent = sessionSpentUsd(conversation);
    if (parsed.budget.maxCostUsd <= spent) {
      return {
        kind: 'invalid',
        message: `budget.maxCostUsd must be greater than what the session has already spent ($${spent}).`,
      };
    }
    next = parsed.budget;
  }

  await db.updateAgentConversationRuntime(input.conversationId, { budget: next });
  // Keep the running total the budget is measured against from here on — raised
  // atomically, never set: a turn that is spending right now must not lose its
  // cost to this write.
  if (next) await db.addAgentConversationSpend(input.conversationId, { atLeastUsd: sessionSpentUsd(conversation) });

  // A turn that crossed the budget and finished normally left the session
  // `budget_paused` with its answer delivered. There is nothing to carry on, so
  // the raise (or removal) is all it needed: it is idle again, and a client that
  // asked to resume does not get a continuation that would only be refused.
  let wasBudgetPaused = conversation.runtimeStatus === 'budget_paused';
  const stoppedOnBudget = wasBudgetPaused || (
    conversation.stopReason === 'budget_reached' && conversation.runtimeStatus !== 'running' && conversation.runtimeStatus !== 'requires_action'
  );
  if (stoppedOnBudget && endsInAnswer(await loadConversationState(db, conversation))) {
    await db.updateAgentConversationRuntime(input.conversationId, { runtimeStatus: 'idle', stopReason: 'end_turn' });
    wasBudgetPaused = false;
  }

  const updated = await db.findAgentConversationById(input.conversationId);
  return {
    kind: 'ok',
    conversation: withSessionSpend(updated ?? { ...conversation, budget: next }),
    wasBudgetPaused,
  };
}

/**
 * Adds what a turn spent to the session's running total — whether or not the
 * turn was persisted, and whether or not the session has a budget. A turn the
 * caller aborted, the sync ceiling or a cancel superseded, or an error cut short
 * still billed its model requests, so its spend must count: against the budget,
 * and in the total the API reports as `spent_usd`.
 *
 * `spentUsd` is the turn's spend so far; only the part the plan has not yet
 * accounted for is added, so a turn is counted exactly once however many times
 * this is called (its persist adds the priced cost, the `finally` adds whatever
 * the usage tap saw beyond that). The add is atomic in the database
 * (`addAgentConversationSpend`): two turns that overlap — a superseded one
 * finishing while the next has started — both land, where "read the total, write
 * back the sum" would let the last writer erase the other's spend.
 */
export async function addSessionTurnSpend(input: {
  db: Pick<DatabaseProvider, 'addAgentConversationSpend'>;
  conversationId: string;
  plan: SessionSpendAccount | null;
  spentUsd: number;
}): Promise<void> {
  const { plan } = input;
  if (!plan || !Number.isFinite(input.spentUsd)) return;
  const delta = roundUsd(input.spentUsd - plan.accountedUsd);
  if (!(delta > 0)) return;
  try {
    // `atLeastUsd`: a stored total that fell behind what the turn started from
    // is first brought up to it, then the turn's spend is added.
    await input.db.addAgentConversationSpend(input.conversationId, { addUsd: delta, atLeastUsd: plan.spentBefore });
    plan.accountedUsd = roundUsd(plan.accountedUsd + delta);
  } catch (error) {
    // Best-effort: the turn's own result must not turn into an error here.
    logger.warn('Could not add a turn\'s spend to the session total', {
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Brings the session's running total up to what a turn really spent, for a turn
 * that was not (or not fully) accounted for when it persisted. `tappedUsd` is
 * what the turn's priced model requests cost, from the usage tap.
 */
export async function recordSessionTurnSpend(input: {
  db: Pick<DatabaseProvider, 'addAgentConversationSpend'>;
  conversationId: string;
  plan: SessionSpendAccount | null;
  tappedUsd: number;
}): Promise<void> {
  await addSessionTurnSpend({ db: input.db, conversationId: input.conversationId, plan: input.plan, spentUsd: input.tappedUsd });
}
