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
}

export interface ChatMessage {
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
}
