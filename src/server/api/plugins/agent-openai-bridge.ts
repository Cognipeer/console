import type { NormalizedReasoning } from '@/lib/services/models/reasoning';
import type { AgentModelChoice } from '@/lib/services/agents/agentModelSelection';
import { rememberSessionModel } from './agent-model-authz';
import { CONCURRENCY_RETRY_AFTER_SECONDS, startRunOnSession, type PreparedInvocationSession } from './agent-invocation';
import {
    agentRunConcurrencyLimitErrorBody,
    isAgentRunActive,
    resolveAgentRunLimits,
    waitForAgentRun,
    type AgentRunLimits,
} from '@/lib/services/agents/agentRunService';
/**
 * An agent, answered as an OpenAI chat completion.
 *
 * Every other agent surface needs a client that knows about this console:
 * `/responses` takes an agent key in `model` but an OpenAI-shaped `input`,
 * `/a2a` speaks A2A. The one
 * thing missing was the shape every SDK in every language already speaks —
 * so an agent could be built here and then not be callable from the code a
 * team already has.
 *
 * This is deliberately a BRIDGE, not a second agent runtime: it translates
 * a chat-completions request into the same run (`startAgentRun`, channel
 * `chat_completions`) the Responses API starts, and translates the answer back. Nothing about how an agent runs
 * is decided here.
 *
 * Resolution order matters and is not negotiable: a model key wins. An agent
 * is only looked up when no model by that name exists, so no existing caller
 * can have its traffic re-routed by someone creating an agent whose key
 * collides with a model. `agent:<key>` is the explicit form that always means
 * an agent, for the case where a collision exists and the agent is wanted.
 */

import { createLogger } from '@/lib/core/logger';
import {
    resolveAgentPendingAction,
    type ApprovalAuthorizer,
    type ResolveActor,
    type ResolveOutcome,
} from '@/lib/services/agents/agentActionResolution';
import { toClientPendingAction, toFileAnnotations, type ClientOutputFile, type ClientPendingAction } from '@/lib/services/agents/clientWire';
import type { AgentResponseFormat, AgentRunClass, IAgent, IAgentRun } from '@/lib/database';
import { createConversation, getAgentByKey, getConversationById } from '@/lib/services/agents';
import {
    executeAgentChat,
    type AgentChatResponse,
    type AgentConversationSource,
} from '@/lib/services/agents/agentService';

const logger = createLogger('api:agent-openai-bridge');

/** `agent:<key>` always means an agent; a bare name defers to models first. */
export const AGENT_MODEL_PREFIX = 'agent:';

export interface OpenAiMessage {
    role?: string;
    content?: unknown;
    /** `tool` messages: the call this answers (the `id` of a `tool_calls` entry we sent). */
    tool_call_id?: string;
    /** Not OpenAI: a `tool` message that reports the tool failing rather than its result. */
    is_error?: boolean;
}

/** One entry of an assistant message's `tool_calls`: a client tool the agent wants the caller to run. */
export interface ChatToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

/** The client tool calls among an agent's open requests, as chat-completion `tool_calls`. */
export function toChatToolCalls(actions: ReadonlyArray<ClientPendingAction> | undefined): ChatToolCall[] {
    return (actions ?? [])
        .filter((action) => action.kind === 'client_tool' && action.status === 'pending' && typeof action.tool_name === 'string')
        .map((action) => ({
            id: action.id,
            type: 'function' as const,
            function: { name: String(action.tool_name), arguments: JSON.stringify(action.args ?? {}) },
        }));
}

/**
 * What a chat-completions client reads when a turn is paused on something this
 * wire cannot answer (an approval, a question): the message names what waits
 * and where to answer it, so `content` is never an empty 200.
 */
export function pausedMessage(actions: ReadonlyArray<ClientPendingAction>, conversationId: string): string {
    const open = actions.filter((action) => action.status === 'pending');
    const lines = open.map((action) => {
        const by = action.subagent ? ` (requested by sub-agent "${action.subagent}")` : '';
        if (action.kind === 'tool_approval') return `- approval to run the tool "${action.tool_name ?? 'unknown'}"${by} [action ${action.id}]`;
        const first = (action.questions ?? [])
            .map((q) => (q && typeof q === 'object'
                ? (q as Record<string, unknown>).question ?? (q as Record<string, unknown>).text ?? (q as Record<string, unknown>).prompt
                : q))
            .find((q): q is string => typeof q === 'string' && q.length > 0);
        return `- an answer to the question${first ? ` "${first}"` : ''}${by} [action ${action.id}]`;
    });
    return [
        'The agent is paused and waiting for:',
        ...lines,
        `Answer in the Console (session ${conversationId}) or with POST /client/v1/agents/sessions/${conversationId}/actions/{action id}; the turn then carries on.`,
    ].join('\n');
}

