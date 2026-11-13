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
 *
 * Two more rules keep an execution that is cut off from the database (or was
 * frozen) from acting for a run another node already continues:
 *  - a tool with side effects runs only once the step that asked for it is
 *    stored; a write that fails refuses the tool instead of running it unrecorded;
 *  - it runs only while the execution's hold on the run is fresh (`leaseHolds`):
 *    its last accepted heartbeat is younger than the time after which the
 *    reconciler may give the run to another node, less one heartbeat of margin.
 */

import { createHash } from 'node:crypto';

import type {
    Message as AgentSdkMessage,
    SmartState as AgentSdkSmartState,
} from '@cognipeer/agent-sdk';

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IAgentConversation, IAgentRunCheckpoint } from '@/lib/database';
import { isReadOnlyTool, toolKindOf } from './agentHumanInTheLoop';
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

/** What the model reads for a tool refused because the run continues elsewhere (or was stopped). */
const RUN_MOVED_ON = 'This run continues on another server; the tool was not run here.';
/** ... because the step that asked for it could not be stored. */
const STEP_NOT_SAVED = 'The run\'s progress could not be saved (the database did not answer), so this tool was not run: '
    + 'a server continuing the run would not know it had run. Try it again shortly.';
/** ... because this execution may no longer hold the run. */
const RUN_HOLD_LOST = 'This server could not confirm that it still holds the run (its heartbeat was not recorded in time), '
    + 'so this tool was not run here: another server may be continuing the run.';

/**
 * True while an execution may still act for its run: its last heartbeat the
 * store accepted (`leaseRenewedAt`, `performance.now()` when it was sent) is
 * younger than `AGENT_RUN_HEARTBEAT_STALE_MS` less one heartbeat interval. After
 * that the reconciler may already have given the run to another node. A cell
 * that records no heartbeat holds nothing to lose.
 */
export function runLeaseHolds(cell: { leaseRenewedAt?: number } | undefined, nowMs = performance.now()): boolean {
    if (cell?.leaseRenewedAt === undefined) return true;
    const { runHeartbeatStaleMs, runHeartbeatIntervalMs } = getConfig().agent;
    return nowMs - cell.leaseRenewedAt < runHeartbeatStaleMs - runHeartbeatIntervalMs;
}

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
    /**
     * True for a tool that only reads: no checkpoint is needed before it. Default: none is.
     * `withCheckpointBeforeTool` passes each tool's own classification instead.
     */
    isReadOnlyTool?: (toolName: string) => boolean;
    /** The run moved to another execution: stop the turn. */
    onFenced?: () => void;
    /**
     * False once this execution may have lost its run (see `runLeaseHolds`): a tool with
     * side effects is then not started. Default: always holds.
     */
    leaseHolds?: () => boolean;
    now?: () => number;
}

export interface RunCheckpointer {
    /** The SDK's `onStateChange`: remembers the state at a step boundary; never pauses the turn. */
    onStateChange(state: unknown): boolean;
    /**
     * Awaited before a tool runs. Throws when the tool must not run: the run continues elsewhere,
     * the step that asked for it could not be stored, or this execution may no longer hold the run.
     * `readOnly` overrides `isReadOnlyTool` for this call.
     */
    beforeTool(toolName: string, readOnly?: boolean): Promise<void>;
    /** After a tool with possible side effects finished: the next boundary is written. */
    afterTool(toolName: string, readOnly?: boolean): void;
    /**
     * Resolves once no tool with side effects is running (one waiting for its step's write
     * counts) and the step holding the last one's result was reported. A handoff waits for it
     * (bounded) so the run goes on with that result, not with an unknown outcome for a tool that
     * was about to end.
     */
    idle(): Promise<void>;
    /** Writes the latest step now (shutdown). False when it could not be stored. */
    flush(): Promise<boolean>;
    /**
     * Shutdown handoff: no tool with side effects starts here any more, and the latest step is
     * stored. When none is running, a last step that asked for tools is stored without that ask
     * (none of them started): the next node asks the model again instead of reading that a tool
     * which never ran has an unknown outcome. False when the step could not be stored.
     */
    handoff(): Promise<boolean>;
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

/**
 * The state without its last message when that one asks for tools: for a handoff, when none of
 * those tools started (a step stored with an ask and no results reads as "outcome unknown").
 */
function withoutUnstartedAsk(state: StateLike): StateLike {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const last = toPlainMessage(messages[messages.length - 1]) as unknown as LooseMessage | null;
    if (!last || last.role !== 'assistant' || !Array.isArray(last.tool_calls) || last.tool_calls.length === 0) return state;
    return { ...state, messages: messages.slice(0, -1) };
}

export function createRunCheckpointer(options: RunCheckpointerOptions): RunCheckpointer {
    const now = options.now ?? Date.now;
    const isReadOnly = options.isReadOnlyTool ?? (() => false);
    let latest: StateLike | null = null;
    let latestWritten: StateLike | null = null;
    /** Numbers the states the SDK reported, and the newest one stored, so a tool knows its step is stored. */
    let latestVersion = 0;
    let writtenVersion = 0;
    let lastWriteAt = now();
    let sideEffectSinceWrite = false;
    let persisted: Persisted | null = null;
    let chain: Promise<boolean> = Promise.resolve(true);
    let stopped = false;
    let fenced = false;
    let sealed = false;
    let wrote = false;
    /** Numbers this execution's writes (a segment store keys each write by it). */
    let seq = 0;
    /**
     * Tools with side effects running now (counted from the wait for their step's write), and
     * whether one ended after the latest step reported. `quiesced`: a handoff began, and no
     * such tool starts here any more.
     */
    let quiesced = false;
    let toolsRunning = 0;
    let toolResultUnreported = false;
    let idleWaiters: Array<() => void> = [];
    const isIdle = () => stopped || fenced || sealed || (toolsRunning === 0 && !toolResultUnreported);
    const wakeIdle = () => {
        if (idleWaiters.length === 0 || !isIdle()) return;
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const wake of waiters) wake();
    };

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

