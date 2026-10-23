/**
 * The plan a session holds right now, for a page that opens an idle session. Each
 * stored turn keeps the versions it wrote, and a version is the whole list (an
 * `update` arrives with every step, not as a patch), so the newest turn that wrote
 * one already says where the plan ended up. Only a session whose turns were stored
 * before versions were recorded falls back to the carried SDK state, which has to be
 * read whole (it is compressed) and is the slow way.
 */

import type { DatabaseProvider, IAgentConversation } from '@/lib/database';
import type { IAgentPlanStep, IAgentTurnPlanSnapshot } from '@/lib/database/provider/types.domain';
import { latestPlanOf } from '@/lib/shared/agentTurnFlow';
import { loadConversationState } from './agentTurnState';
import { planStepsOf } from './turnFlowTracker';

export interface SessionPlan {
    version: number;
    steps: IAgentPlanStep[];
    /** Completed steps over all steps, 0..1. */
    completion?: number;
    /** When the agent last changed it (ISO). */
    at?: string;
}

/** The SDK state's `plan`, normalized; null for none (or one with no steps and no version). */
export function sessionPlanOf(plan: unknown): SessionPlan | null {
    if (!plan || typeof plan !== 'object') return null;
    const record = plan as { version?: unknown; steps?: unknown; adherenceScore?: unknown; lastUpdated?: unknown };
    const steps = planStepsOf(record.steps);
    if (steps.length === 0) return null;
    return {
        version: typeof record.version === 'number' && Number.isFinite(record.version) ? record.version : 1,
        steps,
        ...(typeof record.adherenceScore === 'number' && Number.isFinite(record.adherenceScore) ? { completion: record.adherenceScore } : {}),
        ...(typeof record.lastUpdated === 'string' && record.lastUpdated ? { at: record.lastUpdated } : {}),
    };
}

/** Worth reading the state for: the agent plans, or a turn of this session already did. */
export function mayHavePlan(
    config: { runtime?: { planning?: { mode?: string } } } | undefined,
    messages: ReadonlyArray<{ plans?: unknown[] }> | undefined,
): boolean {
    const mode = config?.runtime?.planning?.mode ?? 'off';
    return mode !== 'off' || Boolean(messages?.some((message) => Array.isArray(message.plans) && message.plans.length > 0));
}

/**
 * The plan the newest turn that wrote one left: the last version it recorded. A turn that
 * only read its plan keeps an empty list and is passed over. Null when no stored turn
 * recorded a usable plan, so the caller can look in the carried state.
 */
export function sessionPlanFromMessages(messages: ReadonlyArray<{ plans?: IAgentTurnPlanSnapshot[] }> | undefined): SessionPlan | null {
    const last = latestPlanOf(messages ?? []);
    return last ? sessionPlanOf({ version: last.version, steps: last.steps, adherenceScore: last.completion, lastUpdated: last.at }) : null;
}

/**
 * The session's current plan, or null: none yet, or, when no stored turn says, a carried
 * state that cannot be read or that the transcript moved on without. Never throws: a page
 * must open without it.
 */
export async function readSessionPlan(
    db: Pick<DatabaseProvider, 'findAgentConversationState' | 'saveAgentConversationState' | 'deleteAgentConversationState'>,
    conversation: Pick<IAgentConversation, '_id' | 'messages'>,
    config: { runtime?: { planning?: { mode?: string } } } | undefined,
): Promise<SessionPlan | null> {
    const recorded = sessionPlanFromMessages(conversation.messages);
    if (recorded) return recorded;
    if (!mayHavePlan(config, conversation.messages)) return null;
    try {
        const carried = await loadConversationState(db, conversation);
        return sessionPlanOf(carried?.plan);
    } catch {
        return null;
    }
}