export interface ToolAnswer {
    callId: string;
    /** The body of the actions endpoint: `{ output }` or `{ error }`. */
    body: Record<string, unknown>;
}

/**
 * The `tool` messages that close the transcript - the answers to the tool calls
 * the last reply asked for. Everything before the last assistant message is
 * history the agent already owns (it keeps its own conversation record).
 */
export function extractToolAnswers(messages: OpenAiMessage[] | undefined): ToolAnswer[] {
    if (!Array.isArray(messages)) return [];
    let start = messages.length;
    while (start > 0 && messages[start - 1]?.role === 'tool') start -= 1;
    const answers: ToolAnswer[] = [];
    for (const message of messages.slice(start)) {
        if (typeof message.tool_call_id !== 'string' || message.tool_call_id === '') continue;
        const text = flattenContent(message.content);
        if (message.is_error === true) {
            answers.push({ callId: message.tool_call_id, body: { error: text || 'The tool failed.' } });
            continue;
        }
        let output: unknown = text;
        // A tool message's content is a string; a caller that returns JSON gets it back as JSON.
        if (text.startsWith('{') || text.startsWith('[')) {
            try { output = JSON.parse(text); } catch { output = text; }
        }
        answers.push({ callId: message.tool_call_id, body: { output } });
    }
    return answers;
}

/**
 * Decides whether a `model` value names an agent this project can run.
 *
 * `modelExists` is asked FIRST for a bare name — see the resolution order in
 * this file's header. Returns the agent, or null to mean "carry on with the
 * model path", which is also what an inactive agent returns: a draft agent
 * must not start answering production traffic just because its key was typed.
 */
export async function resolveAgentModel(
    model: string,
    ctx: { tenantDbName: string; projectId: string },
    modelExists: (key: string) => Promise<boolean>,
): Promise<IAgent | null> {
    const explicit = model.startsWith(AGENT_MODEL_PREFIX);
    const key = explicit ? model.slice(AGENT_MODEL_PREFIX.length) : model;
    if (!key) return null;

    // Fails soft, deliberately. This runs on the hot path of EVERY
    // chat-completions call, so a lookup that throws — a bad connection, a
    // tenant whose agent store is unavailable — must not take model traffic
    // down with it. Returning null carries on as a model call, which is what
    // the request was before agents were addressable here at all.
    try {
        if (!explicit && await modelExists(key)) return null;

        const agent = await getAgentByKey(ctx.tenantDbName, key, ctx.projectId);
        if (!agent) return null;
        if (agent.status !== 'active') {
            logger.info('Agent addressed by an inference call is not active', { agentKey: key });
            return null;
        }
        return agent;
    } catch (error) {
        logger.warn('Agent lookup failed for an inference call; treating it as a model', {
            model,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

/**
 * The last user turn, as the agent runtime wants it.
 *
 * Only the last one: the agent owns its own history (a conversation record),
 * so replaying the client's transcript would duplicate every prior turn. A
 * caller that wants continuity passes `conversation_id`.
 */
export function extractLastUserMessage(messages: OpenAiMessage[] | undefined): string | undefined {
    if (!Array.isArray(messages)) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') continue;
        const text = flattenContent(message.content);
        if (text) return text;
    }
    return undefined;
}

/** Accepts both the plain string and the content-part array form. */
export function flattenContent(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') {
                const record = part as Record<string, unknown>;
                if (typeof record.text === 'string') return record.text;
            }
            return '';
        })
        .join('')
        .trim();
}

export interface AgentCompletionContext {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    userId: string;
}

/**
 * Resolves the conversation this call continues, creating one when it does
 * not name an existing thread.
 *
 * Scoped on agent AND project, the same check the Responses API makes: an
 * agent key is not unique across projects, so without it a token in one
 * project could continue a conversation belonging to another.
 */
