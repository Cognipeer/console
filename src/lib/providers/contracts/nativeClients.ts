/**
 * Native (agent-sdk) clients of the model provider contracts.
 *
 * `createNativeChatClient` / `createNativeEmbedder` of every contract. They reuse the
 * credential / endpoint resolution of the contract (its `createNativeProviderSpec`
 * closure - no secret is read here) and the per-model request rules that already
 * apply to a gateway call:
 *
 *  - `resolveOverrides` (unsupportedParams, requestDefaults / extraBody, the
 *    `max_tokens` rename, the stream-options opt-out),
 *  - `resolveUnsupportedParamNames` for the rules that depend on the request
 *    carrying tools (GPT-5: no `reasoning_effort` next to function tools),
 *  - the reasoning default of the Model Hub record.
 *
 * The client is request-level: a caller (the gateway core, a judge, OCR, the
 * agent adapter) hands over a unified `ChatCompletionRequest`; the model's
 * defaults are folded in, the finished request is made legal for the model, and
 * the provider answers with the native response / chunk shapes (reasoning blocks,
 * tool-call deltas, raw finish reason, usage).
 */

import type {
  BaseProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  NativeModelOptions,
} from '@cognipeer/agent-sdk';
import { resolveUnsupportedParamNames } from '../unsupportedParams';
import { resolveUpstreamApi } from '@/lib/services/models/upstreamApi';
import { hasExplicitThinking, translateAnthropicThinking } from '@/lib/services/models/reasoning';
import { withFileReferenceRestore, withInlineReasoningNormalization } from './wireNormalization';
import type {
  ModelRuntimeConfig,
  NativeChatClient,
  NativeChatRequest,
  NativeEmbedder,
  NativeProviderSpec,
  NativeReasoning,
  NativeTransport,
} from '../domains/model';
import type { ModelSettingsOverrides } from './modelContracts';

/**
 * The Messages API refuses a request without `max_tokens`; this is the floor
 * applied when an operator has cleared the field. Generous enough not to
 * truncate a coding answer, bounded enough not to be a blank cheque.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

/** Drivers whose wire format is OpenAI Chat Completions. */
export const OPENAI_SCHEMA_DRIVERS: ReadonlySet<string> = new Set(['openai', 'openai-compatible', 'azure', 'together']);

type AnyRecord = Record<string, unknown>;

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);

/** Any of the reasoning shapes in circulation (legacy `{effort, summary}` included), as the normalized value. */
export function normalizeNativeReasoning(value: unknown): NativeReasoning | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as AnyRecord;
  const out: NativeReasoning = {};
  if (typeof raw.effort === 'string' && EFFORTS.has(raw.effort)) out.effort = raw.effort as NativeReasoning['effort'];
  if (typeof raw.budgetTokens === 'number' && Number.isFinite(raw.budgetTokens) && raw.budgetTokens > 0) out.budgetTokens = raw.budgetTokens;
  if (typeof raw.includeThoughts === 'boolean') out.includeThoughts = raw.includeThoughts;
  return Object.keys(out).length > 0 ? out : undefined;
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

const REASONING_WIRE_NAMES = ['reasoning', 'reasoning_effort'];

/**
 * The last-mile hook: the finished request (tools bound, reasoning applied) is
 * made legal for this model. Rules that depend on the request carrying tools
 * cannot be decided when the client is built - the caller binds tools per call.
 */
