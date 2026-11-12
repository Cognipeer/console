/**
 * Types and small pure helpers shared by the chat, playground and resume
 * paths: the run cancellation cell, the chat request / response shapes, the
 * tool-call event, and the relay options of a routed request.
 */

import type { RoutingCallerContext } from '@/lib/services/models/routingCallerContext';
import type { RelayCallerOptions, WorkerRelay } from '@/lib/core/cluster';
import type { SmartAgentEvent as AgentSdkEvent } from '@cognipeer/agent-sdk';
import type { IAgentConversationMessage, IAgentConversationStep, IAgentMessageVersion } from '@/lib/database/provider/types.domain';
import type { AgentResponseFormat } from '@/lib/database';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';
import type { ClientFileAnnotation, ClientOutputFile, ClientPendingAction } from './clientWire';
import type { AgentRunCaller } from './agentQuota';
import type { ReminderWake } from './agentReminderTools';
import type { AgentStopReason } from './agentTurnState';
import type { DurableTurn, RunCheckpointer } from './runCheckpoint';
import { isDelegationTool, subagentStampOf } from './subagentEvents';
import type { AgentCompactionEvent, AgentPlanEvent, AgentSubagentEvent, AgentToolCallSubagentStamp } from '@/lib/shared/agentTurnFlow';
import type { EmbeddedRunContext } from './agentClientTools';
import type { NormalizedReasoning } from '@/lib/services/models/reasoning';

/**
 * Shared mutable reference threaded through `executeAgentChatLocal` so a
 * deadline (synchronous ceiling, §5) or an asynchronously-flipped cancel flag
 * (background mode, §7 step 6) can stop a turn's outcome from being
 * persisted — WITHOUT waiting for `sdkAgent.invoke()` itself to return early,
 * which the SDK's own cancellation primitives cannot reliably do (an
 * in-flight tool/model call runs to completion regardless — see the
 * promoted spike in `__tests__/unit/agent-sdk-cancellation.test.ts`, §12.2).
 *
 * `deadlineAt` (sync path) and `cancelled` (background path, flipped by the
 * worker's own heartbeat-cadence poll of `cancelRequestedAt`) are checked
 * together, once, immediately before the conversation write (§12.12) — not
 * relied on to actually interrupt the in-flight call.
 */
export interface AgentRunCancellationCell {
    /** Absolute epoch-ms deadline. When set and already passed, the turn is superseded. */
    deadlineAt?: number;
    /** Flipped to `true` asynchronously by an external caller (e.g. a background worker's cancel poll). */
    cancelled: boolean;
    /**
     * Set when the run was finalized WITHOUT waiting for this turn to stop (its
     * ceiling passed while a call hung): the conversation is free for a newer turn
     * and this one is only running out. It writes nothing mid-turn from then on, and
     * its end is recorded only if no newer turn took the session (`runtimeTurnId`).
     */
    abandoned?: boolean;
    /** Durable runs: the turn's checkpointer, so a shutdown can write the latest step and hand the run off. */
    checkpointer?: RunCheckpointer;
}

/** True once a deadline has passed or an explicit cancel has been recorded. */
export function isCancellationCellTripped(cell: AgentRunCancellationCell | undefined): boolean {
    if (!cell) return false;
    if (cell.cancelled) return true;
    if (cell.deadlineAt !== undefined && Date.now() > cell.deadlineAt) return true;
    return false;
}

/**
 * Bridges the mutable `cancellationCell.cancelled` flag into an `AbortSignal`
 * the SDK's `InvokeConfig.cancellationToken` understands. A short poll
 * interval is the only way to observe a plain boolean flipping asynchronously
 * from the outside during an in-flight `invoke()` call — this is a
 * best-effort inner control (§12.2: it stops the loop before its NEXT step,
 * it does not interrupt a call already in flight), not the mechanism that
 * actually bounds the caller's wait (that is the `Promise.race` at the call
 * site, §5/§7 step 5).
 */
const CANCELLATION_CELL_POLL_MS = 250;

/**
 * ONE `cancellationToken` for the SDK out of the two ways a turn can be
 * stopped: the cell (deadline / background cancel, polled) and the caller's
 * own `signal` (e.g. a realtime barge-in, event-driven). Either aborts it.
 * With only a signal there is nothing to poll and the signal is used as is.
 */