export async function resolveConversation(
    conversationId: string | undefined,
    agent: IAgent,
    ctx: AgentCompletionContext,
    source: AgentConversationSource,
    /** More session metadata for a session this call creates. */
    metadata: Record<string, unknown> = {},
): Promise<{ conversationId: string; created?: true } | { error: string }> {
    if (conversationId) {
        const conversation = await getConversationById(ctx.tenantDbName, conversationId);
        if (
            !conversation
            || conversation.agentKey !== agent.key
            || conversation.projectId !== ctx.projectId
        ) {
            return { error: 'conversation_id does not match a conversation for this agent' };
        }
        return { conversationId };
    }
    const created = await createConversation(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        ctx.userId,
        agent.key,
        undefined,
        { ...metadata, source },
    );
    return { conversationId: String(created._id), created: true };
}

export interface AgentCompletionUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

/**
 * `finish_reason` for an agent run. `length` when a run limit (tokens, time,
 * cost) cut it short — the answer is partial, and `length` is the value every
 * OpenAI client already treats as "truncated". Everything else is `stop`; the
 * precise reason travels in the non-OpenAI `stop_reason` field.
 */
export function agentFinishReason(stopReason: AgentChatResponse['stop_reason']): 'stop' | 'length' {
    return stopReason === 'limit' || stopReason === 'budget_reached' ? 'length' : 'stop';
}

/** The OpenAI chat-completion envelope, filled from an agent run. */
export function toChatCompletion(input: {
    id: string;
    model: string;
    content: string;
    usage?: AgentCompletionUsage;
    conversationId: string;
    stopReason?: AgentChatResponse['stop_reason'];
    stopDetail?: string;
    /** Client tools the agent is waiting on: the reply is a `tool_calls` message. */
    toolCalls?: ChatToolCall[];
    /** The agent's thinking text, when the agent and the request let it out (`reasoning_content`, as the model gateway names it). */
    reasoning?: string;
    /** Files the agent produced this turn: `output_files` on the body, `file_path` annotations on the message. */
    outputFiles?: ClientOutputFile[];
    /** The open approvals / questions of a paused turn, as the Responses API names them (`required_action`). */
    requiredAction?: { type: 'agent_actions'; actions: ClientPendingAction[] };
}) {
    const calling = (input.toolCalls?.length ?? 0) > 0;
    const files = input.outputFiles?.length ? input.outputFiles : undefined;
    const thinking = input.reasoning ? { reasoning_content: input.reasoning } : {};
    return {
        id: input.id,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [{
            index: 0,
            message: calling
                ? { role: 'assistant' as const, content: input.content || null, ...thinking, tool_calls: input.toolCalls }
                : {
                    role: 'assistant' as const,
                    content: input.content,
                    ...thinking,
                    ...(files ? { annotations: toFileAnnotations(files) } : {}),
                },
            finish_reason: calling ? ('tool_calls' as const) : agentFinishReason(input.stopReason),
        }],
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.requiredAction && !calling ? { required_action: input.requiredAction } : {}),
        // Not an OpenAI field: files the agent wrote for the user (download via `download_url`).
        ...(files ? { output_files: files } : {}),
        // Not OpenAI fields either: why a run ended without a final answer.
        ...(input.stopReason && input.stopReason !== 'completed' && !calling
            ? { stop_reason: input.stopReason, ...(input.stopDetail ? { stop_detail: input.stopDetail } : {}) }
            : {}),
        // Not an OpenAI field. An agent is stateful and the caller needs the
        // handle to continue the thread; hiding it would make every call a
        // fresh conversation with no way to say otherwise.
        conversation_id: input.conversationId,
    };
}