export function buildTransformRequest(input: {
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
  // The tools-conditional rules (GPT-5: no reasoning effort next to function tools) are
  // Chat Completions limits; a model whose upstream API is Responses takes both together.
  const onResponses = openAiSchema && resolveUpstreamApi(input.settings) === 'responses';
  const withTools = onResponses ? plain : resolve(true);

  return (request: ChatCompletionRequest) => {
    const hasTools = Boolean(request.tools?.length);
    const rule = hasTools ? withTools : plain;
    // A copy all the way down: the options object is shared by every call
    // and a provider merges its reasoning INTO nested extras (Bedrock's
    // `additionalModelRequestFields`), which would otherwise stick.
    let extra: AnyRecord | undefined = request.extra ? structuredClone(request.extra) : undefined;

    // Chat Completions carries reasoning as `reasoning_effort` (its wire name, so a
    // gateway-namespaced model id keeps it). On the Responses upstream the typed
    // `reasoning` stays: the provider sends it as `reasoning: {effort, summary}`.
    if (openAiSchema && !onResponses && request.reasoning) {
      const { effort } = request.reasoning;
      if (effort) extra = { ...(extra ?? {}), reasoning_effort: effort };
      delete request.reasoning;
    }

    for (const name of rule.params) {
      const lower = name.toLowerCase();
      const field = STRIPPABLE_FIELDS[lower];
      if (field) delete request[field];
      // `reasoning` and `reasoning_effort` are one setting to the gateway, and here an
      // OpenAI-schema effort already sits in `extra` under its wire name: listing only
      // `reasoning` must still keep it off the wire.
      const names = lower === 'reasoning' || lower === 'reasoning_effort' ? REASONING_WIRE_NAMES : [lower, name];
      if (extra) for (const key of names) delete extra[key];
      if (lower === 'reasoning' || lower === 'reasoning_effort') delete request.reasoning;
    }

    // A rule can REQUIRE a value, not only forbid one (GPT-5 + tools:
    // `reasoning_effort: "none"`). Merged last so it always wins.
    if (hasTools && rule.detected.forced) extra = { ...(extra ?? {}), ...rule.detected.forced };

    if (extra && Object.keys(extra).length > 0) request.extra = extra;
    else delete request.extra;
    return request;
  };
}

/**
 * Extended thinking and a tool loop only mix when the loop replays the model's
 * SIGNED thinking blocks: Anthropic answers a replayed `tool_use` turn that does
 * not start with its thinking block with a 400. True when the request ends in a
 * tool turn (an assistant message with tool calls after the last real user
 * message) that cannot be replayed that way, because the caller never kept the
 * blocks - a plain /messages or /chat/completions client, whose history is
 * rebuilt from OpenAI-shaped messages.
 */
export function hasUnreplayableToolTurn(messages: ChatCompletionRequest['messages']): boolean {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUser = i;
      break;
    }
  }
  return messages.slice(lastUser + 1).some(
    (message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0 && !message.reasoning?.blocks?.length,
  );
}