export function bridgeCancellationCell(
    cell: AgentRunCancellationCell | undefined,
    callerSignal?: AbortSignal,
): { signal?: AbortSignal; stop: () => void } {
    if (!cell) return { ...(callerSignal ? { signal: callerSignal } : {}), stop: () => undefined };
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (cell.cancelled || callerSignal?.aborted) controller.abort(callerSignal?.reason);
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setInterval(() => {
        if (cell.cancelled && !controller.signal.aborted) controller.abort();
    }, CANCELLATION_CELL_POLL_MS);
    timer.unref?.();
    return {
        signal: controller.signal,
        stop: () => {
            clearInterval(timer);
            callerSignal?.removeEventListener('abort', onCallerAbort);
        },
    };
}

/**
 * Remembers the text a turn has streamed so far, for the one case where
 * nothing else can say what was produced: the caller aborted and the model
 * call REJECTED (a provider that honours the abort signal throws instead of
 * returning), so there is no result to read the partial answer from.
 */
export function captureStreamedText(onTextChunk: ((text: string) => void) | undefined): {
    onTextChunk?: (text: string) => void;
    text: () => string;
} {
    if (!onTextChunk) return { text: () => '' };
    let streamed = '';
    return {
        onTextChunk: (text: string) => {
            streamed += text;
            onTextChunk(text);
        },
        text: () => streamed,
    };
}

/** `stopDetail` of a turn the caller's `signal` ended (the SDK's own wording for it). */
export const CALLER_ABORT_DETAIL = 'aborted';

export interface AgentChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    conversationId: string;
    userMessage: string;
    /** Ids of the conversation's files this message attaches (uploaded to the session first). */
    attachments?: string[];
    userId: string;
    /**
     * Whose spend limits the turn counts against when `userId` is a synthetic
     * owner (a trigger run): the trigger's accountable person.
     */
    accountableUserId?: string;
    /** The background run executing this turn, when there is one — stamped on its session events. */
    runId?: string;
    /** Durable runs: set for a run that writes checkpoints (see runCheckpoint.ts). */
    durable?: DurableTurn;
    /**
     * The reminder this turn is the wake-up of (a run of `channel: 'reminder'`): the turn starts
     * with a note framed as the agent's own (`reminderNoteText`), stored with `metadata.origin`.
     */
    reminder?: ReminderWake;
    /**
     * No interactive user on this turn (a schedule, an eval or red-team case, an
     * OpenAI-shaped client). An approval-gated tool call or a
     * question then follows the agent's `humanInTheLoop.unattended` setting —
     * `deny` (default: the call fails, the run goes on), `pause` (waits for
     * Studio, like an attended run) or `allow` (runs without approval) — rather
     * than parking on a prompt no one will see.
     */
    unattended?: boolean;
    /**
     * The caller can run the agent's client tools even though it cannot answer an
     * approval (the OpenAI-shaped chat completions bridge: a `tool_calls` reply
     * and a `tool` message are its way of asking and answering). Only meaningful
     * with `unattended`; a client tool that would need approval is then not offered
     * unless `humanInTheLoop.unattended` is `allow`.
     */
    answersClientTools?: boolean;
    /**
     * The model the route resolved for this turn (`resolveAgentRunModel`; the policy decision was the
     * route's). Must be the agent's main model or on its `additionalModels`, otherwise the main model runs.
     * A background turn takes the choice stored on its session instead.
     */
    modelKey?: string;
    /**
     * Reasoning the API request asked for (`reasoning_effort` / `reasoning: {effort}`, already
     * validated by the route). The lowest rung: the agent's pick and the Model Hub default win.
     */
    requestReasoning?: NormalizedReasoning;
    /** Request a specific published version (API/SDK) */
    version?: number;
    /** When true, use the published version (default for API/SDK calls) */
    usePublished?: boolean;
    /**
     * Caller-supplied runtime context (headers for downstream tools/MCP/
     * connected agents, metadata). Plain data — serializes over the job queue.
     */
    runtimeContext?: AgentRuntimeContext;
    /**
     * Who is asking and through which door (portal key, group ids, ...), for
     * Dynamic LLM caller conditions. Plain data. Fields left out are derived
     * from the request: agentKey, projectId, userId, the channel from
     * `runtimeContext.source`, the API token from `runtimeContext.tokenId`.
     */
    callerContext?: RoutingCallerContext;
    /**
     * Per-request structured output and validated agent variables. The run engine
     * carries them on the run row (so a queued run and a resume see the same
     * values) and passes them here; how the turn applies them is §6 of the run
     * engine spec.
     */
    responseFormat?: AgentResponseFormat;
    variables?: Record<string, unknown>;
    /**
     * Whether `variables` also fill the `{{variables.<name>}}` prompt variables (default
     * true). Off for variables that came from outside the platform's own callers: they
     * then reach the model only inside the user message, never the system prompt. The
     * prompt still reads the declared defaults and the values named in `literalVariables`.
     */
    variablesInPrompt?: boolean;
    /**
     * With `variablesInPrompt: false`: the names in `variables` whose value did not come
     * from the external content (a trigger's own fixed values). Only these, besides the
     * declared defaults, fill `{{variables.<name>}}` in the system prompt.
     */
    literalVariables?: string[];
    /**
     * The message / variables came from an external payload (a webhook): the Variables
     * block is closed with a line saying where the external data ends.
     */
    externalContent?: boolean;
    /** The event behind a webhook / connector trigger fire (`IAgentRun.triggerData`); a FlowBase agent hands it to its flow. */
    triggerData?: Record<string, unknown>;
    /**
     * Incremental answer text — internal agents (model token stream) and
     * connected agents (SSE) alike. Functions cannot cross the job queue, so
     * a run routed to another node replays its chunks over the cluster stream
     * relay (Redis pub/sub); without Redis a routed run streams nothing and
     * the caller still gets the complete result.
     */
    onTextChunk?: (text: string) => void;
    /**
     * Incremental reasoning ("thinking") text while the model thinks, for a
     * caller that can show it live. Asking for it turns the model call into a
     * stream; nothing fires when the agent hides its reasoning
     * (`showReasoning: false`) or the model produced none. Same relay caveat
     * as `onTextChunk`.
     */
    onReasoningChunk?: (text: string) => void;
    /**
     * Shared deadline/cancel reference for the synchronous ceiling (§5) and
     * background max-duration/cancel (§7) — see `AgentRunCancellationCell`.
     * Absent for ordinary calls (dashboard, playground-adjacent callers),
     * which keep today's unconditional-persist behavior.
     */
    cancellationCell?: AgentRunCancellationCell;
    /**
     * The caller is no longer interested (a realtime barge-in, a closed
     * client). Stops the agent loop / connected-agent request; the turn then
     * RESOLVES — never rejects — with the text produced so far and
     * `stop_reason: 'cancelled'`. A run the SDK stopped at a step boundary
     * (and a connected agent's partial answer, guarded) is persisted like any
     * other cancelled run; a model call torn down mid-flight leaves no state
     * to persist, so the conversation stays as it was. Relayed to the worker
     * when the run is routed.
     */
    signal?: AbortSignal;
}

