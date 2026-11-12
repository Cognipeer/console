/**
 * Taps on the stream of one agent turn: the live text and reasoning, the delegation events
 * and the turn's flow record.
 */

import { isSubagentEvent } from './subagentEvents';
import type { SmartAgentEvent as AgentSdkEvent, AgentInvokeResult as AgentSdkInvokeResult } from '@cognipeer/agent-sdk';
import { delegationCallIdOf, type AgentCompactionEvent, type AgentPlanEvent, type AgentSubagentEvent } from '@/lib/shared/agentTurnFlow';
import type { TurnFlowTracker } from './turnFlowTracker';
import type { SessionTurnEvents } from './sessionTurnEvents';
import { type AgentToolCallEvent, toToolCallEvent } from './agentChatTypes';
import type { IAgentConversationMessage } from '@/lib/database/provider/types.domain';
import { extractAgentReasoning } from './agentTracing';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

/** `metadata` of a stored assistant message: the model that answered (see IAgentConversationMessage.metadata). */
export function answeredWithMetadata(modelKey: string, offered: boolean, routedModel: string | undefined) {
    if (!offered && !routedModel) return {};
    return { metadata: { model: modelKey, ...(routedModel ? { routedModel } : {}) } };
}

/**
 * Invoke options that forward the answer's deltas to `onTextChunk`.
 *
 * `stream: true` is what actually turns provider deltas on — with only
 * `onStream` the SDK fires it exactly once, at the end, with the whole answer.
 * That terminal `isFinal` call repeats the FULL content, so forwarding it
 * would print the answer twice: once streamed, once again in one burst.
 */
export function textStreamOptions(onTextChunk: ((text: string) => void) | undefined, agentKey: string) {
    if (!onTextChunk) return {};
    return {
        stream: true,
        onStream: (chunk: { text?: string; isFinal?: boolean }) => {
            // The SDK passes a sub-agent's deltas up only when asked to (the console never asks), stamped
            // with the sub-agent. They are its text, not this answer's: appended, they would read as the
            // parent's words and end up in the partial answer of an aborted turn.
            if (chunk.isFinal || !chunk.text || isSubagentEvent(chunk)) return;
            try {
                onTextChunk(chunk.text);
            } catch (callbackError) {
                logger.warn('onTextChunk callback failed', { agentKey, error: callbackError });
            }
        },
    };
}

/**
 * Taps the SDK's `reasoning` events of one turn: forwards each piece to the
 * caller and keeps the whole text.
 *
 * The SDK emits them only while the model call streams (`stream: true`), one
 * event per provider delta and no marker between model steps; a step boundary
 * (a tool call, or answer text) is therefore remembered and the next piece
 * starts a new paragraph, so a turn that thought before and after a tool call
 * reads as two thoughts rather than one run-on. `enabled: false` swallows
 * everything (the agent hides its reasoning).
 */
export function createReasoningTap(
    onReasoningChunk: ((text: string) => void) | undefined,
    agentKey: string,
    enabled = true,
): {
    listening: boolean;
    onEvent: (event: AgentSdkEvent) => void;
    text: () => string;
} {
    let collected = '';
    let boundary = false;
    return {
        listening: Boolean(onReasoningChunk) && enabled,
        onEvent: (event) => {
            if (!enabled) return;
            // A sub-agent's thinking, tool calls and text reach this tap too, stamped with the sub-agent:
            // none of it is this turn's thinking or a boundary between this turn's model steps.
            if (isSubagentEvent(event)) return;
            if (event.type === 'tool_call' || event.type === 'stream') {
                if (collected) boundary = true;
                return;
            }
            if (event.type !== 'reasoning' || typeof event.text !== 'string' || !event.text) return;
            const piece = boundary ? `\n\n${event.text}` : event.text;
            boundary = false;
            collected += piece;
            if (!onReasoningChunk) return;
            try {
                onReasoningChunk(piece);
            } catch (callbackError) {
                logger.warn('onReasoningChunk callback failed', { agentKey, error: callbackError });
            }
        },
        text: () => collected,
    };
}

/**
 * `textStreamOptions` plus the switch for reasoning: a caller that wants only
 * the thinking still needs the model call to stream, or the SDK emits nothing.
 */
export function liveStreamOptions(
    onTextChunk: ((text: string) => void) | undefined,
    reasoningTap: { listening: boolean },
    agentKey: string,
) {
    const text = textStreamOptions(onTextChunk, agentKey);
    return reasoningTap.listening ? { ...text, stream: true } : text;
}

/**
 * A sub-agent event that names the delegation CALL it belongs to. The SDK keys each
 * child of `spawn_subagents_parallel` `<call>#<index>` (its pause store is keyed by
 * it), while the group a run is shown in, the call it is anchored on and the card
 * that asks for its approval are all matched by the call itself: the suffix is cut
 * here, once, before the tracker, the session log and the live callbacks see the event.
 */
