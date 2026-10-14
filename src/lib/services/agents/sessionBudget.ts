/**
 * A spend budget for one session.
 *
 * `runtime.limits.maxCostUsd` caps ONE turn. A session — a conversation that
 * goes on for days through many turns — had nothing that capped what it spends
 * in total. The session budget is that cap: the sum of what the session's
 * turns cost. When it is reached the turn stops and the session either WAITS
 * (`pause`: raise the budget and the turn carries on, with no new user message)
 * or refuses further messages (`stop`).
 *
 * The budget is a setting of the session, not a constant: it starts from the
 * agent's `execution.sessionBudget`, can be given when the session is created,
 * and can be added, raised or removed at any time afterwards.
 *
 * Enforcement rides on the agent-sdk's own cost limit: a turn starts with a
 * per-turn cap of min(the agent's per-turn `maxCostUsd`, what is left of the
 * session budget). The SDK checks it before each model request against what the
 * turn has actually spent, so a turn can overshoot by at most one request.
 */

import { AgentBudgetReachedError } from './agentErrors';
import type {
  IAgentConfig,
  IAgentConversation,
  IAgentSessionBudget,
} from '@/lib/database';

/** Rounds away float dust so `0.1 + 0.2` does not read as `0.30000000000000004`. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function formatUsd(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(4);
}

export { AgentBudgetReachedError };

type BudgetInput = { ok: true; budget: IAgentSessionBudget } | { ok: false; message: string };

/**
 * A budget as a request or a stored setting spells it. `onReach` defaults to
 * `pause` (the safer choice: nothing is lost, the session waits).
 */
export function parseSessionBudget(value: unknown, field = 'budget'): BudgetInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: `${field} must be an object: { maxCostUsd, onReach }` };
  }
  const record = value as Record<string, unknown>;
  const max = record.maxCostUsd ?? record.max_cost_usd;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) {
    return { ok: false, message: `${field}.maxCostUsd must be a number greater than 0` };
  }
  const onReach = record.onReach ?? record.on_reach ?? 'pause';
  if (onReach !== 'pause' && onReach !== 'stop') {
    return { ok: false, message: `${field}.onReach must be "pause" or "stop"` };
  }
  return { ok: true, budget: { maxCostUsd: max, onReach } };
}

/** The agent's default session budget, when it has a usable one. */
export function agentSessionBudget(config: Pick<IAgentConfig, 'execution'> | undefined): IAgentSessionBudget | undefined {
  const stored = config?.execution?.sessionBudget;
  if (!stored) return undefined;
  const parsed = parseSessionBudget(stored);
  return parsed.ok ? parsed.budget : undefined;
}

/**
 * Why an API client may not set this budget, or null when it may. An agent that
 * has a default session budget binds its API clients to it unless the admin
 * allowed overrides (`execution.sessionBudget.allowClientOverride`): a client
 * can lower the budget, but not remove it or raise it past the agent's default
 * (or past what the session already has, when an admin raised that).
 */
export function clientBudgetViolation(
  config: Pick<IAgentConfig, 'execution'> | undefined,
  requested: IAgentSessionBudget | null,
  current?: IAgentSessionBudget | null,
): string | null {
  if (config?.execution?.sessionBudget?.allowClientOverride === true) return null;
  const ceiling = agentSessionBudget(config);
  if (!ceiling) return null;
  const limit = Math.max(ceiling.maxCostUsd, current?.maxCostUsd ?? 0);
  if (requested === null) return "This agent's session budget cannot be removed over the API.";
  if (requested.maxCostUsd > limit) {
    return `This agent's session budget cannot be raised over the API past $${formatUsd(limit)}.`;
  }
  return null;
}

/** The session's budget in effect (null/absent = none). */
export function activeSessionBudget(conversation: Pick<IAgentConversation, 'budget'> | null | undefined): IAgentSessionBudget | null {
  const budget = conversation?.budget;
  if (!budget) return null;
  const parsed = parseSessionBudget(budget);
  return parsed.ok ? parsed.budget : null;
}