/** One `chat.completion.chunk`, for the streaming form. */
export function toChatChunk(input: {
    id: string;
    model: string;
    /** The first chunk of a stream: `delta.role: "assistant"`, as OpenAI opens it. */
    opening?: boolean;
    delta?: string;
    /** A piece of the agent's thinking text; the chunk then carries `delta.reasoning_content` and no `content`. */
    reasoning?: string;
    finish?: boolean;
    stopReason?: AgentChatResponse['stop_reason'];
    /** On the closing chunk: files the agent produced this turn (`files`, not an OpenAI field). */
    files?: ClientOutputFile[];
    /** The session (`conversation_id`, not an OpenAI field): on the first and the closing chunk. */
    conversationId?: string;
    /** On the closing chunk of a paused turn: the open approvals / questions (`required_action`, not an OpenAI field). */
    requiredAction?: { type: 'agent_actions'; actions: ClientPendingAction[] };
}) {
    return {
        id: input.id,
        object: 'chat.completion.chunk' as const,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [{
            index: 0,
            delta: input.opening
                ? { role: 'assistant' as const, content: '' }
                : input.finish
                ? {}
                : input.reasoning !== undefined
                    ? { reasoning_content: input.reasoning }
                    : { content: input.delta ?? '' },
            finish_reason: input.finish ? agentFinishReason(input.stopReason) : null,
        }],
        ...(input.finish && input.files?.length ? { files: input.files } : {}),
        ...(input.finish && input.requiredAction ? { stop_reason: 'requires_action', required_action: input.requiredAction } : {}),
        ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
    };
}

/** `stream_options.include_usage`: the chunk after the last one, no choices and the run's usage. */
export function toChatUsageChunk(input: { id: string; model: string; usage: AgentCompletionUsage }) {
    return {
        id: input.id,
        object: 'chat.completion.chunk' as const,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [],
        usage: input.usage,
    };
}

/** The closing chunk of a streamed reply that ends in client tool calls. */
export function toChatToolCallsChunk(input: { id: string; model: string; toolCalls: ChatToolCall[] }) {
    return {
        id: input.id,
        object: 'chat.completion.chunk' as const,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [{
            index: 0,
            delta: { tool_calls: input.toolCalls.map((call, index) => ({ index, ...call })) },
            finish_reason: 'tool_calls' as const,
        }],
    };
}

/** Who answers a tool call, and how the engine is asked whether they may. */
export interface ToolAnswerContext {
    authorize: ApprovalAuthorizer;
    actor: ResolveActor;
    audit?: { ipAddress?: string; userAgent?: string; requestId?: string };
}

export interface RunAgentCompletionInput {
    agent: IAgent;
    model: string;
    messages: OpenAiMessage[] | undefined;
    conversationId?: string;
    version?: number;
    /** Run the published version (the default); false = the draft (`version: "draft"`). */
    usePublished?: boolean;
    runtimeContext?: Parameters<typeof executeAgentChat>[0]['runtimeContext'];
    ctx: AgentCompletionContext;
    /** Present for the streaming form; the deltas go here as they arrive. */
    onTextChunk?: (text: string) => void;
    /** Present for the streaming form when the caller wants the thinking text too. */
    onReasoningChunk?: (text: string) => void;
    /** What answering a client tool call needs (the `tool` messages of the request). */
    answer?: ToolAnswerContext;
    /** The agent's model this run uses, resolved and authorized by the route (`agent_model`). */
    modelChoice?: AgentModelChoice;
    /** `reasoning_effort` / `reasoning: { effort }` of the request, validated by the route. Lowest rung. */
    requestReasoning?: NormalizedReasoning;
    /** `response_format` of the request (replaces the agent's structured output for the turn), validated by the route. */
    responseFormat?: AgentResponseFormat;
    /** The agent `variables` of the request, already validated against the agent's declaration. */
    variables?: Record<string, unknown>;
    /** The caller's run limits (its wait window included); the env ceilings otherwise. */
    limits?: AgentRunLimits;
    apiTokenId?: string;
    /** Aborts when the client disconnects: a stream then stops the run (OpenAI semantics), a plain call leaves it running. */
    signal?: AbortSignal;
    /** Aborts when the client goes away: a wait on a queued run stops then (the run is not touched). */
    waitSignal?: AbortSignal;
    /**
     * The user turn the route prepared: its text, and the session it runs on (created or continued, the
     * message's files stored on it). Absent, the turn is the last user message of `messages` on
     * `conversationId` (a new session when it is not given), without files.
     */
    turn?: { userMessage: string; session: PreparedInvocationSession };
    /** `deferred` queues the run on the low-priority queue and waits for it up to the window. */
    runClass?: AgentRunClass;
    metadata?: Record<string, string> | null;
    idempotencyKey?: string;
    /** The session folded into the idempotency hash: only when the request continues one (see startAgentRun). */
    idempotencyConversationScope?: string | null;
}

