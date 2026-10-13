/**
 * A chat model for an agent whose model is a Dynamic LLM.
 *
 * A Dynamic LLM owns no provider: it picks a concrete child per request (rules, decider, pools,
 * guards, shadow). An agent normally builds its native model straight from the provider record,
 * so for a Dynamic LLM there was nothing to build and no rule ever ran. This model instead sends
 * each model CALL through `handleChatCompletion` - the same resolution the gateway uses - so
 * rules (incl. caller conditions, read from the run's `runWithRoutingCaller` scope), the decider,
 * pools, guards and shadow mode all apply and the usage rows carry the routing reason. Each turn /
 * step routes on its own; stickiness is whatever the engine has.
 *
 * It is an agent-sdk native model like any other: an `OpenAICompatibleProvider` whose HTTP call is
 * replaced by the gateway. The SDK therefore does what it does for every provider - message and
 * tool conversion, the request's reasoning, stream assembly, the one documented usage shape - and
 * the reasoning an agent or caller asked for rides to the routed child as `reasoning_effort`.
 *
 * The gateway logs the usage itself, so the usage tap is told not to (`isDynamicModel`), and the
 * child's cost rides on the message (`response_metadata.routedCost`) for the spend settler.
 * Facts about the routing live on a provider instance made per call, so concurrent calls on one
 * model never see each other's.
 */

import type { BaseChatMessage, BaseChatModel, NativeModelOptions } from '@cognipeer/agent-sdk';
import type { IModel } from '@/lib/database';
import { getDynamicRoutingConfig } from '@/lib/services/models/dynamicRouting';
import { getModelByKey } from '@/lib/services/models/modelService';
import { AGENT_REASONING_OVERRIDE } from '@/lib/services/models/reasoning';
import { calculateCost, type TokenUsage } from '@/lib/services/models/usageLogger';
import type { NativeAgentReasoning } from './nativeAgentModel';

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
    /** The agent's / caller's reasoning, carried to whichever model the call is routed to. */
    reasoning?: NativeAgentReasoning;
    /**
     * `reasoning` is the AGENT's own pick (not just an API request's value): it then outranks the routed
     * model's Model Hub default, as it does on a model the agent calls directly.
     */
    reasoningFromAgent?: boolean;
}

type AnyRecord = Record<string, unknown>;

interface BoundTools {
    tools?: unknown[];
    options?: { strict?: boolean; [key: string]: unknown };
}

/** What one call learned about its routing. */
interface RouteFacts {
    routedKey?: string;
    usage?: TokenUsage;
}

/** Console token usage out of the SDK's single usage shape (`MessageUsage`). */
function tokenUsageOfMessage(message: AnyRecord): TokenUsage | undefined {
    const usage = message.usage as AnyRecord | undefined;
    if (!usage) return undefined;
    const input = Number(usage.prompt_tokens ?? 0);
    const output = Number(usage.completion_tokens ?? 0);
    if (!input && !output) return undefined;
    const cached = (usage.prompt_tokens_details as AnyRecord | undefined)?.cached_tokens;
    const reasoning = (usage.completion_tokens_details as AnyRecord | undefined)?.reasoning_tokens;
    return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: Number(usage.total_tokens ?? input + output),
        ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
        ...(typeof reasoning === 'number' && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    };
}

/** An SSE `data:` frame's error message, when the frame is one. */
function errorOfFrame(frame: string): string | undefined {
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
    if (!data || data === '[DONE]' || !data.includes('"error"')) return undefined;
    try {
        const json = JSON.parse(data) as AnyRecord;
        if (!json.error) return undefined;
        const error = json.error as AnyRecord;
        return String(error.message ?? 'Dynamic routing stream failed');
    } catch {
        return undefined;
    }
}

let providerClass: Promise<new (deps: DynamicChatModelDeps, facts: RouteFacts) => import('@cognipeer/agent-sdk').BaseProvider> | undefined;

