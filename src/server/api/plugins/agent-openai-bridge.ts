import { executeAgentChatExclusive } from '@/lib/services/agents/agentRunService';
/**
 * An agent, answered as an OpenAI chat completion.
 *
 * Every other agent surface needs a client that knows about this console:
 * `/responses` takes an agent key in `model` but an OpenAI-shaped `input`,
 * `/a2a` speaks A2A, the Assistants API speaks threads-and-runs. The one
 * thing missing was the shape every SDK in every language already speaks —
 * so an agent could be built here and then not be callable from the code a
 * team already has.
 *
 * This is deliberately a BRIDGE, not a second agent runtime: it translates
 * a chat-completions request into the same `executeAgentChat` the Responses
 * API calls, and translates the answer back. Nothing about how an agent runs
 * is decided here.
 *
 * Resolution order matters and is not negotiable: a model key wins. An agent
 * is only looked up when no model by that name exists, so no existing caller
 * can have its traffic re-routed by someone creating an agent whose key
 * collides with a model. `agent:<key>` is the explicit form that always means
 * an agent, for the case where a collision exists and the agent is wanted.
 */

import { createLogger } from '@/lib/core/logger';
import type { IAgent } from '@/lib/database';
import { createConversation, getAgentByKey, getConversationById } from '@/lib/services/agents';
import { executeAgentChat, type AgentChatResponse } from '@/lib/services/agents/agentService';

const logger = createLogger('api:agent-openai-bridge');

/** `agent:<key>` always means an agent; a bare name defers to models first. */
export const AGENT_MODEL_PREFIX = 'agent:';

export interface OpenAiMessage {
    role?: string;
    content?: unknown;
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
): Promise<{ conversationId: string } | { error: string }> {
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
        { source: 'api' },
    );
    return { conversationId: String(created._id) };
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
    return stopReason === 'limit' ? 'length' : 'stop';
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
}) {
    return {
        id: input.id,
        object: 'chat.completion' as const,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [{
            index: 0,
            message: { role: 'assistant' as const, content: input.content },
            finish_reason: agentFinishReason(input.stopReason),
        }],
        ...(input.usage ? { usage: input.usage } : {}),
        // Not OpenAI fields either: why a run ended without a final answer.
        ...(input.stopReason && input.stopReason !== 'completed'
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
    delta?: string;
    finish?: boolean;
    stopReason?: AgentChatResponse['stop_reason'];
}) {
    return {
        id: input.id,
        object: 'chat.completion.chunk' as const,
        created: Math.floor(Date.now() / 1000),
        model: input.model,
        choices: [{
            index: 0,
            delta: input.finish ? {} : { content: input.delta ?? '' },
            finish_reason: input.finish ? agentFinishReason(input.stopReason) : null,
        }],
    };
}

export interface RunAgentCompletionInput {
    agent: IAgent;
    model: string;
    messages: OpenAiMessage[] | undefined;
    conversationId?: string;
    version?: number;
    runtimeContext?: Parameters<typeof executeAgentChat>[0]['runtimeContext'];
    ctx: AgentCompletionContext;
    /** Present for the streaming form; the deltas go here as they arrive. */
    onTextChunk?: (text: string) => void;
}

export async function runAgentCompletion(input: RunAgentCompletionInput): Promise<
    | { error: string; status: number }
    | {
        content: string;
        conversationId: string;
        usage?: AgentCompletionUsage;
        stopReason?: AgentChatResponse['stop_reason'];
        stopDetail?: string;
    }
> {
    const userMessage = extractLastUserMessage(input.messages);
    if (!userMessage) {
        return { error: 'messages must contain at least one user message', status: 400 };
    }

    const conversation = await resolveConversation(input.conversationId, input.agent, input.ctx);
    if ('error' in conversation) return { error: conversation.error, status: 404 };

    const result = await executeAgentChatExclusive({
        agentKey: input.agent.key,
        conversationId: conversation.conversationId,
        projectId: input.ctx.projectId,
        tenantDbName: input.ctx.tenantDbName,
        tenantId: input.ctx.tenantId,
        // API traffic runs the published version, exactly as /responses does:
        // a draft saved mid-afternoon must not become what callers get.
        usePublished: true,
        userId: input.ctx.userId,
        userMessage,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
        ...(input.onTextChunk ? { onTextChunk: input.onTextChunk } : {}),
    });

    return {
        content: extractAnswerText(result),
        conversationId: conversation.conversationId,
        ...(result.stop_reason ? { stopReason: result.stop_reason } : {}),
        ...(result.stop_detail ? { stopDetail: result.stop_detail } : {}),
        ...(result.usage ? {
            // The Responses API names these input/output; chat/completions
            // names them prompt/completion. Same numbers, different contract.
            usage: {
                prompt_tokens: result.usage.input_tokens,
                completion_tokens: result.usage.output_tokens,
                total_tokens: result.usage.total_tokens,
            },
        } : {}),
    };
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
