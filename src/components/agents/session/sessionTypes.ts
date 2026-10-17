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

/** `deniedByUser` on a step: the call was stopped because a person said no to its approval request, not by a guardrail or a failure. */
export type PlaygroundStep = IAgentConversationStep;

/** One context summarization during a turn — older tool results replaced by a structured summary to stay inside the context budget. */
export type TurnCompaction = IAgentTurnCompaction;

/**
 * A turn as the client holds it: `timestamp` arrives as a JSON string, and role
 * `error` (with `errorType`, the classified failure) is a client-only turn that
 * failed, shown in place until reload.
 */
export type ChatMessage = Omit<IAgentConversationMessage, 'timestamp'> & { timestamp?: string; errorType?: string };

/** What turns stored before `rejected` existed say for a call that was stopped before it ran. */
export const BLOCKED_BEFORE_RUN_ERROR = 'Blocked before the tool ran.';

/**
 * The call was stopped before it ran — by a guardrail, or because a person
 * denied its approval request. New turns store `status: 'rejected'`; turns
 * stored earlier carry `status: 'error'` with the text above, so both count.
 */
export function stepBlockedBeforeRun(step: PlaygroundStep): boolean {
    return step.status === 'rejected' || (step.status === 'error' && step.error === BLOCKED_BEFORE_RUN_ERROR);
}

/** The SDK's verdict when it gave one; the thrown-error flag otherwise. A call a person denied is not a failure. */
export function stepFailed(step: PlaygroundStep): boolean {
    if (step.deniedByUser) return false;
    if (step.status) return step.status === 'error' || step.status === 'rejected';
    return Boolean(step.error);
}

/** Who started a session, as the server describes it (a person's name, or the kind of traffic that did). */
export interface SessionOwnerView {
    id: string;
    kind: 'user' | 'routine' | 'public_a2a' | 'evaluation' | 'redteam' | 'system' | 'unknown';
    name?: string;
    email?: string;
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
