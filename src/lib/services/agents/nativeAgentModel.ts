/**
 * The chat model of an agent run, built from the Model Hub record with an
 * agent-sdk NATIVE provider - no LangChain model on the agent path.
 *
 * What stays where it was:
 *  - **Credentials and endpoints** come from the provider runtime
 *    (`buildModelRuntime` -> `loadProviderRuntimeData`), the same decrypted
 *    record the gateway uses. Each contract hands over a `NativeProviderSpec`
 *    from inside its own `createRuntime` closure, so no secret is read here.
 *  - **Per-model request settings** go through `resolveModelInvocationConfig`
 *    and the contracts' `resolveOverrides`, so the model record's
 *    `unsupportedParams` / `requestDefaults` / `extraBody` apply to an agent
 *    exactly as they do to a gateway call.
 *
 * What is new:
 *  - `fetch` is `safeFetch` (the SSRF guard, redirects re-validated), wrapped
 *    for inline-reasoning normalization where the upstream needs it.
 *  - Rules that depend on the request carrying tools (GPT-5: no
 *    `reasoning_effort` next to function tools, `none` forced) cannot be decided
 *    when the model is built - an agent binds its tools later - so they run in
 *    the adapter's `transformRequest` hook, which sees the finished request.
 */

import type { BaseChatModel, ChatCompletionRequest, NativeModelOptions } from '@cognipeer/agent-sdk';
import type { IModel } from '@/lib/database';
import { resolveUnsupportedParamNames } from '@/lib/providers/unsupportedParams';
import { ANTHROPIC_DEFAULT_MAX_TOKENS, resolveOverrides, type ModelSettingsOverrides } from '@/lib/providers/contracts/modelContracts';
import { withInlineReasoningNormalization } from '@/lib/providers/contracts/wireNormalization';
import { createInlineReasoningSplitter } from '@/lib/shared/inlineReasoning';
import { safeFetch } from '@/lib/security/outboundFetch';
import { resolveModelInvocationConfig } from '@/lib/services/models/inferenceService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';

/**
 * Time to the response HEADERS, per request. An open stream is never cut by it
 * (the SDK clears its timer once headers arrive; `safeFetch` does too). Long
 * enough for a reasoning model that thinks before it says anything.
 */
export const AGENT_MODEL_REQUEST_TIMEOUT_MS = 120_000;

/** `safeFetch` gets a little more, so the SDK's own timeout (a clean 408) fires first. */
const GUARD_TIMEOUT_MARGIN_MS = 5_000;

/** Drivers whose wire format is OpenAI Chat Completions. */
const OPENAI_SCHEMA_DRIVERS = new Set(['openai', 'openai-compatible', 'azure', 'together']);

/** The normalized reasoning value (`unset = send nothing`). */
export interface NativeAgentReasoning {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
    budgetTokens?: number;
    includeThoughts?: boolean;
}

export interface NativeAgentModelInput {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    model: IModel;
    /** Per-call settings in gateway names (`temperature`, `top_p`, `max_tokens`). */
    overrides?: Record<string, unknown>;
    /**
     * `.stream()` answers with ONE `invoke()`: the model sits behind an upstream
     * that cannot stream tool calls (`settings.disableStreamingWithTools`).
     */
    disableStreaming?: boolean;
    /** What the AGENT selected for this model. Wins over everything else; unset falls through. */
    reasoning?: NativeAgentReasoning;
    /**
     * What the API request asked for. Lowest rung: agent selection > Model Hub
     * default > this > nothing sent (agentReasoning.ts has the full rule).
     */
    requestReasoning?: NativeAgentReasoning;
    /** Transport override (tests). Defaults to the SSRF-guarded `safeFetch`. */
    fetch?: typeof fetch;
    timeoutMs?: number;
}

type AnyRecord = Record<string, unknown>;
type SdkReasoning = NonNullable<NativeModelOptions['reasoning']>;

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);

/** Any of the reasoning shapes in circulation (legacy `{effort, summary}` included), as the normalized value. */
export function normalizeNativeReasoning(value: unknown): NativeAgentReasoning | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as AnyRecord;
    const out: NativeAgentReasoning = {};
    if (typeof raw.effort === 'string' && EFFORTS.has(raw.effort)) out.effort = raw.effort as NativeAgentReasoning['effort'];
    if (typeof raw.budgetTokens === 'number' && Number.isFinite(raw.budgetTokens) && raw.budgetTokens > 0) out.budgetTokens = raw.budgetTokens;
    if (typeof raw.includeThoughts === 'boolean') out.includeThoughts = raw.includeThoughts;
    return Object.keys(out).length > 0 ? out : undefined;
}

/** The transport every native agent call goes through: the SSRF guard, time-to-headers bounded. */
export function guardedModelFetch(timeoutMs: number): typeof fetch {
    return (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return safeFetch(url, init, { timeoutMs: timeoutMs + GUARD_TIMEOUT_MARGIN_MS });
    };
}

