/**
 * Records every model call an agent makes, the way the gateway records its own.
 *
 * Model Hub showed no statistics for an agent's model — only for the
 * embedding model beside it. The cause: an agent builds a LangChain chat model
 * straight from the provider runtime and calls the provider directly, so its
 * calls never pass through the inference gateway, which is the only place
 * `logModelUsage` was ever called for chat. Embeddings (knowledge search,
 * memory) DO go through the gateway's service layer, so they were the only
 * rows that ever appeared. Every agent turn — however many model calls — was
 * invisible to the model's usage, cost and latency, and to the tenant's bill.
 *
 * The tap wraps the SDK-facing model and logs one usage row per model CALL
 * (not per turn: one turn can make many calls, and a sub-agent's calls belong
 * to ITS model, which gets its own tap at its own construction site). It is
 * fire-and-forget: a failed usage write must never fail the agent's answer.
 */

import { createLogger } from '@/lib/core/logger';
import type { IModel } from '@/lib/database';
import { logModelUsage, type TokenUsage } from '@/lib/services/models/usageLogger';

const logger = createLogger('agent-model-usage');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
interface TappableModel {
    invoke?: AnyFn;
    stream?: AnyFn;
    bindTools?: AnyFn;
}

export interface ModelUsageTapContext {
    tenantDbName: string;
    model: IModel;
    /** The usage row's `route` — tells an agent call apart from a gateway call. */
    route: string;
    agentKey?: string;
}

/**
 * Token usage out of a LangChain message or an SDK-shaped response. Providers
 * put it in different places: LangChain's `usage_metadata`, an OpenAI-shaped
 * `usage`, or `response_metadata.tokenUsage` / `token_usage`. Exported for tests.
 */
export function extractTokenUsage(message: unknown): TokenUsage | undefined {
    if (!message || typeof message !== 'object') return undefined;
    const m = message as Record<string, unknown>;
    const meta = (m.response_metadata ?? {}) as Record<string, unknown>;
    const candidates = [m.usage_metadata, m.usage, meta.tokenUsage, meta.token_usage, meta.usage];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const u = candidate as Record<string, unknown>;
        const num = (...keys: string[]) => {
            for (const key of keys) {
                const value = u[key];
                if (typeof value === 'number' && Number.isFinite(value)) return value;
            }
            return undefined;
        };
        const inputTokens = num('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
        const outputTokens = num('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
        if (inputTokens === undefined && outputTokens === undefined) continue;

        const inputDetails = (u.input_token_details ?? u.prompt_tokens_details ?? {}) as Record<string, unknown>;
        const outputDetails = (u.output_token_details ?? u.completion_tokens_details ?? {}) as Record<string, unknown>;
        const cached = [inputDetails.cache_read, inputDetails.cached_tokens]
            .find((v): v is number => typeof v === 'number');
        const reasoning = [outputDetails.reasoning, outputDetails.reasoning_tokens]
            .find((v): v is number => typeof v === 'number');

        return {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            totalTokens: num('total_tokens', 'totalTokens') ?? (inputTokens ?? 0) + (outputTokens ?? 0),
            ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
            ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
        };
    }
    return undefined;
}

function countToolCalls(message: unknown): number | undefined {
    const calls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls;
    return Array.isArray(calls) && calls.length > 0 ? calls.length : undefined;
}

function finishReasonOf(message: unknown): string | undefined {
    const meta = (message as { response_metadata?: Record<string, unknown> } | undefined)?.response_metadata;
    const value = meta?.finish_reason ?? meta?.stop_reason;
    return typeof value === 'string' ? value : undefined;
}

function record(
    ctx: ModelUsageTapContext,
    outcome: { status: 'success' | 'error' | 'cancelled'; message?: unknown; error?: unknown; startedAt: number; streamed: boolean },
) {
    const usage = extractTokenUsage(outcome.message) ?? {};
    const toolCalls = countToolCalls(outcome.message);
    void logModelUsage(ctx.tenantDbName, ctx.model, {
        requestId: `agent-${ctx.agentKey ?? 'run'}-${outcome.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        route: ctx.route,
        status: outcome.status,
        // Deliberately not the prompt: an agent's context is the whole
        // conversation plus tool results, and the trace already holds it.
        // Duplicating it into every usage row would multiply storage for no
        // reader.
        providerRequest: { model: ctx.model.key, stream: outcome.streamed, agentKey: ctx.agentKey },
        providerResponse: toolCalls ? { toolCalls } : {},
        ...(outcome.error
            ? { errorMessage: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }
            : {}),
        latencyMs: Date.now() - outcome.startedAt,
        usage: { ...usage, ...(toolCalls ? { toolCalls } : {}) },
        ...(finishReasonOf(outcome.message) ? { finishReason: finishReasonOf(outcome.message) } : {}),
    }).catch((error: unknown) => {
        logger.warn('Agent model usage could not be recorded', {
            model: ctx.model.key,
            error: error instanceof Error ? error.message : String(error),
        });
    });
}

export function withModelUsageLogging<T extends object>(input: T, ctx: ModelUsageTapContext): T {
    const model = input as T & TappableModel;
    if (!model || typeof model !== 'object') return input;
    const wrapped = { ...model } as TappableModel & Record<string, unknown>;

    if (typeof model.bindTools === 'function') {
        const bindTools = model.bindTools.bind(model);
        // Tools are bound per call, and the bound model is the one that runs.
        wrapped.bindTools = (tools: unknown, options?: unknown) =>
            withModelUsageLogging(bindTools(tools, options) as object, ctx);
    }

    if (typeof model.invoke === 'function') {
        const invoke = model.invoke.bind(model);
        wrapped.invoke = async (...args: unknown[]) => {
            const startedAt = Date.now();
            try {
                const response = await invoke(...args);
                record(ctx, { status: 'success', message: response, startedAt, streamed: false });
                return response;
            } catch (error) {
                record(ctx, { status: 'error', error, startedAt, streamed: false });
                throw error;
            }
        };
    }

    if (typeof model.stream === 'function') {
        const stream = model.stream.bind(model);
        wrapped.stream = async function* tapped(...args: unknown[]) {
            const startedAt = Date.now();
            // The usage rides on the LAST usage-bearing chunk (for a wrapped
            // stream, the assembled message withAssembledStream yields).
            let lastWithUsage: unknown;
            let finished = false;
            try {
                for await (const chunk of stream(...args) as AsyncIterable<unknown>) {
                    if (extractTokenUsage(chunk)) lastWithUsage = chunk;
                    yield chunk;
                }
                finished = true;
                record(ctx, { status: 'success', message: lastWithUsage, startedAt, streamed: true });
            } catch (error) {
                finished = true;
                record(ctx, { status: 'error', error, message: lastWithUsage, startedAt, streamed: true });
                throw error;
            } finally {
                // The consumer stopped early (cancellation): still billed for
                // what the provider generated, but neither a success nor a fault.
                if (!finished) record(ctx, { status: 'cancelled', message: lastWithUsage, startedAt, streamed: true });
            }
        };
    }

    return wrapped as unknown as T;
}
