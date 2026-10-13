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

import type { BaseChatModel } from '@cognipeer/agent-sdk';
import type { IModel } from '@/lib/database';
import { resolveOverrides } from '@/lib/providers/contracts/modelContracts';
import { buildNativeOptions, buildProviderConfig, normalizeNativeReasoning } from '@/lib/providers/contracts/nativeClients';
import type { NativeReasoning } from '@/lib/providers/domains/model';
import { createInlineReasoningSplitter } from '@/lib/shared/inlineReasoning';
import { safeFetch } from '@/lib/security/outboundFetch';
import { resolveModelInvocationConfig } from '@/lib/services/models/inferenceService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';

/**
 * Time to the response HEADERS, per request. An open stream is never cut by it
 * (the SDK clears its timer once headers arrive; `safeFetch` does too). A
 * NON-streamed call only gets its headers when the whole answer is done, so this
 * must outlast the slowest reasoning completion: it is the 10 minutes the
 * OpenAI and Anthropic clients this path replaced allowed, not a tighter cap
 * (120 s cut long high-effort or large-output `invoke()` calls with a 408).
 */
export const AGENT_MODEL_REQUEST_TIMEOUT_MS = 600_000;

/** `safeFetch` gets a little more, so the SDK's own timeout (a clean 408) fires first. */
const GUARD_TIMEOUT_MARGIN_MS = 5_000;

/** The normalized reasoning value (`unset = send nothing`). */
export type NativeAgentReasoning = NativeReasoning;

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

export { normalizeNativeReasoning };

/** The transport every native agent call goes through: the SSRF guard, time-to-headers bounded. */
export function guardedModelFetch(timeoutMs: number): typeof fetch {
    return (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        // `keepAbortLinked`: the SDK ends a streamed answer by aborting this call's signal, which must
        // reach the open response too, not only the wait for its headers.
        return safeFetch(url, init, { timeoutMs: timeoutMs + GUARD_TIMEOUT_MARGIN_MS, keepAbortLinked: true });
    };
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

/** The reasoning TEXT of a message, gone. Provider blocks stay: they are what the next request replays (Anthropic signatures). */
function withoutReasoningText<M>(message: M): M {
    const reasoning = (message as AnyRecord | null)?.reasoning as AnyRecord | undefined;
    if (!reasoning || typeof reasoning !== 'object' || reasoning.summary === undefined) return message;
    const { summary: _summary, ...rest } = reasoning;
    void _summary;
    const next = { ...(message as AnyRecord) };
    if (Object.keys(rest).length > 0) next.reasoning = rest;
    else delete next.reasoning;
    return next as M;
}

/**
 * Model Hub "Return reasoning to callers" off: the model's thinking text never
 * leaves the model, so no agent output (API response, session message, portal,
 * Studio) can show it. The gateway enforces the same switch on a direct call; an
 * agent calls the provider itself, so it is enforced here. Token accounting is
 * untouched: usage rides on the message, not on this text.
 */
function hideReasoningText(model: BaseChatModel): BaseChatModel {
    const wrapped: BaseChatModel = { ...model };
    if (typeof model.invoke === 'function') {
        const invoke = model.invoke.bind(model);
        wrapped.invoke = async (messages, options) => withoutReasoningText(await invoke(messages, options));
    }
    if (typeof model.stream === 'function') {
        const stream = model.stream.bind(model);
        wrapped.stream = async function* hidden(messages, options) {
            for await (const chunk of stream(messages, options)) {
                if (chunk && typeof chunk === 'object' && (chunk as AnyRecord).type === 'reasoning') continue;
                yield withoutReasoningText(chunk);
            }
        };
    }
    if (typeof model.bindTools === 'function') {
        const bindTools = model.bindTools.bind(model);
        wrapped.bindTools = (tools, bindOptions) => hideReasoningText(bindTools(tools, bindOptions));
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
    const provider = buildProviderConfig(spec, overrides, { fetch: input.fetch ?? guardedModelFetch(timeoutMs), timeoutMs });

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
    const visible = (modelSettings as AnyRecord).returnReasoning === false ? hideReasoningText(streaming) : streaming;
    return input.disableStreaming ? collapseStreaming(visible) : visible;
}