/** Why a request to answer a tool call was refused, as the chat-completions error. */
function answerRefusal(outcome: ResolveOutcome): { error: string; status: number } | null {
    switch (outcome.kind) {
        case 'not_found': return { error: 'tool_call_id does not match an open tool call of this conversation', status: 404 };
        case 'not_pending': return { error: 'this tool call was already answered or is no longer open', status: 409 };
        case 'expired': return { error: 'this tool call has expired', status: 410 };
        case 'forbidden': return { error: outcome.message, status: 403 };
        case 'unavailable': return { error: 'Authorization is temporarily unavailable', status: 503 };
        case 'invalid': return { error: outcome.message, status: 400 };
        case 'busy': return { error: 'another run is active for this conversation', status: 409 };
        case 'agent_inactive': return { error: 'Agent is not active', status: 400 };
        case 'queued': return { error: 'unexpected background continuation', status: 500 };
        default: return null;
    }
}

export type AgentCompletionResult =
    | { error: string; status: number; code?: string; type?: string; extra?: Record<string, unknown>; retryAfterSeconds?: number }
    /** The wait window ended with the run still going: it continues (202, follow it on the runs API). */
    | { accepted: IAgentRun; conversationId: string }
    | {
        content: string;
        conversationId: string;
        usage?: AgentCompletionUsage;
        stopReason?: AgentChatResponse['stop_reason'];
        stopDetail?: string;
        /** Client tools the agent is waiting on (reply with `tool` messages, `tool_call_id` = `id`). */
        toolCalls?: ChatToolCall[];
        /** The agent's thinking text (already empty when the agent hides it). */
        reasoning?: string;
        /** Files the agent produced this turn (sandbox /outputs), as `output_files`. */
        outputFiles?: ClientOutputFile[];
        /** The open approvals / questions of a paused turn (`required_action` of the Responses API). */
        requiredAction?: { type: 'agent_actions'; actions: ClientPendingAction[] };
        /** The run this turn was (a tool answer continues the paused run's session and has none of its own). */
        runId?: string;
    };

function toCompletionUsage(usage: AgentChatResponse['usage'] | undefined): { usage?: AgentCompletionUsage } {
    // The Responses API names these input/output; chat/completions
    // names them prompt/completion. Same numbers, different contract.
    return usage
        ? { usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens } }
        : {};
}

