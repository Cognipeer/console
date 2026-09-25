/**
 * The shape a session turn arrives in — the client mirror of
 * `IAgentConversationMessage` (types.domain.ts). Shared by the transcript and
 * the side panel so the two cannot drift apart on what a turn records.
 */

export interface PlaygroundStep {
    id?: string;
    name: string;
    args?: unknown;
    /** What the MODEL saw — under summarize_archive retention, possibly a compaction. */
    output?: unknown;
    /** The untouched tool result, present only when it differs from `output`. */
    rawOutput?: unknown;
    error?: string;
    subagent?: string;
    /** The SDK's own verdict, not inferred from the payload. */
    status?: 'success' | 'error' | 'rejected' | 'handoff';
    /** Served from the response cache — no upstream call was made. */
    fromCache?: boolean;
    summarized?: boolean;
    originalTokenCount?: number;
    timestamp?: string;
    /** What the model wrote before this call, in the same message (first call only). */
    narration?: string;
}

/**
 * One context summarization during a turn — the client mirror of
 * `IAgentTurnCompaction`. The agent replaced older tool results with a
 * structured summary to stay inside its context budget.
 */
export interface TurnCompaction {
    at: string;
    /** Tool results the pass compacted. */
    messagesCompressed?: number;
    tokensBefore?: number;
    tokensAfter?: number;
    durationMs?: number;
    /** The summarizer's own model call. */
    inputTokens?: number;
    outputTokens?: number;
    summary?: {
        userDirectives?: string[];
        facts?: Array<{ key: string; value: string }>;
        goals?: string[];
        openQuestions?: string[];
        discarded?: string[];
    };
    integrityNotes?: string[];
    /** The summarizer call failed and a local fallback summary was used. */
    failed?: boolean;
}

export interface ChatMessage {
    /** `error` is client-only: a turn that failed, shown in place until reload. */
    role: string;
    content: string;
    reasoning?: string;
    steps?: PlaygroundStep[];
    output?: unknown;
    outputError?: string;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        /** A discounted slice of `inputTokens`, not an addition to it. */
        cachedInputTokens?: number;
        totalTokens?: number;
        /** Priced from the model's own pricing when the turn ran. */
        costUsd?: number;
    };
    /** Which config answered: a version number, or null for the draft. */
    version?: number | null;
    latencyMs?: number;
    timestamp?: string;
    /** Set when the run ended without a final answer. */
    stopReason?: 'limit' | 'cancelled' | 'paused';
    stopDetail?: string;
    compactions?: TurnCompaction[];
    compactedTools?: Array<{ toolName: string; toolCallId: string }>;
    /** Non-fatal problems during the turn (a failed memory lookup, …). */
    warnings?: string[];
    /** `error` turns only: the classified failure. */
    errorType?: string;
}
