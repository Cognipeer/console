/**
 * The assistant message a turn's `result` event describes — shared by a normal
 * turn and by the continuation of a paused one, which are the same shape. It is
 * what the transcript holds from the moment the stream ends until a reload
 * replaces it with the stored message, so it has to keep whatever the stored
 * message keeps, or the turn reads differently before and after the reload.
 */

import type { ChatMessage, PlaygroundStep, TurnCompaction } from './sessionTypes';

export function assistantFromResult(data: Record<string, unknown>, startedAt: number): ChatMessage {
    return {
        role: 'assistant',
        content: String(data.content ?? ''),
        ...(typeof data.reasoning === 'string' && data.reasoning ? { reasoning: data.reasoning } : {}),
        ...(Array.isArray(data.steps) && data.steps.length > 0
            ? { steps: data.steps as PlaygroundStep[] }
            : {}),
        ...(Array.isArray(data.attachments) && data.attachments.length > 0
            ? { attachments: data.attachments as ChatMessage['attachments'] }
            : {}),
        ...(data.output !== undefined ? { output: data.output } : {}),
        ...(data.outputError ? { outputError: String(data.outputError) } : {}),
        ...(data.usage ? { usage: data.usage as ChatMessage['usage'] } : {}),
        ...(typeof data.stopReason === 'string' ? { stopReason: data.stopReason as ChatMessage['stopReason'] } : {}),
        ...(typeof data.stopDetail === 'string' ? { stopDetail: data.stopDetail } : {}),
        ...(Array.isArray(data.compactions) && data.compactions.length > 0
            ? { compactions: data.compactions as TurnCompaction[] }
            : {}),
        // An empty list is kept: the turn called the plan tool and wrote no version (it only read the plan). A message
        // that records its plan versions leaves such a call out of the flow, as the live view did and a reload does;
        // without the list the call would show as a row the moment the stream ends.
        ...(Array.isArray(data.plans) ? { plans: data.plans as ChatMessage['plans'] } : {}),
        ...(Array.isArray(data.subagentRuns) && data.subagentRuns.length > 0
            ? { subagentRuns: data.subagentRuns as ChatMessage['subagentRuns'] }
            : {}),
        ...(typeof data.subagentRunsDropped === 'number' && data.subagentRunsDropped > 0
            ? { subagentRunsDropped: data.subagentRunsDropped }
            : {}),
        ...(Array.isArray(data.compactedTools) && data.compactedTools.length > 0
            ? { compactedTools: data.compactedTools as ChatMessage['compactedTools'] }
            : {}),
        ...(Array.isArray(data.warnings) && data.warnings.length > 0
            ? { warnings: data.warnings as string[] }
            : {}),
        ...(Array.isArray(data.pendingActions) && data.pendingActions.length > 0
            ? { pendingActions: data.pendingActions as ChatMessage['pendingActions'] }
            : {}),
        version: (data.version as number | null) ?? null,
        // The server times the invoke itself; the round trip is the
        // fallback for an older response that carries no latency.
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : Date.now() - startedAt,
    };
}