/** Tool-call progress notification surfaced while an agent run executes. */
export interface AgentToolCallEvent {
    phase: 'start' | 'success' | 'error';
    /** Tool name as the agent sees it (e.g. `knowledge_search`). */
    name: string;
    /** Provider tool-call id, when available. */
    id?: string;
    /**
     * The call's arguments. Carried so a live row can say WHICH search is
     * running ("web_search · Cognipeer") rather than just that one is — with
     * several parallel calls of the same tool, the name alone identifies
     * nothing.
     */
    args?: unknown;
    /** Filled on the terminal phase. */
    durationMs?: number;
    /** Filled on `error`. */
    error?: string;
    /**
     * Set when a delegated child made the call (a step of its own loop). Absent
     * on the agent's own calls and on the delegation call that handed the task
     * over: a child cannot delegate, so it never emits a delegation tool event.
     * It also names the delegation call it belongs to and whether that ran in
     * parallel, so a call can be shown under its sub-agent.
     */
    subagent?: AgentToolCallSubagentStamp;
    /**
     * Set only on the `start` of a delegation call the SDK re-enters after a
     * child's pause was answered (same call id as in the paused turn).
     */
    resumed?: true;
}

/** The notification for an SDK tool_call event, or undefined for any other event. */
export function toToolCallEvent(event: AgentSdkEvent, resumedCalls?: ReadonlySet<string>): AgentToolCallEvent | undefined {
    if (event.type !== 'tool_call' || !event.name) return undefined;
    if (event.phase !== 'start' && event.phase !== 'success' && event.phase !== 'error') return undefined;
    const subagent = subagentStampOf(event);
    const resumed = event.phase === 'start' && !subagent && isDelegationTool(event.name)
        && typeof event.id === 'string' && Boolean(resumedCalls?.has(event.id));
    return {
        phase: event.phase,
        name: event.name,
        id: event.id,
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
        ...(event.error?.message ? { error: event.error.message } : {}),
        ...(subagent ? { subagent } : {}),
        ...(resumed ? { resumed: true as const } : {}),
    };
}