/** The provider class, built once the SDK is loaded (the SDK is imported lazily everywhere in the console). */
function loadProviderClass() {
    providerClass ??= import('@cognipeer/agent-sdk').then((sdk) => {
        class DynamicRoutedProvider extends sdk.OpenAICompatibleProvider {
            constructor(private readonly deps: DynamicChatModelDeps, private readonly facts: RouteFacts) {
                // Never used for an HTTP call: `doFetch` below is the gateway.
                super({ provider: 'openai-compatible', apiKey: 'dynamic-routing', baseURL: 'http://dynamic.invalid/v1', responsesApi: 'never' });
            }

            protected async doFetch(body: AnyRecord, signal?: AbortSignal): Promise<Response> {
                const stream = body.stream === true;
                // `model` is the Dynamic LLM's own key (the gateway resolves it) and `stream` is the call's mode.
                const { model: _model, stream: _stream, ...rest } = body;
                void _model; void _stream;
                const { handleChatCompletion } = await import('@/lib/services/models/inferenceService');
                const outcome = await handleChatCompletion({
                    tenantDbName: this.deps.tenantDbName,
                    tenantId: this.deps.tenantId,
                    modelKey: this.deps.modelKey,
                    projectId: this.deps.projectId,
                    body: {
                        ...(this.deps.overrides ?? {}),
                        ...rest,
                        messages: rest.messages as unknown[],
                        ...(this.deps.reasoningFromAgent && this.deps.reasoning ? { [AGENT_REASONING_OVERRIDE]: this.deps.reasoning } : {}),
                    },
                    stream,
                });
                this.facts.routedKey = outcome.routing?.chosenModelKey;
                this.facts.usage = outcome.usage;
                if (!stream) {
                    return new Response(JSON.stringify(outcome.response ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
                }
                if (!outcome.stream) throw new sdk.ProviderError('Dynamic routing returned no stream', 'openai-compatible');
                return new Response(failOnErrorFrames(outcome.stream, signal), { status: 200, headers: { 'content-type': 'text/event-stream' } });
            }
        }

        /** The gateway reports a mid-stream failure as an `error` frame; the SDK parser would skip it. */
        function failOnErrorFrames(source: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
            const reader = source.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            signal?.addEventListener('abort', () => void reader.cancel().catch(() => undefined), { once: true });
            return new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            return;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        let cut: number;
                        while ((cut = buffer.indexOf('\n\n')) >= 0) {
                            const failure = errorOfFrame(buffer.slice(0, cut));
                            buffer = buffer.slice(cut + 2);
                            if (failure) {
                                await reader.cancel().catch(() => undefined);
                                controller.error(new sdk.ProviderError(failure, 'openai-compatible'));
                                return;
                            }
                        }
                        controller.enqueue(value);
                    } catch (error) {
                        controller.error(error);
                    }
                },
                cancel: (reason) => reader.cancel(reason),
            });
        }

        return DynamicRoutedProvider as unknown as new (deps: DynamicChatModelDeps, facts: RouteFacts) => import('@cognipeer/agent-sdk').BaseProvider;
    });
    return providerClass;
}

class DynamicRoutedChatModel {
    readonly modelName: string;
    readonly [DYNAMIC_MODEL_MARK] = true;
    readonly capabilities = { structuredOutput: 'native', strictToolCalling: false, streaming: true, provider: 'openai-compatible' };

    constructor(
        private readonly deps: DynamicChatModelDeps,
        private readonly bound: BoundTools = {},
    ) {
        this.modelName = deps.modelKey;
    }

    bindTools(tools: unknown[], options?: BoundTools['options']) {
        return new DynamicRoutedChatModel(this.deps, { tools, options });
    }

    /** One call's adapter + the facts its provider will fill in. */
    private async open() {
        const sdk = await import('@cognipeer/agent-sdk');
        const Provider = await loadProviderClass();
        const facts: RouteFacts = {};
        const nativeOptions: NativeModelOptions = {
            model: this.deps.modelKey,
            ...(this.deps.reasoning ? { reasoning: this.deps.reasoning as NonNullable<NativeModelOptions['reasoning']> } : {}),
        };
        let adapted: BaseChatModel = sdk.fromNativeProvider(new Provider(this.deps, facts), nativeOptions);
        if (this.bound.tools && this.bound.tools.length > 0 && adapted.bindTools) {
            adapted = adapted.bindTools(this.bound.tools, this.bound.options);
        }
        return { adapted, facts };
    }

    /** The routed model and what it cost, on the message the agent loop and the usage tap read. */
    private async withRouteFacts(message: BaseChatMessage, facts: RouteFacts): Promise<BaseChatMessage> {
        const routing: AnyRecord = { routedBy: this.deps.modelKey };
        if (facts.routedKey) {
            routing.routedModel = facts.routedKey;
            const usage = facts.usage ?? tokenUsageOfMessage(message as AnyRecord);
            if (usage && (usage.inputTokens || usage.outputTokens)) {
                try {
                    const child = await getModelByKey(this.deps.tenantDbName, facts.routedKey, this.deps.projectId);
                    if (child?.pricing) routing.routedCost = calculateCost(child.pricing, usage);
                } catch {
                    /* cost attribution is best-effort */
                }
            }
        }
        return { ...message, response_metadata: { ...(message.response_metadata ?? {}), ...routing } };
    }

    async invoke(messages: BaseChatMessage[], options?: AnyRecord): Promise<BaseChatMessage> {
        const { adapted, facts } = await this.open();
        const message = await adapted.invoke(messages, options);
        return this.withRouteFacts(message, facts);
    }

    async *stream(messages: BaseChatMessage[], options?: AnyRecord) {
        const { adapted, facts } = await this.open();
        if (!adapted.stream) throw new Error('Dynamic routing returned no stream');
        for await (const chunk of adapted.stream(messages, options)) {
            // The assembled message is the one with a role; everything before it is text / reasoning deltas.
            if (chunk && typeof chunk === 'object' && 'role' in chunk && (chunk as BaseChatMessage).role) {
                yield await this.withRouteFacts(chunk as BaseChatMessage, facts);
            } else {
                yield chunk;
            }
        }
    }
}

export function createDynamicChatModel(deps: DynamicChatModelDeps) {
    return new DynamicRoutedChatModel(deps);
}
