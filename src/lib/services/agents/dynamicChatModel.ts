/**
 * A chat model for an agent whose model is a Dynamic LLM.
 *
 * A Dynamic LLM owns no provider: it picks a concrete child per request (rules, decider, pools,
 * guards, shadow). An agent normally builds its LangChain model straight from the provider
 * runtime, so for a Dynamic LLM there was nothing to build and no rule ever ran. This model
 * instead sends each model CALL through `handleChatCompletion` — the same resolution the
 * gateway uses — so rules (incl. caller conditions, read from the run's `runWithRoutingCaller`
 * scope), the decider, pools, guards and shadow mode all apply and the usage rows carry the
 * routing reason. Each turn / step routes on its own; stickiness is whatever the engine has.
 *
 * It speaks the duck-typed LangChain surface `fromLangchainModel` adapts (`invoke`, `stream`,
 * `bindTools`), so the usual wrappers (assembled stream, usage tap) sit on top unchanged. The
 * gateway logs the usage itself, so the tap is told not to (`isDynamicModel`), and the child's
 * cost rides on the message (`response_metadata.routedCost`) for the spend settler.
 */

import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { IModel } from '@/lib/database';
import { getDynamicRoutingConfig } from '@/lib/services/models/dynamicRouting';
import { calculateCost, type TokenUsage } from '@/lib/services/models/usageLogger';

export function isDynamicModel(model: IModel | undefined): boolean {
    return Boolean(model && getDynamicRoutingConfig(model));
}

export const DYNAMIC_MODEL_MARK = '__dynamicRouted';

export interface DynamicChatModelDeps {
    tenantDbName: string;
    tenantId?: string;
    projectId: string;
    /** The Dynamic LLM's key. */
    modelKey: string;
    /** temperature / top_p / max_tokens from the agent config, in gateway body names. */
    overrides?: Record<string, unknown>;
}

interface BoundOptions {
    tools?: unknown[];
    tool_choice?: unknown;
    response_format?: unknown;
}

type AnyRecord = Record<string, unknown>;

const ROLE_BY_TYPE: Record<string, string> = { human: 'user', ai: 'assistant', system: 'system', tool: 'tool', generic: 'user' };

function roleOf(message: AnyRecord): string {
    if (typeof message.role === 'string') return message.role;
    const type = typeof message._getType === 'function' ? (message._getType as () => string)() : undefined;
    return (type && ROLE_BY_TYPE[type]) || 'user';
}

function toOpenAiToolCall(call: AnyRecord) {
    if (call.function && typeof call.function === 'object') return call;
    const args = call.args ?? {};
    return {
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    };
}

/** LangChain messages or SDK-shaped plain messages, as OpenAI chat messages. Exported for tests. */
export function toOpenAiMessages(input: unknown): AnyRecord[] {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    const list = Array.isArray(input) ? input : [input];
    return list.map((raw) => {
        const m = (raw ?? {}) as AnyRecord;
        const role = roleOf(m);
        const out: AnyRecord = { role, content: m.content ?? '' };
        if (m.name) out.name = m.name;
        if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            out.tool_calls = (m.tool_calls as AnyRecord[]).map(toOpenAiToolCall);
        }
        if (role === 'tool' && m.tool_call_id) out.tool_call_id = m.tool_call_id;
        return out;
    });
}

function usageMetadataOf(usage: AnyRecord | undefined) {
    if (!usage) return undefined;
    const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    const cached = (usage.prompt_tokens_details as AnyRecord | undefined)?.cached_tokens;
    const reasoning = (usage.completion_tokens_details as AnyRecord | undefined)?.reasoning_tokens;
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: Number(usage.total_tokens ?? input + output),
        ...(typeof cached === 'number' ? { input_token_details: { cache_read: cached } } : {}),
        ...(typeof reasoning === 'number' ? { output_token_details: { reasoning } } : {}),
    };
}

function parseArgs(raw: unknown): AnyRecord {
    if (raw && typeof raw === 'object') return raw as AnyRecord;
    if (typeof raw !== 'string' || raw.trim() === '') return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as AnyRecord) : {};
    } catch {
        return {};
    }
}

class DynamicRoutedChatModel {
    readonly modelName: string;
    readonly [DYNAMIC_MODEL_MARK] = true;

    constructor(
        private readonly deps: DynamicChatModelDeps,
        private readonly bound: BoundOptions = {},
    ) {
        this.modelName = deps.modelKey;
    }

    bindTools(tools: unknown[], options?: AnyRecord) {
        const converted = (tools ?? []).map((tool) => {
            const t = tool as AnyRecord;
            return t && t.type === 'function' && t.function ? tool : convertToOpenAITool(tool as never);
        });
        return new DynamicRoutedChatModel(this.deps, {
            ...this.bound,
            tools: converted,
            ...(options?.tool_choice !== undefined ? { tool_choice: options.tool_choice } : {}),
        });
    }