/** Ephemeral (playground) chat — no DB conversation required */
export interface AgentPlaygroundChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    userMessage: string;
    /** The model the route resolved for this turn - see `AgentChatRequest.modelKey`. */
    modelKey?: string;
    /** See `AgentChatRequest.requestReasoning`. */
    requestReasoning?: NormalizedReasoning;
    /** Who is asking and through which door - see `AgentChatRequest.callerContext`. Overrides what is derived from the runtime context. */
    callerContext?: RoutingCallerContext;
    /** Ids of the session's files this message attaches (a Session only; uploaded to it first). */
    attachments?: string[];
    /**
     * Previous messages for context. Ignored (and the DB history loaded
     * instead) whenever `conversationId` is set — a caller-supplied history
     * next to a real conversation id would let the client fabricate turns the
     * agent never actually produced, and persist them.
     */
    history?: Array<{ role: string; content: string }>;
    /**
     * Backs this run with a persisted Session: history loads from the
     * conversation instead of `history`, and the exchange (including steps/
     * usage/output) is written back afterward. Omitted, this behaves exactly
     * as the stateless playground always has — in-memory, nothing saved.
     */
    conversationId?: string;
    /**
     * Run a published version instead of the draft. The playground's whole point
     * is the draft, so absent means draft — but comparing a change against what
     * is live is the other half of that job.
     */
    version?: number;
    /**
     * Caller-supplied runtime context (headers for downstream tools/MCP/
     * connected agents, metadata). Plain data — serializes over the job queue.
     */
    runtimeContext?: AgentRuntimeContext;
    /**
     * Best-effort: fires as the agent starts/finishes each tool call so
     * callers (e.g. realtime sessions) can surface progress. Functions cannot
     * cross the job queue — when the agent is assigned to another cluster node
     * the events are replayed over the cluster stream relay (Redis pub/sub);
     * without it the run still works, but no events fire. Connected agents
     * run their tools remotely and never fire it.
     */
    onToolEvent?: (event: AgentToolCallEvent) => void;
    /**
     * Incremental answer text, for a caller that can render it as it arrives —
     * internal agents (model token stream) and connected agents (SSE) alike.
     * Same relay caveat as `onToolEvent`.
     */
    onTextChunk?: (text: string) => void;
    /**
     * Incremental reasoning text while the model thinks (the operator's playground
     * always gets it when the model produced it). Same relay caveat as `onToolEvent`.
     */
    onReasoningChunk?: (text: string) => void;
    /**
     * Operator view: ask the provider for the thinking text (Claude: summarized
     * display) even when the agent hides reasoning from its API responses. The
     * result carries it; what a Session STORES still follows the agent's setting.
     */
    revealReasoning?: boolean;
    /**
     * Fires when the agent summarizes its context mid-run: when a pass starts
     * (`phase: 'start'`, live only), when it ends, and for a sub-agent's own passes
     * (`subagent` set). Same relay caveat as `onToolEvent`.
     */
    onCompaction?: (compaction: AgentCompactionEvent) => void;
    /** Fires with each plan version the agent writes (manage_plan). Same relay caveat as `onToolEvent`. */
    onPlan?: (plan: AgentPlanEvent) => void;
    /** Fires as each sub-agent starts, answers, fails or pauses. Same relay caveat as `onToolEvent`. */
    onSubagent?: (event: AgentSubagentEvent) => void;
    /**
     * Abort the turn (realtime barge-in). The run RESOLVES with the text
     * produced so far, `stopReason: 'cancelled'` and `stopDetail: 'aborted'`;
     * a Session turn is persisted that way. Relayed to the worker when the
     * run is routed to another node.
     */
    signal?: AbortSignal;
    /**
     * This run is embedded in a host page that declared client tools: they are
     * offered to the model for this run only, and a call pauses the turn as a
     * `client_tool` pending action the page answers. Set by a host that KNOWS
     * the embedding (a portal's embed session) — never from a client request.
     * Needs a Session (`conversationId`) to park the paused turn on.
     */
    embedded?: EmbeddedRunContext;
    /**
     * The answer(s) this turn replaces — set when a regenerate re-runs a user
     * message (`prepareSessionRerun`): the new assistant message keeps them as
     * `previousVersions` (newest last, at most 5).
     */
    previousVersions?: IAgentMessageVersion[];
}