export async function runAgentCompletion(input: RunAgentCompletionInput): Promise<AgentCompletionResult> {
    // The transcript ends in `tool` messages: the answers to the client tool calls the last reply asked for.
    const toolAnswers = extractToolAnswers(input.messages);
    if (toolAnswers.length > 0) return answerToolCalls(input, toolAnswers);

    let userMessage: string;
    let session: { conversationId: string; created?: boolean; attachments?: string[]; namedAttachments?: string[] };
    if (input.turn) {
        userMessage = input.turn.userMessage;
        session = input.turn.session;
    } else {
        // A request that carries `variables` may have no message at all: the Variables block is the turn.
        const text = extractLastUserMessage(input.messages) ?? (input.variables ? '' : null);
        if (text === null || (!text && !input.variables)) {
            return { error: 'messages must contain at least one user message', status: 400 };
        }
        userMessage = text;
        const conversation = await resolveConversation(input.conversationId, input.agent, input.ctx, 'api');
        if ('error' in conversation) return { error: conversation.error, status: 404 };
        session = conversation;
        // A queued or later turn of this session reads the choice from it.
        if (input.modelChoice) await rememberSessionModel(input.ctx.tenantDbName, conversation.conversationId, input.modelChoice);
    }

    const streaming = Boolean(input.onTextChunk);
    const limits = input.limits ?? await resolveAgentRunLimits();
    const deferred = input.runClass === 'deferred';
    const outcome = await startRunOnSession({
        tenantDbName: input.ctx.tenantDbName,
        tenantId: input.ctx.tenantId,
        projectId: input.ctx.projectId,
        agentKey: input.agent.key,
        conversationId: session.conversationId,
        userMessage,
        ...(session.attachments?.length ? { attachments: session.attachments, idempotencyAttachments: session.namedAttachments } : {}),
        userId: input.ctx.userId,
        ...(input.apiTokenId ? { apiTokenId: input.apiTokenId, actorType: 'api_token' as const } : {}),
        // API traffic runs the published version, exactly as /responses does:
        // a draft saved mid-afternoon must not become what callers get (unless it asks for `"draft"`).
        usePublished: input.usePublished !== false,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
        ...(input.modelChoice ? { modelKey: input.modelChoice.modelKey } : {}),
        ...(input.requestReasoning ? { requestReasoning: input.requestReasoning } : {}),
        ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
        ...(input.variables ? { variables: input.variables } : {}),
        ...(input.runClass ? { runClass: input.runClass } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey, idempotencyConversationScope: input.idempotencyConversationScope ?? null } : {}),
        // The chat-completions wire has no way to answer an approval: a gated
        // tool follows the agent's `humanInTheLoop.unattended` setting (deny by
        // default; `pause` leaves the session waiting in the dashboard).
        unattended: true,
        // It does have a way to run a tool: the agent's client tools come back as `tool_calls`.
        answersClientTools: true,
        channel: 'chat_completions',
        trigger: 'request',
        // A deferred run has no turn to stream or cancel: it waits in its own queue, and the call waits on it below.
        execution: deferred
            ? { kind: 'queued' }
            : {
                kind: 'inline',
                waitMs: limits.syncWaitMs,
                ...(streaming
                    ? { stream: { onTextChunk: input.onTextChunk, ...(input.onReasoningChunk ? { onReasoningChunk: input.onReasoningChunk } : {}) } }
                    : {}),
                ...(input.signal ? { signal: input.signal } : {}),
                // A stream that loses its reader stops (OpenAI semantics); a plain call's run carries on.
                cancelOnDisconnect: streaming,
            },
        limits,
    }, { tenantDbName: input.ctx.tenantDbName, conversationId: session.conversationId, created: session.created === true });

    switch (outcome.kind) {
        case 'completed':
            return { ...completionFrom(outcome.response, session.conversationId), runId: String(outcome.run._id) };
        case 'detached':
            return { accepted: outcome.run, conversationId: session.conversationId };
        case 'accepted':
        case 'replay': {
            // A queued run waits up to the window, as the other dialects do (an inline retry was waited on already).
            const settled = deferred && isAgentRunActive(outcome.run) && outcome.run.status !== 'scheduled'
                ? (await waitForAgentRun({ tenantDbName: input.ctx.tenantDbName, tenantId: input.ctx.tenantId, projectId: input.ctx.projectId, runId: String(outcome.run._id) }, limits.syncWaitMs, input.waitSignal)) ?? outcome.run
                : outcome.run;
            return completionOfRun(settled, session.conversationId);
        }
        case 'conflict':
            return { error: 'An active run (queued or running) already exists for this conversation.', status: 409, type: 'agent_run_conflict', code: 'agent_run_conflict' };
        case 'idempotency_conflict':
            return { error: 'This Idempotency-Key was already used with a different request.', status: 409, type: 'idempotency_key_conflict', code: 'idempotency_key_conflict' };
        case 'concurrency_limit': {
            const body = agentRunConcurrencyLimitErrorBody(outcome.limit, outcome.scope, outcome.runClass).error;
            return {
                error: body.message, status: 429, code: body.code, type: 'rate_limit_error',
                extra: { class: outcome.runClass, scope: outcome.scope, limit: outcome.limit }, retryAfterSeconds: CONCURRENCY_RETRY_AFTER_SECONDS,
            };
        }
        default:
            return { error: 'the agent run could not be started', status: 500 };
    }
}

/** A run as the completion it ended in: its answer, still going (202), or why it has none. */
export function completionOfRun(run: IAgentRun, conversationId: string): AgentCompletionResult {
    if (isAgentRunActive(run)) return { accepted: run, conversationId };
    if (run.status === 'failed') {
        return { error: run.errorMessage ?? 'The agent run failed.', status: 500, type: 'server_error', ...(run.errorReason ? { code: run.errorReason } : {}) };
    }
    if (!run.result) {
        return { error: 'The agent run was cancelled.', status: 409, type: 'agent_run_cancelled', code: 'agent_run_cancelled' };
    }
    return { ...completionFrom(run.result as unknown as AgentChatResponse, conversationId), runId: String(run._id) };
}