/** Wire name -> the request field it lives in, for the parameters a tools-conditional rule may strip. */
const STRIPPABLE_FIELDS: Readonly<Record<string, keyof ChatCompletionRequest>> = {
    temperature: 'temperature',
    top_p: 'topP',
    presence_penalty: 'presencePenalty',
    frequency_penalty: 'frequencyPenalty',
    reasoning: 'reasoning',
    reasoning_effort: 'reasoning',
};

/**
 * The adapter's last-mile hook: the finished request (tools bound, reasoning
 * applied) is made legal for this model.
 */
function buildTransformRequest(input: {
    driver: string;
    modelId: string;
    settings: AnyRecord;
}): NonNullable<NativeModelOptions['transformRequest']> {
    const openAiSchema = OPENAI_SCHEMA_DRIVERS.has(input.driver);
    const resolve = (hasTools: boolean) => resolveUnsupportedParamNames({
        driver: input.driver,
        modelId: input.modelId,
        manual: input.settings.unsupportedParams,
        autoDetect: input.settings.autoDropUnsupportedParams,
        hasTools,
    });
    const plain = resolve(false);
    const withTools = resolve(true);

    return (request: ChatCompletionRequest) => {
        const hasTools = Boolean(request.tools?.length);
        const rule = hasTools ? withTools : plain;
        // A copy all the way down: the options object is shared by every call
        // and a provider merges its reasoning INTO nested extras (Bedrock's
        // `additionalModelRequestFields`), which would otherwise stick.
        let extra: AnyRecord | undefined = request.extra ? structuredClone(request.extra) : undefined;

        // Chat Completions carries reasoning as `reasoning_effort`. A native
        // `reasoning` config would send OpenAI-family reasoning models to the
        // Responses API (a different request shape the gateway does not proxy)
        // and, on Azure, to a route the deployment may not serve.
        if (openAiSchema && request.reasoning) {
            const { effort } = request.reasoning;
            if (effort) extra = { ...(extra ?? {}), reasoning_effort: effort };
            delete request.reasoning;
        }

        for (const name of rule.params) {
            const lower = name.toLowerCase();
            const field = STRIPPABLE_FIELDS[lower];
            if (field) delete request[field];
            if (extra && lower in extra) delete extra[lower];
            if (extra && name in extra) delete extra[name];
        }

        // A rule can REQUIRE a value, not only forbid one (GPT-5 + tools:
        // `reasoning_effort: "none"`). Merged last so it always wins.
        if (hasTools && rule.detected.forced) extra = { ...(extra ?? {}), ...rule.detected.forced };

        if (extra && Object.keys(extra).length > 0) request.extra = extra;
        else delete request.extra;
        return request;
    };
}