/**
 * One tool call as the playground shows it.
 *
 * The playground is where an operator debugs an agent, so a step carries the
 * arguments and the result — not just the name. The live chat path deliberately
 * does NOT return these: a tool result can be large and can contain exactly the
 * data a guardrail redacted from the answer.
 */
export type AgentPlaygroundStep = IAgentConversationStep;

/** A session turn's result: the persisted assistant message minus role/timestamp, which `persistSessionTurn` adds. */
export type AgentPlaygroundChatResult = Omit<IAgentConversationMessage, 'role' | 'timestamp'>;

/** OpenAI Responses API–compatible output content item */
export interface ResponseOutputText {
    type: 'output_text';
    text: string;
    /** Files the agent produced this turn (`file_path`, as OpenAI's code interpreter cites its files). Additive. */
    annotations?: ClientFileAnnotation[];
}

/** OpenAI Responses API–compatible output message */
export interface ResponseOutputMessage {
    id: string;
    type: 'message';
    role: 'assistant';
    content: ResponseOutputText[];
}

/** OpenAI Responses API–compatible reasoning ("thinking") output item */
export interface ResponseReasoningItem {
    id: string;
    type: 'reasoning';
    summary: Array<{ type: 'summary_text'; text: string }>;
}

export type ResponseOutputItem = ResponseReasoningItem | ResponseOutputMessage;

/** OpenAI Responses API–compatible usage */
export interface ResponseUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** The cached slice of `input_tokens` (0 when the run did not report one). */
    input_tokens_details: { cached_tokens: number };
    /** The reasoning slice of `output_tokens` (0 when the run did not report one). */
    output_tokens_details: { reasoning_tokens: number };
}

/** OpenAI Responses API–compatible response shape */
export interface AgentChatResponse {
    id: string;
    object: 'response';
    model: string;
    output: ResponseOutputItem[];
    /**
     * `incomplete` when a run limit, a cancellation or a pause ended the run
     * before a final answer — see `incomplete_details` and `stop_reason`.
     */
    status: 'completed' | 'failed' | 'incomplete' | 'requires_action';
    /** OpenAI Responses convention: why the response is `incomplete`. */
    incomplete_details?: { reason: string } | null;
    /** OpenAI Responses convention: present when `status` is `failed` — the run is over and cannot be continued. */
    error?: { code: string; message: string } | null;
    /** How the agent run ended; `completed` for a normal final answer, `requires_action` while it waits on a person. */
    stop_reason?: AgentStopReason | 'requires_action' | 'budget_reached';
    /** Present when `status` is `requires_action`: the approvals / questions to resolve. */
    required_action?: { type: 'agent_actions'; actions: ClientPendingAction[] };
    /** The runtime's own wording for a non-`completed` stop, e.g. which limit. */
    stop_detail?: string;
    usage: ResponseUsage;
    created_at: number;
    previous_response_id: string | null;
    /** Version used for this response (null if not versioned) */
    version: number | null;
    /**
     * Validated structured answer, present only when the agent declares a
     * structured-output schema and the final answer satisfied it. Additive:
     * the top-level `output` stays the OpenAI-style item array.
     */
    output_parsed?: unknown;
    /** Why the structured contract failed (parse/validation); mutually exclusive with `output_parsed`. */
    output_error?: string;
    /** Files the agent produced this turn (its sandbox's `/outputs/`, or `session_files_create`), saved as session files. Additive; absent when none. */
    output_files?: ClientOutputFile[];
    /** Things the turn could not do as configured (a sub-agent skipped or empty, files not delivered, a tool not offered). Additive; absent when none. */
    warnings?: string[];
    /** Conversation messages for dashboard playgrounds */
    _conversation_messages?: Array<{ role: string; content: string; reasoning?: string; timestamp: Date }>;
}

/**
 * `incomplete_details.reason` for a run that stopped early. `max_output_tokens`
 * is OpenAI's own value, so a stock client recognizes the output-token cap;
 * the rest are this API's, named after the limit that fired.
 */