/** A Responses-shaped agent result as a chat completion: the answer, or the client tools it is waiting on. */
export function completionFrom(result: AgentChatResponse, conversationId: string): AgentCompletionResult {
    const toolCalls = toChatToolCalls(result.required_action?.actions);
    const reasoning = extractAnswerReasoning(result);
    let content = result.output_parsed !== undefined && result.output_parsed !== null
        ? JSON.stringify(result.output_parsed)
        : extractAnswerText(result);
    // A pause on something this wire cannot answer says what waits, instead of an empty answer.
    const paused = result.stop_reason === 'requires_action' && toolCalls.length === 0 && (result.required_action?.actions.length ?? 0) > 0
        ? result.required_action
        : undefined;
    if (paused && !content.trim()) content = pausedMessage(paused.actions, conversationId);
    return {
        // A turn under a structured contract answers with the JSON of the parsed output.
        content,
        ...(paused ? { requiredAction: paused } : {}),
        ...(reasoning ? { reasoning } : {}),
        conversationId,
        ...(result.stop_reason ? { stopReason: result.stop_reason } : {}),
        ...(result.stop_detail ? { stopDetail: result.stop_detail } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(result.output_files?.length ? { outputFiles: result.output_files } : {}),
        ...toCompletionUsage(result.usage),
    };
}

/**
 * Answers the client tool calls of the last reply and lets the turn go on. Each
 * `tool` message is the same thing as `POST .../actions/{id}` on the sessions
 * API (same authorization, same audit), so the two ways of answering cannot
 * drift apart. The turn continues once the last open call is answered; the
 * reply is then the final text, or the next `tool_calls`.
 */
async function answerToolCalls(input: RunAgentCompletionInput, answers: ToolAnswer[]): Promise<AgentCompletionResult> {
    if (!input.conversationId) {
        return { error: 'conversation_id is required to answer a tool call: send the one the reply carried', status: 400 };
    }
    if (!input.answer) return { error: 'tool messages are not accepted here', status: 400 };
    const conversation = await resolveConversation(input.conversationId, input.agent, input.ctx, 'api');
    if ('error' in conversation) return { error: conversation.error, status: 404 };

    let last: ResolveOutcome | undefined;
    for (const answer of answers) {
        last = await resolveAgentPendingAction({
            tenantDbName: input.ctx.tenantDbName,
            tenantId: input.ctx.tenantId,
            projectId: input.ctx.projectId,
            conversationId: conversation.conversationId,
            actionId: answer.callId,
            agentKey: input.agent.key,
            body: answer.body,
            actor: input.answer.actor,
            authorize: input.answer.authorize,
            mode: 'sync',
            requireActiveAgent: true,
            // This caller cannot answer an approval, but it runs the agent's client tools on the continuation too.
            unattended: true,
            answersClientTools: true,
            ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
            ...(input.onTextChunk
                ? { stream: { onTextChunk: input.onTextChunk, ...(input.onReasoningChunk ? { onReasoningChunk: input.onReasoningChunk } : {}) } }
                : {}),
            ...(input.answer.audit ? { audit: input.answer.audit } : {}),
        });
        const refusal = answerRefusal(last);
        if (refusal) return refusal;
    }

    if (last?.kind === 'resumed') return completionFrom(last.response, conversation.conversationId);
    if (last?.kind === 'pending') {
        // Other calls of the same reply are still open: ask for the rest.
        return {
            content: '',
            conversationId: conversation.conversationId,
            toolCalls: toChatToolCalls(last.pendingActions.map(toClientPendingAction)),
            stopReason: 'requires_action',
        };
    }
    return { error: 'the tool call could not be answered', status: 500 };
}

/**
 * The assistant's text out of a Responses-shaped result.
 *
 * Reasoning items are skipped rather than concatenated: a chat-completion's
 * `content` is the answer, and pasting a model's thinking in front of it
 * would change what every existing OpenAI client displays.
 */
export function extractAnswerText(result: AgentChatResponse): string {
    return (result.output ?? [])
        .filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .map((part) => (typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : ''))
        .join('')
        .trim();
}

/**
 * The thinking text of a Responses-shaped result (its `reasoning` items), for
 * `reasoning_content`. The agent's `showReasoning: false` already left the
 * item out, so there is nothing to apply again here.
 */
export function extractAnswerReasoning(result: AgentChatResponse): string {
    return (result.output ?? [])
        .filter((item): item is Extract<typeof item, { type: 'reasoning' }> => item.type === 'reasoning')
        .flatMap((item) => item.summary ?? [])
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('\n\n')
        .trim();
}