function onDelegationCall<T extends object>(event: T): T {
    const parent = (event as { parentToolCallId?: unknown }).parentToolCallId;
    if (typeof parent !== 'string') return event;
    const call = delegationCallIdOf(parent);
    return call === parent ? event : { ...event, parentToolCallId: call };
}

/**
 * Feeds one invoke leg's SDK events to its flow tracker and passes on what the
 * tracker makes of them: the session log rows, and the live callbacks of the
 * caller (when it listens). The three invoke paths (background/API, playground,
 * resume) call this for every event, so they record the turn the same way.
 *
 * What the tracker keeps apart is what keeps the turn honest: a delegated child's
 * tool calls and summarization passes are told live and logged with the child's
 * name, but never counted as the agent's own steps or compactions (a child
 * compacting its own context did not shorten this turn's messages). A child whose
 * run the tracker had no room for (past its cap) is not told or logged at all: a
 * viewer would show a run that never ends.
 */
export function createTurnFlowSink(options: {
    tracker: TurnFlowTracker;
    turnEvents: Pick<SessionTurnEvents, 'onSdkEvent' | 'onCompaction' | 'onPlan' | 'onSubagent'> | undefined;
    agentKey: string;
    /** The delegation calls this leg re-enters (marked on their `start`). */
    resumedCalls?: ReadonlySet<string>;
    onToolEvent?: (event: AgentToolCallEvent) => void;
    onCompaction?: (compaction: AgentCompactionEvent) => void;
    onPlan?: (plan: AgentPlanEvent) => void;
    onSubagent?: (event: AgentSubagentEvent) => void;
}): (event: AgentSdkEvent) => void {
    const { tracker, turnEvents, agentKey } = options;
    /** A caller's callback must never break the run. */
    const tell = <T>(name: string, callback: ((value: T) => void) | undefined, value: T) => {
        if (!callback) return;
        try {
            callback(value);
        } catch (callbackError) {
            logger.warn(`${name} callback failed`, { agentKey, error: callbackError });
        }
    };
    return (event) => {
        switch (event.type) {
            case 'tool_call': {
                const { stamp, dropped } = tracker.noteToolCall(event);
                if (dropped) return;
                turnEvents?.onSdkEvent(event, stamp);
                if (!options.onToolEvent) return;
                const payload = toToolCallEvent(event, options.resumedCalls);
                if (!payload) return;
                tell('onToolEvent', options.onToolEvent, stamp ? { ...payload, subagent: stamp } : payload);
                return;
            }
            case 'plan': {
                const plan = tracker.notePlan(event);
                if (!plan) return;
                turnEvents?.onPlan(plan);
                tell('onPlan', options.onPlan, plan);
                return;
            }
            case 'subagent': {
                const lifecycle = tracker.noteSubagent(onDelegationCall(event));
                if (!lifecycle) return;
                turnEvents?.onSubagent(lifecycle);
                tell('onSubagent', options.onSubagent, lifecycle);
                return;
            }
            case 'summarization': {
                const note = tracker.noteCompaction(event);
                if (!note) return;
                if (note.persist) turnEvents?.onCompaction(note.event);
                tell('onCompaction', options.onCompaction, note.event);
                return;
            }
            default:
                return;
        }
    };
}

/**
 * What a leg's tracker recorded, as the fields of the assistant message (and of
 * the playground result): only those that happened, so a turn without a plan or
 * a sub-agent stores nothing extra. A turn that called its plan tool and wrote
 * no version (a read) stores an empty `plans`: the field says the turn records its
 * plan versions, so a reader leaves that call out as the live view does, where a
 * turn without any plan call (or stored before plans were recorded) keeps every
 * call it made. `compactedToolsOf` finds the whole leg's replaced
 * tool results by diffing the transcript (see `compactedToolResults`); it is asked
 * only when a pass happened, and the tracker hands each result to the pass that made it.
 */
export function turnFlowRecord(
    tracker: TurnFlowTracker,
    compactedToolsOf: () => Array<{ toolName: string; toolCallId: string }>,
): Pick<IAgentConversationMessage, 'plans' | 'subagentRuns' | 'subagentRunsDropped' | 'compactions' | 'compactedTools'> {
    const { plans, planCalls, subagentRuns, subagentRunsDropped, compactions: passes } = tracker.snapshot();
    const compactedTools = passes.length > 0 ? compactedToolsOf() : [];
    const compactions = tracker.finalizeCompactedTools(compactedTools);
    return {
        ...(compactions.length > 0 ? { compactions, ...(compactedTools.length > 0 ? { compactedTools: [...compactedTools] } : {}) } : {}),
        ...(plans.length > 0 || planCalls > 0 ? { plans } : {}),
        ...(subagentRuns.length > 0 ? { subagentRuns } : {}),
        ...(subagentRunsDropped > 0 ? { subagentRunsDropped } : {}),
    };
}

/** The reasoning of a finished turn: what streamed (every model step), else the last message's. */
export function turnReasoning(result: AgentSdkInvokeResult, reasoningTap: { text: () => string }): string | undefined {
    return reasoningTap.text() || extractAgentReasoning(result);
}
