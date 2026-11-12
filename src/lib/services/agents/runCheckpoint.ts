/**
 * Durable runs: the checkpoints a background run's turn writes, so that a turn
 * cut off by a shutdown or a dead node continues on another node instead of
 * failing. See docs/guide/agent-background-execution.md "Durable runs".
 *
 * ── What is written, and when ───────────────────────────────────────────────
 * The SDK calls `onStateChange` at every step boundary (before the model call,
 * after it, after the tools). The checkpointer only REMEMBERS that state there;
 * it writes it when one of these holds:
 *
 *  - a tool that may have side effects is about to run (`beforeTool`, awaited:
 *    the step that asked for the tool is stored before the tool can act);
 *  - such a tool has finished (the next boundary is written, not awaited);
 *  - `AGENT_CHECKPOINT_INTERVAL_MS` passed since the last write (not awaited);
 *  - the node is shutting down (`flush`).
 *
 * A short turn whose tools only read, or that calls none, writes nothing. The
 * invariant the recovery relies on: no checkpoint means no tool with side
 * effects was started, so the turn can simply run again.
 *
 * ── How much is written ─────────────────────────────────────────────────────
 * Messages and tool history only grow during a turn, so a write appends the
 * entries added since the last one (`append`). Only when the turn rewrote its
 * history (a context summary) is everything written again (`reset`). Every
 * part is brotli-compressed like the conversation state. The other carried
 * fields (summaries, plan) and the turn's own bookkeeping form `head`, written
 * again only when they changed.
 *
 * Text deltas, reasoning deltas and events are never written here: they are
 * the session event log's (or nobody's). The checkpoint is deleted when the
 * run ends; its TTL removes one a crash left behind.
 *
 * ── Fencing ─────────────────────────────────────────────────────────────────
 * A write carries the run's `queueGeneration`. Once the run was queued to
 * continue elsewhere the generation moved on, the store refuses the write, and
 * the checkpointer reports it (`onFenced`) and refuses to start another tool
 * with side effects: an execution that lost its run must not act for it.
 */

import { createHash } from 'node:crypto';

import type {
    Message as AgentSdkMessage,
    SmartState as AgentSdkSmartState,
} from '@cognipeer/agent-sdk';

import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IAgentConversation, IAgentRunCheckpoint } from '@/lib/database';
import {
    CARRIED_FIELDS,
    type CarriedState,
    decodeStoredStateAsync,
    encodeStoredStateAsync,
    maxStateBytes,
    toPlainMessage,
} from './agentTurnState';
import { isOutputLimitNoticeMessage } from './outputLimitNotice';

const logger = createLogger('agent-run-checkpoint');

/** Format of `head` and the chunks. A node that does not know a checkpoint's schema does not continue from it. */
export const CHECKPOINT_SCHEMA = 1;

/** A checkpoint outlives its run's ceiling by this much before the TTL removes it. */
const CHECKPOINT_TTL_SLACK_MS = 60 * 60 * 1000;

type TranscriptMessage = IAgentConversation['messages'][number];

/** What a durable run's turn needs to checkpoint itself. */
export interface DurableTurn {
    /** The run's `queueGeneration` for this execution (fencing). */
    generation: number;
    /** `agentRunTurnKey` of the turn, stamped on the answer it writes. */
    turnKey: string;
}

/**
 * Names one turn of a run: its first one, or the continuation of a pause
 * (`resumeActionIds`). A recovered execution of the same turn has the same key.
 */
export function agentRunTurnKey(runId: string, resumeActionIds: readonly string[] | null | undefined): string {
    if (!resumeActionIds || resumeActionIds.length === 0) return `${runId}:turn`;
    const ids = [...resumeActionIds].sort().join(',');
    return `${runId}:${createHash('sha256').update(ids).digest('hex').slice(0, 16)}`;
}

/** Marks the answer a durable run's turn writes with the turn's key (`transcriptHasTurn`). */
export function stampRunTurn(message: { metadata?: Record<string, unknown> } | undefined, turnKey: string): void {
    if (!message) return;
    message.metadata = { ...(message.metadata ?? {}), runTurn: turnKey };
}

/** True when the transcript already holds the answer this turn writes (it ended before its run was finalized). */
export function transcriptHasTurn(messages: ReadonlyArray<{ role?: string; metadata?: { runTurn?: string } }> | undefined, turnKey: string): boolean {
    return (messages ?? []).some((message) => message.role === 'assistant' && message.metadata?.runTurn === turnKey);
}

/** What the turn would have written beside the answer, so a continuation elsewhere writes the same. */
export interface CheckpointTurn {
    /** `chat`: the turn has a user message of its own; `resume`: it continues a pause or a budget stop. */
    kind: 'chat' | 'resume';
    /** The user message the transcript gets before the answer (chat turns), as the turn would have stored it. */
    userMessage?: TranscriptMessage;
    /** The SDK message index of that user turn in the state (chat turns), for the steps it counts from. */
    userTurnIndex?: number;
}