    const writeState = async (state: StateLike, version: number): Promise<boolean> => {
        if (stopped || fenced || sealed) return !fenced && !sealed;
        if (latestWritten === state) {
            writtenVersion = Math.max(writtenVersion, version);
            return true;
        }
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
                seq: ++seq,
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
            seq: ++seq,
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
        writtenVersion = Math.max(writtenVersion, version);
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

    /** Queues a write of the latest state (or `state`); writes run one at a time, in order. */
    const writeLatest = (state: StateLike | null = latest, version = latestVersion): Promise<boolean> => {
        if (!state) return chain;
        chain = chain.then(() => writeState(state, version)).catch((error: unknown) => {
            // Whether the store kept any of it is unknown (a timeout after the write landed): the
            // next write is a full one, so a delta the store did keep is not read back twice.
            persisted = null;
            logger.warn('Run checkpoint write failed', {
                runId: options.runId,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        });
        return chain;
    };

    /** The step a tool with side effects asked from is stored, and this execution still holds the run. */
    const checkBeforeTool = async (toolName: string): Promise<void> => {
        if (!sealed) {
            const target = latestVersion;
            if (latest && writtenVersion < target) {
                await writeLatest();
            } else {
                await chain;
            }
            if (fenced || stopped) throw new Error(RUN_MOVED_ON);
            // Past the size cap the run cannot be continued elsewhere anyway; otherwise a step
            // that is not stored would leave a continuing node unaware that this tool ran.
            if (!sealed && writtenVersion < target) {
                logger.warn('Tool not run: its step could not be stored', { runId: options.runId, toolName });
                throw new Error(STEP_NOT_SAVED);
            }
        }
        // Checked last: the write above may have waited long on a database that did not answer.
        if (options.leaseHolds && !options.leaseHolds()) {
            logger.warn('Tool not run: this execution may no longer hold the run', { runId: options.runId, toolName });
            throw new Error(RUN_HOLD_LOST);
        }
    };

    return {
        onStateChange(state: unknown): boolean {
            if (stopped || fenced || sealed || !state || typeof state !== 'object') return false;
            latest = state as StateLike;
            latestVersion += 1;
            // A step reported with no tool running holds the results of the ones that ended.
            if (toolsRunning === 0 && toolResultUnreported) {
                toolResultUnreported = false;
                wakeIdle();
            }
            if (sideEffectSinceWrite || now() - lastWriteAt >= options.intervalMs) {
                sideEffectSinceWrite = false;
                lastWriteAt = now();
                void writeLatest();
            }
            // Never pause: the SDK stops the loop when this returns true.
            return false;
        },
        async beforeTool(toolName: string, readOnly?: boolean): Promise<void> {
            if (fenced || stopped) throw new Error(RUN_MOVED_ON);
            if (readOnly ?? isReadOnly(toolName)) return;
            // A handoff began: not run, and its step is not written as having asked for it.
            if (quiesced) throw new Error(RUN_MOVED_ON);
            toolsRunning += 1;
            try {
                await checkBeforeTool(toolName);
            } catch (error) {
                // Not run: the step that reports its refusal is what a handoff waits for now.
                toolsRunning = Math.max(0, toolsRunning - 1);
                toolResultUnreported = true;
                throw error;
            }
        },
        afterTool(toolName: string, readOnly?: boolean): void {
            if (readOnly ?? isReadOnly(toolName)) return;
            sideEffectSinceWrite = true;
            toolsRunning = Math.max(0, toolsRunning - 1);
            toolResultUnreported = true;
        },
        idle(): Promise<void> {
            if (isIdle()) return Promise.resolve();
            return new Promise((resolve) => {
                idleWaiters.push(resolve);
            });
        },
        async flush(): Promise<boolean> {
            if (fenced || sealed) return false;
            if (latest && latestWritten !== latest) return writeLatest();
            return chain;
        },
        async handoff(): Promise<boolean> {
            quiesced = true;
            if (fenced || sealed) return false;
            const state = latest && toolsRunning === 0 && !toolResultUnreported ? withoutUnstartedAsk(latest) : latest;
            if (state && latestWritten !== state) return writeLatest(state, latestVersion);
            return chain;
        },
        stop(): void {
            stopped = true;
            wakeIdle();
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
 * callable is returned as it is. A tool that only reads, by the same rule
 * tool approval uses (its markings for a bound tool, the list for Console's
 * own), needs no checkpoint: it is only refused once the run moved on.
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
    const kind = toolKindOf(record);
    const readOnly = kind === undefined ? isReadOnlyTool(name) : kind === 'reads';
    const wrapped = async (...args: unknown[]) => {
        await checkpointer.beforeTool(name, readOnly);
        try {
            return await original(...args);
        } finally {
            checkpointer.afterTool(name, readOnly);
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
