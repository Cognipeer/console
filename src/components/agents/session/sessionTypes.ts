/**
 * The shape a session turn arrives in — aliases of `IAgentConversationMessage`
 * (types.domain.ts) and friends. Shared by the transcript and the side panel so
 * the two cannot drift apart on what a turn records.
 */

import type {
    IAgentConversationMessage,
    IAgentConversationStep,
    IAgentSessionBudget,
    IAgentTurnCompaction,
} from '@/lib/database/provider/types.domain';

export type PlaygroundStep = IAgentConversationStep;

/** One context summarization during a turn — older tool results replaced by a structured summary to stay inside the context budget. */
export type TurnCompaction = IAgentTurnCompaction;

/**
 * A turn as the client holds it: `timestamp` arrives as a JSON string, and role
 * `error` (with `errorType`, the classified failure) is a client-only turn that
 * failed, shown in place until reload.
 */
export type ChatMessage = Omit<IAgentConversationMessage, 'timestamp'> & { timestamp?: string; errorType?: string };

/** The SDK's verdict when it gave one; the thrown-error flag otherwise. */
export function stepFailed(step: PlaygroundStep): boolean {
    if (step.status) return step.status === 'error' || step.status === 'rejected';
    return Boolean(step.error);
}

/** A stored session, as `GET /api/agents/:id/sessions/:sessionId` returns it. */
export interface SessionRecord {
    _id: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
    messages?: ChatMessage[];
    metadata?: Record<string, unknown>;
    /**
     * What the session is doing now; absent = idle. `requires_action` = waiting on an approval or an answer;
     * `budget_paused` = stopped on its spend budget.
     */
    runtimeStatus?: 'idle' | 'running' | 'requires_action' | 'budget_paused';
    /** Why the last turn stopped (`budget_reached` = the session budget). */
    stopReason?: string;
    /** The session's spend budget, when it has one. */
    budget?: IAgentSessionBudget | null;
    /** What the session has spent (USD), kept alongside the budget. */
    spentUsd?: number;
    /** Highest event-log seq written when the last turn ended — where a follower resumes from. */
    lastEventSeq?: number;
}