interface CheckpointHead {
    carried: Omit<CarriedState, 'messages' | 'toolHistory'>;
    turn: CheckpointTurn;
}

type StateLike = Partial<AgentSdkSmartState> & Record<string, unknown>;

export interface RunCheckpointerOptions {
    db: Pick<DatabaseProvider, 'writeAgentRunCheckpoint'>;
    runId: string;
    tenantId: string;
    conversationId: string;
    /** The run's `queueGeneration` for this execution. */
    generation: number;
    /** When the run must have ended (its ceiling); the checkpoint's TTL counts from it. */
    deadlineAt: number;
    intervalMs: number;
    /** The turn's bookkeeping for the state being written (the user message as it will be stored). */
    turn: (state: StateLike) => CheckpointTurn;
    /** True for a tool that only reads: no checkpoint is needed before it. Default: none is. */
    isReadOnlyTool?: (toolName: string) => boolean;
    /** The run moved to another execution: stop the turn. */
    onFenced?: () => void;
    now?: () => number;
}

export interface RunCheckpointer {
    /** The SDK's `onStateChange`: remembers the state at a step boundary; never pauses the turn. */
    onStateChange(state: unknown): boolean;
    /** Awaited before a tool runs. Throws when the run continues elsewhere (the tool must not run). */
    beforeTool(toolName: string): Promise<void>;
    /** After a tool with possible side effects finished: the next boundary is written. */
    afterTool(toolName: string): void;
    /** Writes the latest step now (shutdown). False when it could not be stored. */
    flush(): Promise<boolean>;
    /** Writes nothing more, and refuses tools with side effects (the run was handed to another node). */
    stop(): void;
    /** Something was written for this execution (so there is a checkpoint to delete at the end). */
    readonly wrote: boolean;
    /** The checkpoint grew past `AGENT_STATE_MAX_BYTES`: the run cannot be continued from it. */
    readonly sealed: boolean;
}

interface Persisted {
    messageCount: number;
    lastMessage: unknown;
    toolHistoryCount: number;
    lastToolEntry: unknown;
    headJson: string | null;
    headBytes: number;
    sizeBytes: number;
}