/**
 * What the session has spent: the stored running total, or — for a session that
 * never kept one (no budget so far) — the sum of its turns' priced usage. The
 * larger of the two, so a total that fell behind (a budget switched off and on
 * again between turns) cannot hide spend the transcript still shows.
 */
export function sessionSpentUsd(conversation: Pick<IAgentConversation, 'spentUsd' | 'messages'>): number {
  let summed = 0;
  for (const message of conversation.messages ?? []) {
    if (message.role === 'assistant') summed += message.usage?.costUsd ?? 0;
  }
  const stored = typeof conversation.spentUsd === 'number' && Number.isFinite(conversation.spentUsd) ? conversation.spentUsd : 0;
  return roundUsd(Math.max(stored, summed));
}

/**
 * The conversation as it is reported: a session with a budget always carries
 * its running total (backfilled from the transcript when none was stored yet).
 */
export function withSessionSpend<T extends Pick<IAgentConversation, 'budget' | 'spentUsd' | 'messages'>>(conversation: T): T {
  if (!activeSessionBudget(conversation)) return conversation;
  return { ...conversation, spentUsd: sessionSpentUsd(conversation) };
}

/**
 * How one turn's spend is added to the session's running total. EVERY turn has
 * one — with or without a budget — so a turn that is cancelled, cut off by a
 * deadline or never persisted still lands in `spentUsd`, and the total equals
 * the sum of what the turns cost.
 */
export interface SessionSpendAccount {
  /** Spent before this turn. */
  spentBefore: number;
  /**
   * What of this turn's spend has been added to the session's stored total so
   * far (`addSessionTurnSpend` keeps it). Starts at 0; the turn's persist and the
   * `finally` that catches an unpersisted turn each add only what is not in yet,
   * so the turn is counted exactly once however it ends.
   */
  accountedUsd: number;
}

/** The account for a turn that starts now on a session with no budget (a budgeted one has `planSessionBudget`). */
export function startSessionSpendAccount(
  conversation: Pick<IAgentConversation, 'spentUsd' | 'messages'>,
): SessionSpendAccount {
  return { spentBefore: sessionSpentUsd(conversation), accountedUsd: 0 };
}

/** What a turn needs to know about the session budget. */
export interface SessionBudgetPlan extends SessionSpendAccount {
  budget: IAgentSessionBudget;
  /** What was left at the start (> 0). */
  remaining: number;
  /** The per-turn cost cap to give the SDK: min(the agent's own, `remaining`). */
  turnCapUsd: number;
  /** The session budget — not the agent's per-turn limit — is the tighter of the two. */
  sessionBinds: boolean;
}

/**
 * The plan for a turn that starts now, or null when the session has no budget.
 * Throws `AgentBudgetReachedError` when nothing is left: the model must not be
 * called.
 */
export function planSessionBudget(
  conversation: Pick<IAgentConversation, 'budget' | 'spentUsd' | 'messages'> | null | undefined,
  perTurnMaxCostUsd?: number,
): SessionBudgetPlan | null {
  const budget = activeSessionBudget(conversation);
  if (!conversation || !budget) return null;
  const spentBefore = sessionSpentUsd(conversation);
  const remaining = roundUsd(budget.maxCostUsd - spentBefore);
  if (remaining <= 0) throw new AgentBudgetReachedError(spentBefore, budget.maxCostUsd);
  const perTurn = typeof perTurnMaxCostUsd === 'number' && perTurnMaxCostUsd > 0 ? perTurnMaxCostUsd : undefined;
  const sessionBinds = perTurn === undefined || remaining <= perTurn;
  return {
    budget,
    spentBefore,
    remaining,
    turnCapUsd: sessionBinds ? remaining : perTurn!,
    sessionBinds,
    accountedUsd: 0,
  };
}