export function incompleteReason(stopReason: AgentStopReason | 'budget_reached', stopDetail?: string): string {
    if (stopReason === 'limit') {
        if (stopDetail?.startsWith('maxTotalOutputTokens') || stopDetail?.startsWith('maxOutputTokens')) return 'max_output_tokens';
        if (stopDetail?.startsWith('maxCostUsd')) return 'max_cost';
        if (stopDetail?.startsWith('maxWallClockMs')) return 'max_duration';
        return 'run_limit';
    }
    return stopReason;
}

/**
 * The live parts of a request that cannot ride in a queue payload, as relay
 * handlers for `routeInstanceCall`. Event names are the contract with
 * `agentRelayCallbacks` on the worker.
 */
export function agentRelayOptions(request: {
    onTextChunk?: (text: string) => void;
    onReasoningChunk?: (text: string) => void;
    onToolEvent?: (event: AgentToolCallEvent) => void;
    onCompaction?: (compaction: AgentCompactionEvent) => void;
    onPlan?: (plan: AgentPlanEvent) => void;
    onSubagent?: (event: AgentSubagentEvent) => void;
    signal?: AbortSignal;
}): RelayCallerOptions {
    const { onTextChunk, onReasoningChunk, onToolEvent, onCompaction, onPlan, onSubagent } = request;
    return {
        handlers: {
            text: onTextChunk ? (data) => { if (typeof data === 'string') onTextChunk(data); } : undefined,
            reasoning: onReasoningChunk ? (data) => { if (typeof data === 'string') onReasoningChunk(data); } : undefined,
            tool: onToolEvent ? (data) => onToolEvent(data as AgentToolCallEvent) : undefined,
            compaction: onCompaction ? (data) => onCompaction(data as AgentCompactionEvent) : undefined,
            plan: onPlan ? (data) => onPlan(data as AgentPlanEvent) : undefined,
            subagent: onSubagent ? (data) => onSubagent(data as AgentSubagentEvent) : undefined,
        },
        ...(request.signal ? { signal: request.signal } : {}),
    };
}

/**
 * Worker side of `agentRelayOptions`: callbacks that publish back to the
 * caller, ONLY for the events the caller listens for (an `onTextChunk` turns
 * the SDK's streaming on — a caller that did not ask for text must not change
 * how the model is called), plus the caller-controlled abort signal.
 * EXPORTED for the queue consumer.
 */
export function agentRelayCallbacks(relay: WorkerRelay | null): Pick<
    AgentPlaygroundChatRequest,
    'onTextChunk' | 'onReasoningChunk' | 'onToolEvent' | 'onCompaction' | 'onPlan' | 'onSubagent' | 'signal'
> {
    if (!relay) return {};
    return {
        ...(relay.events.has('text') ? { onTextChunk: (text: string) => relay.emit('text', text) } : {}),
        ...(relay.events.has('reasoning') ? { onReasoningChunk: (text: string) => relay.emit('reasoning', text) } : {}),
        ...(relay.events.has('tool') ? { onToolEvent: (event: AgentToolCallEvent) => relay.emit('tool', event) } : {}),
        ...(relay.events.has('compaction')
            ? { onCompaction: (compaction: AgentCompactionEvent) => relay.emit('compaction', compaction) }
            : {}),
        ...(relay.events.has('plan') ? { onPlan: (plan: AgentPlanEvent) => relay.emit('plan', plan) } : {}),
        ...(relay.events.has('subagent') ? { onSubagent: (event: AgentSubagentEvent) => relay.emit('subagent', event) } : {}),
        ...(relay.signal ? { signal: relay.signal } : {}),
    };
}

/**
 * Who a run is for, as the agent-run quota (domain `agent`) sees it. The
 * runtime context carries the identity the server stamped on the request — the
 * dashboard user, a portal user, an API token and its owner — so a run entry
 * point that has no `userId` field of its own is still attributed.
 */
export function agentRunCallerOf(request: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    userId?: string;
    runtimeContext?: AgentRuntimeContext;
}): AgentRunCaller {
    return {
        tenantDbName: request.tenantDbName,
        tenantId: request.tenantId,
        projectId: request.projectId,
        agentKey: request.agentKey,
        userId: request.userId || request.runtimeContext?.userId,
        tokenId: request.runtimeContext?.tokenId,
    };
}