    private body(messages: unknown, options: AnyRecord | undefined, stream: boolean): AnyRecord {
        const responseFormat = options?.response_format ?? this.bound.response_format;
        const tools = (options?.tools as unknown[] | undefined) ?? this.bound.tools;
        const toolChoice = options?.tool_choice ?? this.bound.tool_choice;
        return {
            ...(this.deps.overrides ?? {}),
            messages: toOpenAiMessages(messages),
            ...(tools && tools.length > 0 ? { tools, ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}) } : {}),
            ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
            ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        };
    }

    private async call(messages: unknown, options: AnyRecord | undefined, stream: boolean) {
        const { handleChatCompletion } = await import('@/lib/services/models/inferenceService');
        return handleChatCompletion({
            tenantDbName: this.deps.tenantDbName,
            tenantId: this.deps.tenantId,
            modelKey: this.deps.modelKey,
            projectId: this.deps.projectId,
            body: this.body(messages, options, stream),
            stream,
        });
    }

    private async routedFacts(routedKey: string | undefined, usage: TokenUsage | undefined) {
        const facts: AnyRecord = { routedBy: this.deps.modelKey };
        if (!routedKey) return facts;
        facts.routedModel = routedKey;
        if (usage && (usage.inputTokens || usage.outputTokens)) {
            try {
                const { getModelByKey } = await import('@/lib/services/models/modelService');
                const child = await getModelByKey(this.deps.tenantDbName, routedKey, this.deps.projectId);
                if (child?.pricing) facts.routedCost = calculateCost(child.pricing, usage);
            } catch {
                /* cost attribution is best-effort */
            }
        }
        return facts;
    }

    async invoke(messages: unknown, options?: AnyRecord) {
        const outcome = await this.call(messages, options, false);
        const response = (outcome.response ?? {}) as AnyRecord;
        const choice = ((response.choices as AnyRecord[] | undefined) ?? [])[0] ?? {};
        const message = (choice.message ?? {}) as AnyRecord;
        const toolCalls = ((message.tool_calls as AnyRecord[] | undefined) ?? []).map((call) => {
            const fn = (call.function ?? {}) as AnyRecord;
            return { id: String(call.id ?? ''), name: String(fn.name ?? ''), args: parseArgs(fn.arguments), type: 'tool_call' as const };
        });
        const usageMetadata = usageMetadataOf(response.usage as AnyRecord | undefined);
        const facts = await this.routedFacts(
            outcome.routing?.chosenModelKey,
            outcome.usage ?? (usageMetadata
                ? { inputTokens: usageMetadata.input_tokens, outputTokens: usageMetadata.output_tokens, totalTokens: usageMetadata.total_tokens }
                : undefined),
        );
        return new AIMessage({
            content: (message.content as string | undefined) ?? '',
            tool_calls: toolCalls,
            ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
            ...(typeof message.reasoning_content === 'string' ? { additional_kwargs: { reasoning_content: message.reasoning_content } } : {}),
            response_metadata: { finish_reason: choice.finish_reason, model_name: response.model as string | undefined, ...facts },
        });
    }

    async *stream(messages: unknown, options?: AnyRecord) {
        const outcome = await this.call(messages, options, true);
        if (!outcome.stream) throw new Error('Dynamic routing returned no stream');
        const reader = outcome.stream.getReader();
        const signal = options?.signal as AbortSignal | undefined;
        const onAbort = () => void reader.cancel().catch(() => undefined);
        signal?.addEventListener('abort', onAbort, { once: true });
        const decoder = new TextDecoder();
        let buffer = '';
        let finish: string | undefined;
        let usage: AnyRecord | undefined;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let cut: number;
                while ((cut = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, cut);
                    buffer = buffer.slice(cut + 2);
                    const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
                    if (!data || data === '[DONE]') continue;
                    let json: AnyRecord;
                    try {
                        json = JSON.parse(data) as AnyRecord;
                    } catch {
                        continue;
                    }
                    if (json.error) {
                        const err = json.error as AnyRecord;
                        throw new Error(String(err.message ?? 'Dynamic routing stream failed'));
                    }
                    if (json.usage) usage = json.usage as AnyRecord;
                    const choice = ((json.choices as AnyRecord[] | undefined) ?? [])[0];
                    if (!choice) continue;
                    if (choice.finish_reason) finish = String(choice.finish_reason);
                    const delta = (choice.delta ?? {}) as AnyRecord;
                    const toolChunks = ((delta.tool_calls as AnyRecord[] | undefined) ?? []).map((call) => {
                        const fn = (call.function ?? {}) as AnyRecord;
                        return {
                            index: typeof call.index === 'number' ? call.index : 0,
                            id: call.id as string | undefined,
                            name: fn.name as string | undefined,
                            args: (fn.arguments as string | undefined) ?? '',
                            type: 'tool_call_chunk' as const,
                        };
                    });
                    const text = typeof delta.content === 'string' ? delta.content : '';
                    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
                    if (!text && !reasoning && toolChunks.length === 0) continue;
                    yield new AIMessageChunk({
                        content: text,
                        tool_call_chunks: toolChunks,
                        ...(reasoning ? { additional_kwargs: { reasoning_content: reasoning } } : {}),
                    });
                }
            }
        } finally {
            signal?.removeEventListener('abort', onAbort);
            await reader.cancel().catch(() => undefined);
        }
        const usageMetadata = usageMetadataOf(usage);
        const tokenUsage: TokenUsage | undefined = usageMetadata
            ? { inputTokens: usageMetadata.input_tokens, outputTokens: usageMetadata.output_tokens, totalTokens: usageMetadata.total_tokens }
            : undefined;
        const facts = await this.routedFacts(outcome.routing?.chosenModelKey, tokenUsage);
        yield new AIMessageChunk({
            content: '',
            ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
            response_metadata: { ...(finish ? { finish_reason: finish } : {}), ...facts },
        });
    }
}

export function createDynamicChatModel(deps: DynamicChatModelDeps) {
    return new DynamicRoutedChatModel(deps);
}