/** Sampling and token settings of the model record, as the request defaults. */
export function buildNativeOptions(input: {
  driver: string;
  modelId: string;
  overrides: ModelSettingsOverrides;
  settings: AnyRecord;
  reasoning?: NativeReasoning;
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

  const options: NativeModelOptions = {
    model: input.modelId,
    ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
    ...(overrides.topP !== undefined ? { topP: overrides.topP } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(openAiSchema && overrides.presencePenalty !== undefined ? { presencePenalty: overrides.presencePenalty } : {}),
    ...(openAiSchema && overrides.frequencyPenalty !== undefined ? { frequencyPenalty: overrides.frequencyPenalty } : {}),
  };

  // An operator-supplied `thinking` block in the extra body is the whole
  // instruction: a second, translated one would conflict with it.
  // Extended thinking on Bedrock is a Claude feature; the other Converse families have
  // their own reasoning envelope and are left alone.
  const reasoning = driver === 'bedrock' && !/anthropic|claude/i.test(input.modelId) ? undefined : input.reasoning;
  if (reasoning && !((driver === 'anthropic' || driver === 'bedrock') && hasExplicitThinking(overrides.extraBody))) {
    if (openAiSchema && resolveUpstreamApi(input.settings) === 'responses') {
      // Responses: the provider sends `reasoning: {effort, summary}` itself.
      options.reasoning = reasoning as NonNullable<NativeModelOptions['reasoning']>;
    } else if (openAiSchema) {
      if (reasoning.effort) extra = { ...(extra ?? {}), reasoning_effort: reasoning.effort };
    } else {
      options.reasoning = reasoning as NonNullable<NativeModelOptions['reasoning']>;
      // Thinking tokens come out of `max_tokens`: leave the answer the room the console's
      // rule promises (the SDK's own floor is thinner), and keep a roomy cap as it is.
      if (driver === 'anthropic' || driver === 'bedrock') {
        const thinking = translateAnthropicThinking(reasoning, maxTokens, input.modelId);
        if (thinking?.thinking.type === 'enabled' && thinking.maxTokens !== undefined) options.maxTokens = thinking.maxTokens;
      }
    }
  }
  if (extra) options.extra = extra;
  options.transformRequest = buildTransformRequest({ driver, modelId: input.modelId, settings: input.settings });
  return options;
}

/** The provider config with the transport, retry budget and token-param rule applied. */
export function buildProviderConfig(
  spec: NativeProviderSpec,
  overrides: ModelSettingsOverrides,
  transport: NativeTransport | undefined,
  maxRetries?: number,
): NativeProviderSpec['provider'] {
  const baseFetch = transport?.fetch;
  const kind = spec.provider.provider;
  const normalizingFetch = spec.normalizeInlineReasoning ? withInlineReasoningNormalization(baseFetch) : baseFetch;
  const fetchImpl = kind === 'openai' || kind === 'azure' || kind === 'openai-compatible'
    ? withFileReferenceRestore(normalizingFetch)
    : normalizingFetch;
  return {
    ...spec.provider,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(transport?.timeoutMs !== undefined ? { timeoutMs: transport.timeoutMs } : {}),
    ...(maxRetries !== undefined && 'retry' in spec.provider ? { retry: { ...(spec.provider.retry ?? {}), maxRetries } } : {}),
    // The budget was renamed by the operator (`max_tokens` is unsupported):
    // say so instead of letting the SDK guess from the model id.
    ...(overrides.maxTokensRenamed && (kind === 'openai' || kind === 'azure' || kind === 'openai-compatible')
      ? { maxTokensParam: 'max_completion_tokens' as const }
      : {}),
  } as NativeProviderSpec['provider'];
}

export interface BuildNativeChatClientInput {
  driver: string;
  spec: NativeProviderSpec;
  config: ModelRuntimeConfig;
  overrides: ModelSettingsOverrides;
  transport?: NativeTransport;
}

/** The client. Requests carry gateway-resolved values; the model record fills in only what they leave unset. */
export async function buildNativeChatClient(input: BuildNativeChatClientInput): Promise<NativeChatClient> {
  const { driver, spec, config, overrides } = input;
  const settings = (config.modelSettings ?? {}) as AnyRecord;
  const modelId = config.modelId;
  const provider: BaseProvider = await (async () => {
    const { createProvider } = await import('@cognipeer/agent-sdk');
    return createProvider(buildProviderConfig(spec, overrides, input.transport, config.options?.maxRetries));
  })();

  const defaults = buildNativeOptions({
    driver,
    modelId,
    overrides,
    settings,
    // The settings carry the full normalized reasoning (includeThoughts too); the typed
    // overrides only know effort/summary.
    reasoning: normalizeNativeReasoning(settings.reasoning) ?? normalizeNativeReasoning(overrides.reasoning),
  });
  const { transformRequest, extra: defaultExtra, reasoning: defaultReasoning, ...scalarDefaults } = defaults;
  void scalarDefaults.model;

  const prepare = async (request: NativeChatRequest, stream: boolean): Promise<ChatCompletionRequest> => {
    const merged: ChatCompletionRequest = {
      ...request,
      model: request.model ?? modelId,
      temperature: request.temperature ?? scalarDefaults.temperature,
      topP: request.topP ?? scalarDefaults.topP,
      maxTokens: request.maxTokens ?? scalarDefaults.maxTokens,
      presencePenalty: request.presencePenalty ?? scalarDefaults.presencePenalty,
      frequencyPenalty: request.frequencyPenalty ?? scalarDefaults.frequencyPenalty,
      stop: request.stop ?? scalarDefaults.stop,
      stream,
    };
    for (const key of Object.keys(merged) as Array<keyof ChatCompletionRequest>) {
      if (merged[key] === undefined) delete merged[key];
    }
    const reasoning = request.reasoning ?? defaultReasoning;
    // Thinking cannot continue a tool loop whose signed blocks were lost on the
    // way in: that call runs without it (the first turn of the loop kept it).
    const mustDropThinking = (driver === 'anthropic' || driver === 'bedrock') && hasUnreplayableToolTurn(merged.messages);
    if (reasoning && !mustDropThinking) merged.reasoning = reasoning;
    if (defaultExtra || request.extra) merged.extra = { ...(defaultExtra ?? {}), ...(request.extra ?? {}) };
    if (stream && overrides.streamUsage === false && merged.streamUsage === undefined) merged.streamUsage = false;
    const out = await transformRequest!(merged);
    return out ?? merged;
  };

  return {
    driver,
    modelId,
    provider,
    normalizeInlineReasoning: Boolean(spec.normalizeInlineReasoning),
    prepare: (request, options) => prepare(request, Boolean(options?.stream)),
    async complete(request) {
      return provider.complete(await prepare(request, false)) as Promise<ChatCompletionResponse>;
    },
    async *stream(request): AsyncGenerator<ChatCompletionChunk, void, unknown> {
      yield* provider.completeStream(await prepare(request, true));
    },
  };
}

export interface BuildNativeEmbedderInput {
  driver: string;
  spec: NativeProviderSpec;
  config: ModelRuntimeConfig;
  transport?: NativeTransport;
}

export async function buildNativeEmbedder(input: BuildNativeEmbedderInput): Promise<NativeEmbedder> {
  const { spec, config } = input;
  const { createProvider } = await import('@cognipeer/agent-sdk');
  // Embeddings carry no reasoning, so the inline-reasoning body rewrite never applies.
  const provider = createProvider(
    buildProviderConfig({ provider: spec.provider }, {}, input.transport, config.options?.maxRetries),
  );
  return {
    driver: input.driver,
    modelId: config.modelId,
    provider,
    embed: (texts, options): Promise<EmbeddingResponse> => {
      const request: EmbeddingRequest = {
        model: config.modelId,
        input: texts,
        ...(options?.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
        ...(options?.encodingFormat ? { encodingFormat: options.encodingFormat } : {}),
        ...(options?.inputType ? { inputType: options.inputType } : {}),
        ...(options?.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options?.extra ? { extra: options.extra } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      return provider.embed(request);
    },
  };
}
