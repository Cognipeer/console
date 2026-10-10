/**
 * The pure parts of the session budget: reading a budget, what is left of it,
 * the per-turn cap handed to the SDK, which limit stopped a turn, and the config
 * validation of the agent default.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IAgentConversation } from '@/lib/database';
import {
  activeSessionBudget,
  agentSessionBudget,
  clientBudgetViolation,
  isSessionBudgetBreach,
  parseSessionBudget,
  planSessionBudget,
  sessionBudgetInvokeOptions,
  sessionSpentUsd,
  settleSessionBudget,
  withSessionSpend,
} from '@/lib/services/agents/sessionBudget';
import { AgentBudgetReachedError, AgentSpendLimitError, classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import { conversationRuntimePatch } from '@/lib/services/agents/sessionTurnEvents';
import { toSessionStopReason } from '@/lib/services/agents/sessionEvents';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';

const message = (costUsd?: number) => ({
  role: 'assistant' as const, content: 'x', timestamp: new Date(), ...(costUsd !== undefined ? { usage: { costUsd } } : {}),
});
const session = (over: Record<string, unknown> = {}) => ({ messages: [], ...over }) as unknown as IAgentConversation;

describe('reading a budget', () => {
  it('accepts camelCase and snake_case, defaults onReach to pause, and refuses anything else', () => {
    expect(parseSessionBudget({ maxCostUsd: 2 })).toEqual({ ok: true, budget: { maxCostUsd: 2, onReach: 'pause' } });
    expect(parseSessionBudget({ max_cost_usd: 1.5, on_reach: 'stop' })).toEqual({ ok: true, budget: { maxCostUsd: 1.5, onReach: 'stop' } });
    for (const bad of [null, 'x', [], {}, { maxCostUsd: 0 }, { maxCostUsd: -1 }, { maxCostUsd: '3' }, { maxCostUsd: Infinity }, { maxCostUsd: 1, onReach: 'later' }]) {
      expect(parseSessionBudget(bad).ok).toBe(false);
    }
  });

  it('the agent default and the session budget are read from their stored shapes; null / junk is "no budget"', () => {
    expect(agentSessionBudget({ execution: { sessionBudget: { maxCostUsd: 3, onReach: 'stop' } } })).toEqual({ maxCostUsd: 3, onReach: 'stop' });
    expect(agentSessionBudget({})).toBeUndefined();
    expect(agentSessionBudget({ execution: { sessionBudget: { maxCostUsd: -3, onReach: 'stop' } } })).toBeUndefined();
    expect(activeSessionBudget(session({ budget: null }))).toBeNull();
    expect(activeSessionBudget(session())).toBeNull();
    expect(activeSessionBudget(session({ budget: { maxCostUsd: 1, onReach: 'pause' } }))).toEqual({ maxCostUsd: 1, onReach: 'pause' });
  });
});

describe('what a session has spent', () => {
  it('is the stored total, or the sum of the turns when none was kept, whichever is larger', () => {
    expect(sessionSpentUsd(session({ messages: [message(0.1), message(0.2), { role: 'user', content: 'q', timestamp: new Date() }] }))).toBeCloseTo(0.3, 8);
    expect(sessionSpentUsd(session({ spentUsd: 0.5, messages: [message(0.1)] }))).toBe(0.5);
    // A stored total that fell behind the transcript cannot hide spend.
    expect(sessionSpentUsd(session({ spentUsd: 0.05, messages: [message(0.1)] }))).toBeCloseTo(0.1, 8);
    expect(sessionSpentUsd(session({ messages: [message()] }))).toBe(0); // unpriced turns add nothing
  });

  it('is reported on a session with a budget, backfilled; a session without one is returned untouched', () => {
    const withBudget = session({ budget: { maxCostUsd: 1, onReach: 'pause' }, messages: [message(0.25)] });
    expect(withSessionSpend(withBudget).spentUsd).toBeCloseTo(0.25, 8);
    const without = session({ messages: [message(0.25)] });
    expect(withSessionSpend(without)).toBe(without);
  });
});

describe('planning a turn', () => {
  const budget = { maxCostUsd: 1, onReach: 'pause' as const };

  it('no budget → no plan, and the SDK is called with no extra options', () => {
    expect(planSessionBudget(session())).toBeNull();
    expect(planSessionBudget(session({ budget: null }), 0.5)).toBeNull();
    expect(sessionBudgetInvokeOptions(null)).toEqual({});
  });

  it('caps the turn at what is left of the budget, or at the agent\'s per-turn limit when that is tighter', () => {
    const roomy = planSessionBudget(session({ budget, spentUsd: 0.4 }), undefined)!;
    expect(roomy).toMatchObject({ remaining: 0.6, turnCapUsd: 0.6, sessionBinds: true, spentBefore: 0.4 });
    expect(sessionBudgetInvokeOptions(roomy)).toEqual({ limits: { maxCostUsd: 0.6 } });

    const perTurnTighter = planSessionBudget(session({ budget, spentUsd: 0.4 }), 0.25)!;
    expect(perTurnTighter).toMatchObject({ turnCapUsd: 0.25, sessionBinds: false });
    // Equal: the session budget counts as the binding one (the stop is reported as the budget's).
    expect(planSessionBudget(session({ budget, spentUsd: 0.4 }), 0.6)).toMatchObject({ sessionBinds: true });
  });

  it('refuses a turn when nothing is left, with the amounts', () => {
    const error = (() => {
      try { planSessionBudget(session({ budget, spentUsd: 1.003 })); } catch (e) { return e; }
      return null;
    })();
    expect(error).toBeInstanceOf(AgentBudgetReachedError);
    expect(error).toMatchObject({ status: 402, spentUsd: 1.003, maxCostUsd: 1 });
    expect(() => planSessionBudget(session({ budget, spentUsd: 1 }))).toThrow(AgentBudgetReachedError); // exactly used up
  });

  it('only the session cost-limit stop counts as the budget\'s', () => {
    const plan = planSessionBudget(session({ budget }), 5)!;
    expect(isSessionBudgetBreach(plan, { stopReason: 'limit', stopDetail: 'maxCostUsd ($1) exceeded (actual: $1.0100)' })).toBe(true);
    expect(isSessionBudgetBreach(plan, { stopReason: 'limit', stopDetail: 'maxWallClockMs (1000ms) exceeded' })).toBe(false);
    expect(isSessionBudgetBreach(plan, { stopReason: 'cancelled' })).toBe(false);
    expect(isSessionBudgetBreach(null, { stopReason: 'limit', stopDetail: 'maxCostUsd ($1) exceeded' })).toBe(false);
    const perTurnPlan = planSessionBudget(session({ budget }), 0.2)!;
    expect(isSessionBudgetBreach(perTurnPlan, { stopReason: 'limit', stopDetail: 'maxCostUsd ($0.2) exceeded' })).toBe(false);
  });
});

describe('after a turn', () => {
  const plan = planSessionBudget(session({ budget: { maxCostUsd: 1, onReach: 'pause' }, spentUsd: 0.5 }))!;

  it('adds the turn\'s cost to the total; an unpriced turn adds nothing', () => {
    expect(settleSessionBudget(plan, 0.2, false)).toMatchObject({ spentUsd: 0.7, turnCostUsd: 0.2, reached: false });
    expect(settleSessionBudget(plan, undefined, false)).toMatchObject({ spentUsd: 0.5, turnCostUsd: 0 });
  });

  it('a pausing budget leaves the session budget_paused, a stopping one idle; the conversation\'s runtime fields follow the stop reason', () => {
    expect(conversationRuntimePatch('budget_reached', [], settleSessionBudget(plan, 0.6, true)))
      .toEqual({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached', pendingActionIds: [] });
    const stopPlan = planSessionBudget(session({ budget: { maxCostUsd: 1, onReach: 'stop' } }))!;
    expect(conversationRuntimePatch('budget_reached', [], settleSessionBudget(stopPlan, 1.1, true)).runtimeStatus).toBe('idle');
    // Unchanged for everything else.
    expect(conversationRuntimePatch('end_turn')).toEqual({ runtimeStatus: 'idle', stopReason: 'end_turn', pendingActionIds: [] });
    expect(conversationRuntimePatch('requires_action', ['a'])).toEqual({ runtimeStatus: 'requires_action', stopReason: 'requires_action', pendingActionIds: ['a'] });
    expect(toSessionStopReason('budget_reached')).toBe('budget_reached');
  });
});

describe('how the two refusals are answered', () => {
  it('a used-up session budget is a 402 with the amounts', () => {
    expect(classifyAgentRunError(new AgentBudgetReachedError(1.2, 1))).toMatchObject({
      status: 402, error: { type: 'budget_reached', code: 'budget_reached', spentUsd: 1.2, maxCostUsd: 1 },
    });
  });

  it('a used-up tenant spend limit is the inference path\'s 429 rate_limit_error', () => {
    expect(classifyAgentRunError(new AgentSpendLimitError('Budget exceeded for perMonth (60000/50000 micros)'))).toEqual({
      status: 429,
      error: { message: 'Budget exceeded for perMonth (60000/50000 micros)', type: 'rate_limit_error', code: 'spend_limit_exceeded' },
    });
  });
});

describe('agent default session budget (execution.sessionBudget) validation', () => {
  const validate = (sessionBudget: unknown) => validateAgentConfigShape({
    modelKey: 'gpt-4o', execution: { sessionBudget },
  } as never);

  it('accepts a positive amount with pause or stop, and nothing at all', () => {
    expect(validate({ maxCostUsd: 5, onReach: 'pause' }).errors).toEqual([]);
    expect(validate({ maxCostUsd: 0.5, onReach: 'stop' }).errors).toEqual([]);
    expect(validate(undefined).errors).toEqual([]);
  });

  it('names the field when the amount or the behaviour is wrong', () => {
    const fields = (value: unknown) => validate(value).errors.map((e: { field: string }) => e.field);
    expect(fields({ maxCostUsd: 0, onReach: 'pause' })).toContain('execution.sessionBudget.maxCostUsd');
    expect(fields({ maxCostUsd: 'x', onReach: 'pause' })).toContain('execution.sessionBudget.maxCostUsd');
    expect(fields({ maxCostUsd: 1, onReach: 'later' })).toContain('execution.sessionBudget.onReach');
    expect(fields('cheap')).toContain('execution.sessionBudget');
  });
});


describe('what an API client may do to an agent-set budget', () => {
  const bound = { execution: { sessionBudget: { maxCostUsd: 5, onReach: 'pause' as const } } };

  it('an agent without a default budget binds nobody', () => {
    expect(clientBudgetViolation({}, null)).toBeNull();
    expect(clientBudgetViolation(undefined, { maxCostUsd: 99, onReach: 'pause' })).toBeNull();
  });

  it('by default a client can lower the budget, but not remove it or raise it past the default', () => {
    expect(clientBudgetViolation(bound, { maxCostUsd: 2, onReach: 'stop' })).toBeNull();
    expect(clientBudgetViolation(bound, { maxCostUsd: 5, onReach: 'pause' })).toBeNull();
    expect(clientBudgetViolation(bound, { maxCostUsd: 5.01, onReach: 'pause' })).toMatch(/cannot be raised/);
    expect(clientBudgetViolation(bound, null)).toMatch(/cannot be removed/);
  });

  it('a budget an admin already raised on the session is the ceiling for that session', () => {
    const current = { maxCostUsd: 20, onReach: 'pause' as const };
    expect(clientBudgetViolation(bound, { maxCostUsd: 20, onReach: 'pause' }, current)).toBeNull();
    expect(clientBudgetViolation(bound, { maxCostUsd: 21, onReach: 'pause' }, current)).not.toBeNull();
  });

  it('allowClientOverride lifts the restriction', () => {
    const open = { execution: { sessionBudget: { maxCostUsd: 5, onReach: 'pause' as const, allowClientOverride: true } } };
    expect(clientBudgetViolation(open, null)).toBeNull();
    expect(clientBudgetViolation(open, { maxCostUsd: 500, onReach: 'pause' })).toBeNull();
    // ...and the flag is not copied into a session's own budget.
    expect(agentSessionBudget(open)).toEqual({ maxCostUsd: 5, onReach: 'pause' });
  });

  it('config validation takes a boolean flag only', () => {
    const ok = validateAgentConfigShape({ execution: { sessionBudget: { maxCostUsd: 1, onReach: 'pause', allowClientOverride: true } } } as never);
    expect(ok.errors.filter((e) => e.field.includes('allowClientOverride'))).toEqual([]);
    const bad = validateAgentConfigShape({ execution: { sessionBudget: { maxCostUsd: 1, onReach: 'pause', allowClientOverride: 'yes' } } } as never);
    expect(bad.errors.some((e) => e.field === 'execution.sessionBudget.allowClientOverride')).toBe(true);
  });
});

describe('a turn that was never persisted still counts against the session', () => {
  const plan = { budget: { maxCostUsd: 5, onReach: 'pause' as const }, spentBefore: 1, remaining: 4, turnCapUsd: 4, sessionBinds: true };
  const dbWith = (conversation: unknown) => {
    const update = vi.fn(async () => undefined);
    const db = { findAgentConversationById: vi.fn(async () => conversation), updateAgentConversationRuntime: update };
    return { db: db as never, update };
  };

  it('raises the running total to spentBefore + what the model requests cost', async () => {
    const { recordSessionTurnSpend } = await import('@/lib/services/agents/sessionBudgetService');
    const { db, update } = dbWith(session({ spentUsd: 1, budget: plan.budget }));
    await recordSessionTurnSpend({ db, conversationId: 'c1', plan, tappedUsd: 0.75 });
    expect(update).toHaveBeenCalledWith('c1', { spentUsd: 1.75 });
  });

  it('never lowers or doubles a total the persisted turn already stored', async () => {
    const { recordSessionTurnSpend } = await import('@/lib/services/agents/sessionBudgetService');
    const { db, update } = dbWith(session({ spentUsd: 1.75, budget: plan.budget }));
    await recordSessionTurnSpend({ db, conversationId: 'c1', plan, tappedUsd: 0.75 });
    expect(update).not.toHaveBeenCalled();
    const higher = dbWith(session({ spentUsd: 2, budget: plan.budget }));
    await recordSessionTurnSpend({ db: higher.db, conversationId: 'c1', plan, tappedUsd: 0.75 });
    expect(higher.update).not.toHaveBeenCalled();
  });

  it('does nothing without a budget plan or without spend, and swallows a storage failure', async () => {
    const { recordSessionTurnSpend } = await import('@/lib/services/agents/sessionBudgetService');
    const { db, update } = dbWith(session({}));
    await recordSessionTurnSpend({ db, conversationId: 'c1', plan: null, tappedUsd: 3 });
    await recordSessionTurnSpend({ db, conversationId: 'c1', plan, tappedUsd: 0 });
    expect(update).not.toHaveBeenCalled();
    const broken = { findAgentConversationById: vi.fn(async () => { throw new Error('db down'); }) } as never;
    await expect(recordSessionTurnSpend({ db: broken, conversationId: 'c1', plan, tappedUsd: 1 })).resolves.toBeUndefined();
  });
});
