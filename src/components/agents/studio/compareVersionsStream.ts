/**
 * One side of Compare versions, as a stream.
 *
 * Runs a stateless playground turn (`/chat/stream`, no session) pinned to a
 * version and reports it as it happens: answer text and thought text arrive as
 * separate events and are handed to `onLive` so the pane can draw both while
 * the model is still writing. React-free so the consumer can be tested against
 * a mocked SSE body.
 */

import { consumeSse } from '../session/consumeSse';
import type { PlaygroundStep } from '../session/sessionTypes';
import { readTurnUsage, type CompareTurn } from './compareVersionsStats';

/** What a side has streamed so far. */
export interface CompareLive {
    content: string;
    reasoning: string;
}

export interface RunCompareSideInput {
    agentId: string;
    /** A published version; absent runs the draft. */
    version?: number;
    message: string;
    /** This side's earlier turns (errors are left out). */
    history: CompareTurn[];
    /** Aborting ends the turn with what had streamed. */
    signal?: AbortSignal;
    onLive: (live: CompareLive) => void;
    /** Shown when the stream closes with neither an answer nor an error (translated by the caller). */
    noAnswerMessage?: string;
    /** Injected for tests. */
    fetchImpl?: typeof fetch;
    now?: () => number;
}

/** The server's own wording for a failed turn, carried out of the stream. */
class StreamFailure extends Error {}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * The turn this side produced: an assistant turn, a stopped one (the operator pressed Stop; whatever
 * streamed is kept) or an error turn. Never throws.
 */
export async function runCompareSide(input: RunCompareSideInput): Promise<CompareTurn> {
    const { agentId, version, message, history, signal, onLive } = input;
    const doFetch = input.fetchImpl ?? fetch;
    const now = input.now ?? Date.now;
    const startedAt = now();
    const live: CompareLive = { content: '', reasoning: '' };
    const publish = () => onLive({ ...live });
    let result: Record<string, unknown> | undefined;

    try {
        const res = await doFetch(`/api/agents/${agentId}/chat/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            signal,
            body: JSON.stringify({
                message,
                history: history
                    .filter((turn) => turn.role !== 'error')
                    .map((turn) => ({ role: turn.role, content: turn.content })),
                // Operator view: the thinking text is wanted whatever the agent publishes to its API.
                showReasoning: true,
                ...(version !== undefined ? { version } : {}),
            }),
        });
        if (!res.ok || !res.body) {
            const data = await res.json().catch(() => ({})) as { error?: unknown };
            return { role: 'error', content: String(data.error ?? `HTTP ${res.status}`) };
        }
        await consumeSse(res.body, (event, data) => {
            const payload = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
            if (event === 'text') {
                live.content += text(payload.text);
                publish();
            } else if (event === 'reasoning') {
                live.reasoning += text(payload.text);
                publish();
            } else if (event === 'result') {
                result = payload;
            } else if (event === 'error') {
                throw new StreamFailure(text(payload.error) || 'Chat failed');
            }
        });
    } catch (error) {
        if (signal?.aborted) {
            return {
                role: 'assistant',
                content: live.content,
                ...(live.reasoning ? { reasoning: live.reasoning } : {}),
                stopped: true,
                latencyMs: now() - startedAt,
            };
        }
        return { role: 'error', content: error instanceof Error ? error.message : String(error) };
    }

    if (!result) {
        // The stream closed with neither a result nor an error: the operator stopped it, or the connection dropped.
        if (signal?.aborted || live.content || live.reasoning) {
            return {
                role: 'assistant',
                content: live.content,
                ...(live.reasoning ? { reasoning: live.reasoning } : {}),
                stopped: true,
                latencyMs: now() - startedAt,
            };
        }
        return { role: 'error', content: input.noAnswerMessage ?? 'The stream ended without an answer.' };
    }

    const reasoning = text(result.reasoning) || live.reasoning;
    return {
        role: 'assistant',
        content: text(result.content) || live.content,
        ...(reasoning ? { reasoning } : {}),
        steps: Array.isArray(result.steps) ? result.steps as PlaygroundStep[] : undefined,
        latencyMs: typeof result.latencyMs === 'number' ? result.latencyMs : now() - startedAt,
        ...(result.stopReason === 'cancelled' ? { stopped: true } : {}),
        ...readTurnUsage(result.usage),
    };
}
