/**
 * What the session view shows about a session's spend budget, derived from the
 * stored session and the turns on screen. Pure, so the meter, the banner and
 * the composer cannot disagree about whether the budget is used up.
 */

import type { IAgentSessionBudget } from '@/lib/database/provider/types.domain';
import type { ChatMessage, SessionRecord } from './sessionTypes';
import { summariseSession } from './sessionUsage';

export interface SessionBudgetView {
    budget: IAgentSessionBudget;
    /** What the session has spent: the larger of the stored total and what its turns on screen add up to. */
    spentUsd: number;
    /** 0..1 for the meter. */
    ratio: number;
    /** The budget is used up: new messages are refused. */
    exhausted: boolean;
    /** The last turn stopped on the budget and can be carried on once it is raised. */
    continuable: boolean;
}

export function sessionBudgetView(
    session: Pick<SessionRecord, 'budget' | 'spentUsd' | 'runtimeStatus' | 'stopReason'> | null | undefined,
    messages: ChatMessage[],
): SessionBudgetView | null {
    const budget = session?.budget;
    if (!budget || !(budget.maxCostUsd > 0)) return null;
    const spentUsd = Math.max(session?.spentUsd ?? 0, summariseSession(messages).costUsd);
    return {
        budget,
        spentUsd,
        ratio: Math.min(1, spentUsd / budget.maxCostUsd),
        exhausted: spentUsd >= budget.maxCostUsd,
        // A pausing budget leaves the session `budget_paused`. A budget that stops instead only refuses new
        // messages — the turn is not waiting to be carried on, even though its stop reason is the same.
        continuable: session?.runtimeStatus === 'budget_paused'
            || (session?.stopReason === 'budget_reached' && budget.onReach !== 'stop'),
    };
}

/**
 * After a budget change: carry the session on only if it was waiting to be and the server's answer still
 * says so. A turn that finished when it crossed the budget is idle again after the raise, so continuing it
 * would be refused (409) for no reason a person could act on. The server's `continuable` is the answer when
 * it gave one; the stored session's status is the fallback for an older server.
 */
export function shouldContinueAfterBudgetChange(
    wasContinuable: boolean,
    stored: Pick<SessionRecord, 'runtimeStatus'> | null | undefined,
    continuable?: boolean,
): boolean {
    if (!wasContinuable) return false;
    return typeof continuable === 'boolean' ? continuable : stored?.runtimeStatus === 'budget_paused';
}

/** A budget to offer in the "new budget" box: double what the session had, and clear of what it spent. */
export function suggestedBudget(view: SessionBudgetView): number {
    const raw = Math.max(view.budget.maxCostUsd * 2, view.spentUsd + view.budget.maxCostUsd);
    return raw < 1 ? Math.ceil(raw * 100) / 100 : Math.ceil(raw);
}

/** Is `amount` a budget the server will accept for this session (more than it has spent)? */
export function validBudgetAmount(amount: unknown, view: SessionBudgetView | null): amount is number {
    return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && amount > (view?.spentUsd ?? 0);
}

/** The `PATCH …/sessions/:id` body. */
export function budgetPatchBody(maxCostUsd: number, onReach: IAgentSessionBudget['onReach']) {
    return { budget: { maxCostUsd, onReach } };
}

/** How the server words the `stopDetail` of a turn the SESSION budget stopped (`budgetStopDetail`). */
const BUDGET_STOP_DETAIL = /^session budget reached\b/i;

/**
 * A turn stopped by the session budget. The stored reason is the SDK's generic
 * `limit` — the detail is what tells it from the per-turn limits.
 */
export function isBudgetStop(message: Pick<ChatMessage, 'stopReason' | 'stopDetail'>): boolean {
    return message.stopReason === 'limit' && BUDGET_STOP_DETAIL.test(message.stopDetail ?? '');
}

/** "$0.60 of $0.50" out of "session budget reached ($0.60 of $0.50)". */
export function budgetStopAmounts(stopDetail: string | undefined): string | undefined {
    return /\(([^)]+)\)/.exec(stopDetail ?? '')?.[1];
}