/** Sampling and token settings of the model record, as the adapter's defaults. */
function buildNativeOptions(input: {
    driver: string;
    modelId: string;
    overrides: ModelSettingsOverrides;
    settings: AnyRecord;
    reasoning?: NativeAgentReasoning;
}): NativeModelOptions {
    const { driver, overrides } = input;
    const openAiSchema = OPENAI_SCHEMA_DRIVERS.has(driver);

    let maxTokens = overrides.maxCompletionTokens ?? overrides.maxTokens;
    // The Messages API refuses a request without `max_tokens`; an operator who
    // cleared the field gets a floor instead of a 400.
    if (driver === 'anthropic') maxTokens ??= ANTHROPIC_DEFAULT_MAX_TOKENS;

    let extra: AnyRecord | undefined = overrides.extraBody ? { ...overrides.extraBody } : undefined;
    // Converse carries model-specific parameters in its own envelope.
    if (driver === 'bedrock' && extra) extra = { additionalModelRequestFields: extra };
    // The LangChain Vertex client never forwarded the extra body; it would land
    // at the top level of the Gemini request, where OpenAI-style keys are errors.
    if (driver === 'vertex') extra = undefined;

    const reasoning = input.reasoning;
    const options: NativeModelOptions = {
        model: input.modelId,
        ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
        ...(overrides.topP !== undefined ? { topP: overrides.topP } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(openAiSchema && overrides.presencePenalty !== undefined ? { presencePenalty: overrides.presencePenalty } : {}),
        ...(openAiSchema && overrides.frequencyPenalty !== undefined ? { frequencyPenalty: overrides.frequencyPenalty } : {}),
    };

    if (reasoning) {
        if (openAiSchema) {
            if (reasoning.effort) extra = { ...(extra ?? {}), reasoning_effort: reasoning.effort };
        } else {
            options.reasoning = reasoning as SdkReasoning;
        }
    }
    if (extra) options.extra = extra;
    options.transformRequest = buildTransformRequest({ driver, modelId: input.modelId, settings: input.settings });
    return options;
}

/** `.stream()` answers with a single `invoke()`; tools bound later keep that. */
function collapseStreaming(model: BaseChatModel): BaseChatModel {
    const wrapped: BaseChatModel = { ...model };
    wrapped.stream = async function* collapsed(messages, options) {
        yield await model.invoke(messages, options);
    };
    if (typeof model.bindTools === 'function') {
        const bindTools = model.bindTools.bind(model);
        wrapped.bindTools = (tools, bindOptions) => collapseStreaming(bindTools(tools, bindOptions));
    }
    return wrapped;
}

/**
 * Streamed answers of an OpenAI-compatible upstream that leaks its reasoning
 * block into `content` (Bedrock's /openai/v1 for gpt-oss and MiniMax). The
 * response-body normalization cannot reach an SSE stream, so the deltas are
 * split here: the block becomes `reasoning` parts and is cut out of the text and
 * out of the final message, which keeps the reasoning as `reasoning.summary`.
 */
function splitInlineReasoningStream(model: BaseChatModel): BaseChatModel {
    const wrapped: BaseChatModel = { ...model };
    if (typeof model.stream === 'function') {
        const stream = model.stream.bind(model);
        wrapped.stream = async function* split(messages, options) {
            const splitter = createInlineReasoningSplitter();
            let text = '';
            let leaked = '';
            for await (const chunk of stream(messages, options)) {
                if (typeof chunk === 'string') {
                    const piece = splitter.push(chunk);
                    if (piece.reasoning) {
                        leaked += piece.reasoning;
                        yield { type: 'reasoning', reasoning_content: piece.reasoning };
                    }
                    if (piece.content) {
                        text += piece.content;
                        yield piece.content;
                    }
                    continue;
                }
                const message = chunk as AnyRecord | null;
                if (message && typeof message === 'object' && typeof message.role === 'string') {
                    // The stream ended inside a tag, or inside the reasoning itself.
                    const tail = splitter.flush();
                    if (tail.reasoning) {
                        leaked += tail.reasoning;
                        yield { type: 'reasoning', reasoning_content: tail.reasoning };
                    }
                    if (tail.content) {
                        text += tail.content;
                        yield tail.content;
                    }
                    if (!leaked) {
                        yield chunk;
                        continue;
                    }
                    const known = (message.reasoning as { summary?: string } | undefined)?.summary ?? '';
                    yield {
                        ...message,
                        content: text,
                        reasoning: { ...((message.reasoning as AnyRecord | undefined) ?? {}), summary: `${known}${leaked}` },
                    } as typeof chunk;
                    continue;
                }
                yield chunk;
            }
        };
    }
    if (typeof model.bindTools === 'function') {
        const bindTools = model.bindTools.bind(model);
        wrapped.bindTools = (tools, bindOptions) => splitInlineReasoningStream(bindTools(tools, bindOptions));
    }
    return wrapped;
}

export async function buildNativeAgentModel(input: NativeAgentModelInput): Promise<BaseChatModel> {
    const { model } = input;
    const { runtime, record } = await buildModelRuntime(input.tenantDbName, input.tenantId, model.providerKey, input.projectId);
    if (!runtime.createNativeProviderSpec) {
        throw new Error(`Provider "${record.driver}" cannot serve an agent: it has no chat model`);
    }

    const { modelSettings } = resolveModelInvocationConfig(model, input.overrides ?? {});
    const driver = record.driver;
    const spec = runtime.createNativeProviderSpec({
        modelId: model.modelId,
        category: 'llm',
        modelSettings,
    });
    const overrides = resolveOverrides(modelSettings, model.modelId, driver);
    const settingsReasoning = normalizeNativeReasoning(overrides.reasoning);

    const timeoutMs = input.timeoutMs ?? AGENT_MODEL_REQUEST_TIMEOUT_MS;
    const provider = {
        ...spec.provider,
        fetch: spec.normalizeInlineReasoning
            ? withInlineReasoningNormalization(input.fetch ?? guardedModelFetch(timeoutMs))
            : (input.fetch ?? guardedModelFetch(timeoutMs)),
        timeoutMs,
        // The budget was renamed by the operator (`max_tokens` is unsupported):
        // say so instead of letting the SDK guess from the model id.
        ...(overrides.maxTokensRenamed && (spec.provider.provider === 'openai' || spec.provider.provider === 'azure' || spec.provider.provider === 'openai-compatible')
            ? { maxTokensParam: 'max_completion_tokens' as const }
            : {}),
    } as typeof spec.provider;

    const { createProvider, fromNativeProvider } = await import('@cognipeer/agent-sdk');
    const native = fromNativeProvider(
        createProvider(provider),
        buildNativeOptions({
            driver,
            modelId: model.modelId,
            overrides,
            settings: modelSettings as AnyRecord,
            reasoning: input.reasoning ?? settingsReasoning ?? input.requestReasoning,
        }),
    );
    const streaming = spec.normalizeInlineReasoning ? splitInlineReasoningStream(native) : native;
    return input.disableStreaming ? collapseStreaming(streaming) : streaming;
}
