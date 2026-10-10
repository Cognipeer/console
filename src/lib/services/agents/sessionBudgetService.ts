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
 */

import { getDatabase, type IAgentConversation } from '@/lib/database';
import { parseSessionBudget, roundUsd, sessionSpentUsd, withSessionSpend, type SessionBudgetPlan } from './sessionBudget';

export type UpdateSessionBudgetOutcome =
  | {
    kind: 'ok';
    conversation: IAgentConversation;
    /** The session was `budget_paused` before the change: it can be continued now. */
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

  await db.updateAgentConversationRuntime(input.conversationId, {
    budget: next,
    // Keep the running total the budget is measured against from here on.
    ...(next ? { spentUsd: sessionSpentUsd(conversation) } : {}),
  });
  const updated = await db.findAgentConversationById(input.conversationId);
  return {
    kind: 'ok',
    conversation: withSessionSpend(updated ?? { ...conversation, budget: next }),
    wasBudgetPaused: conversation.runtimeStatus === 'budget_paused',
  };
}

/**
 * Brings the session's running total up to what a turn really spent, whether or
 * not the turn was persisted. A turn the caller aborted, the sync ceiling or a
 * cancel superseded, or an error cut short still billed its model requests, so
 * its spend must count against the budget. `spentBefore + tapped` is a FLOOR:
 * a turn that persisted already stored its own total, which is never lowered
 * (and never added twice).
 */
export async function recordSessionTurnSpend(input: {
  db: Awaited<ReturnType<typeof getDatabase>>;
  conversationId: string;
  plan: SessionBudgetPlan | null;
  /** What the turn's priced model requests cost, from the usage tap. */
  tappedUsd: number;
}): Promise<void> {
  if (!input.plan || !(input.tappedUsd > 0)) return;
  try {
    const floor = roundUsd(input.plan.spentBefore + input.tappedUsd);
    const current = await input.db.findAgentConversationById(input.conversationId);
    if (!current || sessionSpentUsd(current) >= floor) return;
    await input.db.updateAgentConversationRuntime(input.conversationId, { spentUsd: floor });
  } catch {
    // Best-effort: the turn's own result must not turn into an error here.
  }
}