function sameEntry(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

/** The entries added since the last write, or null when the list was rewritten (a reset is needed). */
function appended(list: unknown[], count: number, last: unknown): unknown[] | null {
    if (count === 0) return list.slice();
    if (list.length < count) return null;
    if (!sameEntry(list[count - 1], last)) return null;
    return list.slice(count);
}

function plainMessages(messages: unknown[]): AgentSdkMessage[] {
    return messages.map(toPlainMessage).filter((message): message is AgentSdkMessage => message !== null);
}

async function encodeList(list: unknown[]): Promise<string[]> {
    return list.length > 0 ? [await encodeStoredStateAsync(JSON.stringify(list))] : [];
}

export function createRunCheckpointer(options: RunCheckpointerOptions): RunCheckpointer {
    const now = options.now ?? Date.now;
    const isReadOnly = options.isReadOnlyTool ?? (() => false);
    let latest: StateLike | null = null;
    let latestWritten: StateLike | null = null;
    let lastWriteAt = now();
    let sideEffectSinceWrite = false;
    let persisted: Persisted | null = null;
    let chain: Promise<boolean> = Promise.resolve(true);
    let stopped = false;
    let fenced = false;
    let sealed = false;
    let wrote = false;

    const expiresAt = () => new Date(Math.max(options.deadlineAt, now()) + CHECKPOINT_TTL_SLACK_MS);

    const headOf = (state: StateLike): string => {
        const carried: Record<string, unknown> = {};
        for (const field of CARRIED_FIELDS) {
            if (field === 'messages' || field === 'toolHistory') continue;
            if (state[field] !== undefined) carried[field] = state[field];
        }
        const head: CheckpointHead = { carried, turn: options.turn(state) };
        return JSON.stringify(head);
    };

    const writeState = async (state: StateLike): Promise<boolean> => {
        if (stopped || fenced || sealed) return !fenced && !sealed;
        if (latestWritten === state) return true;
        const messages = Array.isArray(state.messages) ? state.messages : [];
        const toolHistory = Array.isArray(state.toolHistory) ? state.toolHistory : [];
        const headJson = headOf(state);

        const newMessages = persisted ? appended(messages, persisted.messageCount, persisted.lastMessage) : null;
        const newTools = persisted ? appended(toolHistory, persisted.toolHistoryCount, persisted.lastToolEntry) : null;
        const reset = !persisted || newMessages === null || newTools === null;

        const messageChunks = await encodeList(plainMessages(reset ? messages : newMessages!));
        const toolHistoryChunks = await encodeList(reset ? toolHistory : newTools!);
        // On an append the head is sent only when it changed (a plan update, a summary).
        const headChanged = reset || persisted!.headJson !== headJson;
        const head = headChanged ? await encodeStoredStateAsync(headJson) : undefined;
        const headBytes = head?.length ?? persisted!.headBytes;
        const addedBytes = messageChunks.reduce((sum, chunk) => sum + chunk.length, 0)
            + toolHistoryChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const sizeBytes = (reset ? 0 : persisted!.sizeBytes - persisted!.headBytes) + addedBytes + headBytes;

        const base = {
            runId: options.runId,
            tenantId: options.tenantId,
            conversationId: options.conversationId,
            generation: options.generation,
            schema: CHECKPOINT_SCHEMA,
            expiresAt: expiresAt(),
        };
        if (sizeBytes > maxStateBytes()) {
            // Past the cap the turn can no longer be continued faithfully. Say so in the store,
            // so a recovery fails the run instead of continuing from a step that misses tool calls.
            sealed = true;
            const sealedHead = head ?? await encodeStoredStateAsync(headJson);
            const ok = await options.db.writeAgentRunCheckpoint({
                ...base,
                mode: 'reset',
                head: sealedHead,
                messageChunks: [],
                toolHistoryChunks: [],
                messageCount: 0,
                toolHistoryCount: 0,
                sizeBytes: sealedHead.length,
                sealed: 'too_large',
            });
            wrote = true;
            if (!ok) {
                fenced = true;
                options.onFenced?.();
            }
            logger.warn('Run checkpoint over the size cap; the run cannot be continued elsewhere', {
                runId: options.runId,
                sizeBytes,
            });
            return false;
        }

        const ok = await options.db.writeAgentRunCheckpoint({
            ...base,
            mode: reset ? 'reset' : 'append',
            ...(head !== undefined ? { head } : {}),
            messageChunks,
            toolHistoryChunks,
            messageCount: messages.length,
            toolHistoryCount: toolHistory.length,
            sizeBytes,
        });
        if (!ok) {
            fenced = true;
            logger.warn('Run checkpoint refused: the run continues in another execution', { runId: options.runId });
            options.onFenced?.();
            return false;
        }
        wrote = true;
        persisted = {
            messageCount: messages.length,
            lastMessage: messages[messages.length - 1],
            toolHistoryCount: toolHistory.length,
            lastToolEntry: toolHistory[toolHistory.length - 1],
            headJson,
            headBytes,
            sizeBytes,
        };
        latestWritten = state;
        lastWriteAt = now();
        return true;
    };

    /** Queues a write of the latest state; writes run one at a time, in order. */
    const writeLatest = (): Promise<boolean> => {
        const state = latest;
        if (!state) return chain;
        chain = chain.then(() => writeState(state)).catch((error: unknown) => {
            logger.warn('Run checkpoint write failed', {
                runId: options.runId,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        });
        return chain;
    };

    return {
        onStateChange(state: unknown): boolean {
            if (stopped || fenced || sealed || !state || typeof state !== 'object') return false;
            latest = state as StateLike;
            if (sideEffectSinceWrite || now() - lastWriteAt >= options.intervalMs) {
                sideEffectSinceWrite = false;
                lastWriteAt = now();
                void writeLatest();
            }
            // Never pause: the SDK stops the loop when this returns true.
            return false;
        },
        async beforeTool(toolName: string): Promise<void> {
            if (fenced || stopped) throw new Error('This run continues on another server; the tool was not run here.');
            if (sealed || isReadOnly(toolName)) return;
            if (!latest || latestWritten === latest) {
                await chain;
            } else {
                await writeLatest();
            }
            if (fenced) throw new Error('This run continues on another server; the tool was not run here.');
        },
        afterTool(toolName: string): void {
            if (!isReadOnly(toolName)) sideEffectSinceWrite = true;
        },
        async flush(): Promise<boolean> {
            if (fenced || sealed) return false;
            if (latest && latestWritten !== latest) return writeLatest();
            return chain;
        },
        stop(): void {
            stopped = true;
        },
        get wrote() {
            return wrote;
        },
        get sealed() {
            return sealed;
        },
    };
}

/**
 * Wraps a tool so it waits for the checkpoint before it runs. Every callable
 * alias the SDK may use is wrapped (like `protectBuiltTool`); a tool with no
 * callable is returned as it is.
 */
export function withCheckpointBeforeTool<T>(tool: T, checkpointer: RunCheckpointer): T {
    if (!tool || typeof tool !== 'object') return tool;
    const record = tool as Record<string, unknown>;
    // All four aliases point at one closure in `createTool`, and the SDK may call any of them
    // (see `protectBuiltTool`): every one is replaced by the same wrapper.
    const original = [record.invoke, record.call, record.func, record.run].find(
        (alias): alias is (...args: unknown[]) => unknown => typeof alias === 'function',
    );
    if (!original) return tool;
    const name = typeof record.name === 'string' ? record.name : 'tool';
    const wrapped = async (...args: unknown[]) => {
        await checkpointer.beforeTool(name);
        try {
            return await original(...args);
        } finally {
            checkpointer.afterTool(name);
        }
    };
    return { ...record, invoke: wrapped, call: wrapped, run: wrapped, func: wrapped } as T;
}

// ── Reading a checkpoint back ───────────────────────────────────────────────

export interface LoadedCheckpoint {
    carried: CarriedState;
    turn: CheckpointTurn;
    generation: number;
}

export type CheckpointReadOutcome =
    | { kind: 'none' }
    | { kind: 'unusable'; reason: 'too_large' | 'unknown_schema' | 'unreadable' }
    | { kind: 'ok'; checkpoint: LoadedCheckpoint };

async function decodeChunks(chunks: string[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const chunk of chunks) {
        const parsed = JSON.parse(await decodeStoredStateAsync(chunk)) as unknown;
        if (Array.isArray(parsed)) out.push(...parsed);
    }
    return out;
}

export async function readRunCheckpoint(stored: IAgentRunCheckpoint | null): Promise<CheckpointReadOutcome> {
    if (!stored) return { kind: 'none' };
    if (stored.sealed) return { kind: 'unusable', reason: 'too_large' };
    if (stored.schema > CHECKPOINT_SCHEMA) return { kind: 'unusable', reason: 'unknown_schema' };
    try {
        const head = JSON.parse(await decodeStoredStateAsync(stored.head)) as CheckpointHead;
        const messages = plainMessages(await decodeChunks(stored.messageChunks))
            // As for a stored conversation state: the prompt is rebuilt from the current
            // config, and a limit notice is the console's words, not the model's.
            .filter((message) => message.role !== 'system')
            .filter((message) => !isOutputLimitNoticeMessage(message));
        const toolHistory = await decodeChunks(stored.toolHistoryChunks);
        return {
            kind: 'ok',
            checkpoint: {
                carried: { ...head.carried, messages, toolHistory } as CarriedState,
                turn: head.turn,
                generation: stored.generation,
            },
        };
    } catch (error) {
        logger.warn('Run checkpoint could not be read', {
            runId: stored.runId,
            error: error instanceof Error ? error.message : String(error),
        });
        return { kind: 'unusable', reason: 'unreadable' };
    }
}

/** What the model reads for a tool call whose run was interrupted while it may have been running. */
export const INTERRUPTED_TOOL_RESULT =
    'The server running this step stopped while this tool call was in progress, so it is not known whether it '
    + 'completed. Do not assume it failed: check its effect (for example, read the record it would have changed) '
    + 'before calling it again.';

type LooseMessage = Record<string, unknown> & { role?: string; tool_calls?: Array<Record<string, unknown>>; tool_call_id?: string };

/**
 * Gives every tool call that has no result a result saying its outcome is
 * unknown, placed with the other results of its step. The calls are not run
 * again: one of them may already have acted. Returns the names of those calls.
 */
export function settleInterruptedToolCalls(messages: AgentSdkMessage[]): { messages: AgentSdkMessage[]; interrupted: string[] } {
    const answered = new Set<string>();
    for (const message of messages as unknown as LooseMessage[]) {
        if (message.role === 'tool' && typeof message.tool_call_id === 'string') answered.add(message.tool_call_id);
    }
    const out: AgentSdkMessage[] = [];
    const interrupted: string[] = [];
    const list = messages as unknown as LooseMessage[];
    for (let i = 0; i < list.length; i += 1) {
        const message = list[i];
        out.push(message as unknown as AgentSdkMessage);
        if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
        // The step's own results follow it; the placeholders go after them.
        let j = i + 1;
        while (j < list.length && list[j].role === 'tool') {
            out.push(list[j] as unknown as AgentSdkMessage);
            j += 1;
        }
        for (const call of message.tool_calls) {
            const id = typeof call.id === 'string' ? call.id : undefined;
            if (!id || answered.has(id)) continue;
            const fn = call.function as { name?: unknown } | undefined;
            const name = typeof call.name === 'string' ? call.name : typeof fn?.name === 'string' ? fn.name : 'tool';
            interrupted.push(name);
            out.push({ role: 'tool', tool_call_id: id, name, content: INTERRUPTED_TOOL_RESULT } as unknown as AgentSdkMessage);
        }
        i = j - 1;
    }
    return { messages: out, interrupted };
}