/** Throws when the session's budget is used up — the cheap pre-check a route makes before it reserves the session. */
export function assertSessionBudgetAvailable(
  conversation: Pick<IAgentConversation, 'budget' | 'spentUsd' | 'messages'> | null | undefined,
): void {
  planSessionBudget(conversation);
}

/**
 * Invoke options that put the turn's cost cap in force. Empty without a plan,
 * so a session with no budget calls the SDK exactly as it always did.
 */
export function sessionBudgetInvokeOptions(plan: SessionBudgetPlan | null): { limits?: { maxCostUsd: number } } {
  return plan ? { limits: { maxCostUsd: plan.turnCapUsd } } : {};
}

/** The SDK's cost-limit wording (`maxCostUsd ($x) exceeded …`). */
const COST_LIMIT_DETAIL = /^maxCostUsd\b/;

/** Did the SESSION budget — rather than the agent's per-turn limit — stop this turn? */
export function isSessionBudgetBreach(
  plan: SessionBudgetPlan | null,
  outcome: { stopReason: string; stopDetail?: string },
): boolean {
  return Boolean(plan)
    && plan!.sessionBinds
    && outcome.stopReason === 'limit'
    && COST_LIMIT_DETAIL.test(outcome.stopDetail ?? '');
}

/** What a finished turn did to the session's budget. */
export interface SessionBudgetSettlement {
  budget: IAgentSessionBudget;
  turnCostUsd: number;
  spentUsd: number;
  /** The session budget is used up after this turn — the SDK stopped the turn on it, or the turn ended with the total at or past the budget. */
  reached: boolean;
}

/**
 * Adds the turn's cost to the session total and says whether the budget is
 * used up. `breach` is the SDK having stopped the turn on the session cap. A
 * turn that finished on its own can still be the one that crossed the line (a
 * single model request that costs more than what was left — a plain chat turn
 * is exactly that), so `reached` is also true whenever the total is at or past
 * the budget: the same stop, event and webhook as a capped turn, with the answer
 * delivered all the same.
 *
 * `stopReason` is how the turn ended. A pause for a person and a cancellation
 * keep their own stop: the pending request has to stay answerable, and a caller
 * who cancelled is told so. Either way the next turn is refused by the plan.
 */
export function settleSessionBudget(
  plan: SessionBudgetPlan,
  turnCostUsd: number | undefined,
  breach: boolean,
  stopReason?: string,
): SessionBudgetSettlement {
  const turn = typeof turnCostUsd === 'number' && Number.isFinite(turnCostUsd) && turnCostUsd > 0 ? turnCostUsd : 0;
  const spentUsd = roundUsd(plan.spentBefore + turn);
  const keepsOwnStop = stopReason === 'paused' || stopReason === 'cancelled';
  const crossed = !keepsOwnStop && spentUsd >= plan.budget.maxCostUsd;
  return { budget: plan.budget, turnCostUsd: turn, spentUsd, reached: breach || crossed };
}

/** The stored message wording for a turn the session budget stopped. */
export function budgetStopDetail(settlement: SessionBudgetSettlement): string {
  return `session budget reached ($${formatUsd(settlement.spentUsd)} of $${formatUsd(settlement.budget.maxCostUsd)})`;
}

/**
 * A transcript that ends in the agent's own answer (an assistant message that
 * asks for no tool): the turn is complete, so there is nothing a continuation
 * could carry on. A session can still be `budget_paused` then — the turn that
 * crossed the budget finished normally.
 */
export function endsInAnswer(carried: { messages?: unknown[] } | null | undefined): boolean {
  const last = carried?.messages?.[carried.messages.length - 1] as { role?: string; tool_calls?: unknown[] } | undefined;
  return Boolean(last) && last!.role === 'assistant' && !(Array.isArray(last!.tool_calls) && last!.tool_calls.length > 0);
}

/** Event payload of `session.usage`. */
export function sessionUsageEventData(settlement: SessionBudgetSettlement) {
  return {
    turnCostUsd: settlement.turnCostUsd,
    spentUsd: settlement.spentUsd,
    budget: { ...settlement.budget },
  };
}
