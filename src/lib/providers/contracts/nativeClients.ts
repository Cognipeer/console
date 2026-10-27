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
  ModelRuleLearnedEvent,
  BaseProvider,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  NativeModelOptions,
} from '@cognipeer/agent-sdk';
import { createLogger } from '@/lib/core/logger';
import { resolveUnsupportedParamNames } from '../unsupportedParams';
import { resolveUpstreamApi } from '@/lib/services/models/upstreamApi';
import {
  OPENAI_SCHEMA_DRIVERS,
  bedrockCarriesThinking,
  effortForBudget,
  hasExplicitThinking,
} from '@/lib/services/models/reasoning';
import {
  ANTHROPIC_FALLBACK_OUTPUT_TOKENS,
  computeOutputTokenLimit,
  fitThinkingToLimit,
} from '@/lib/services/models/outputLimits';
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
 * The Messages API refuses a request without `max_tokens`. When nothing is configured the call is sent the
 * model's maximum (see `computeOutputTokenLimit`); this is what it falls back to for a model whose
 * maximum is not known. Kept under its old name for the callers that import it.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = ANTHROPIC_FALLBACK_OUTPUT_TOKENS;

/** Drivers whose wire format is OpenAI Chat Completions (defined with the reasoning rules that need it, pure). */
export { OPENAI_SCHEMA_DRIVERS };

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const logger = createLogger('native-model-client');

/**
 * The SDK learned a per-model adjustment from a provider 400 (a parameter to drop, an effort list, a renamed
 * token field ...) and applies it from now on in this process. Logged so an operator can promote it to the
 * Model Hub settings or report the model for the shared rule table.
 */
export function logModelRuleLearned(event: ModelRuleLearnedEvent): void {
  logger.info('Model rule learned from a provider error', {
    provider: event.provider,
    model: event.model,
    adjustment: event.adjustment,
    reason: event.reason,
  });
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

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

    // The typed `reasoning` stays on the request for both upstream APIs: the SDK maps the effort to
    // what the model's rule takes (Chat Completions `reasoning_effort`, Responses `reasoning.effort`).
    // An effort put in `extra` would bypass that mapping.

    for (const name of rule.params) {
      const lower = name.toLowerCase();
      const field = STRIPPABLE_FIELDS[lower];
      if (field) delete request[field];
      // `reasoning` and `reasoning_effort` are one setting to the gateway: listing only
      // `reasoning` must also keep an effort the operator put in the extra body off the wire.
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

function firstPositive(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
}

/**
 * The `max_tokens` a call to this model is sent with: the request's own value, else the model record's
 * (`maxCompletionTokens` > `maxTokens`), else the driver default, then the thinking headroom and the model
 * maximum cap. The ONE place the native client decides it - `buildNativeOptions` and every `prepare` call
 * go through here, and the gateway's `resolveOutputTokenLimit` goes through the same `computeOutputTokenLimit`,
 * so the limit it reports on a cut-off answer is the one that was sent.
 *
 * `reasoning` is what thinking is derived from for THIS call: pass undefined when the call runs without it
 * (a tool loop whose signed thinking blocks were lost, see `hasUnreplayableToolTurn`). `modelMax` is the
 * model's maximum when the caller knows a declared one; the built-in table by model id applies otherwise.
 */
export function resolveNativeMaxTokens(input: {
  driver: string;
  modelId: string;
  overrides: ModelSettingsOverrides;
  reasoning?: unknown;
  /** The request's own limit; beats the model record's and is a hard cap (no thinking headroom on top). */
  requestMaxTokens?: number;
  stream?: boolean;
  modelMax?: number;
}): number | undefined {
  const { driver, overrides } = input;
  return computeOutputTokenLimit({
    driver,
    modelId: input.modelId,
    modelMax: input.modelMax,
    override: firstPositive(input.requestMaxTokens),
    configured: firstPositive(overrides.maxCompletionTokens, overrides.maxTokens),
    stream: input.stream,
    reasoning: input.reasoning,
    explicitThinking: (driver === 'anthropic' || driver === 'bedrock') && hasExplicitThinking(overrides.extraBody),
  });
}

/**
 * The limit AND the reasoning ONE call is sent with, decided together (same input as `resolveNativeMaxTokens`).
 *
 *  - A limit that cannot move (the caller's own cap) leaves a thinking budget no room to be raised, and the SDK raises
 *    `max_tokens` itself when it is below the budget + its reserve: so the budget is fitted under the limit, or the call
 *    runs without thinking when nothing fits (`fitThinkingToLimit`). The gateway and the native client agree on the
 *    number: it is the caller's, thinking or not.
 *  - An OpenAI-schema SDK provider reads the reasoning EFFORT only, so a token budget with no effort (`budget_tokens`,
 *    the `max_tokens` of an OpenRouter-style `reasoning` object) is sent as the effort it stands for.
 */
export function resolveNativeCall(input: {
  driver: string;
  modelId: string;
  overrides: ModelSettingsOverrides;
  reasoning?: ChatCompletionRequest['reasoning'];
  requestMaxTokens?: number;
  stream?: boolean;
  modelMax?: number;
}): { maxTokens: number | undefined; reasoning: ChatCompletionRequest['reasoning'] } {
  const { driver, modelId, overrides } = input;
  const maxTokens = resolveNativeMaxTokens(input);
  let reasoning = fitThinkingToLimit(input.reasoning, {
    driver,
    modelId,
    limit: maxTokens,
    explicitThinking: (driver === 'anthropic' || driver === 'bedrock') && hasExplicitThinking(overrides.extraBody),
  });
  if (reasoning && OPENAI_SCHEMA_DRIVERS.has(driver) && reasoning.effort === undefined && (reasoning.budgetTokens ?? 0) > 0) {
    reasoning = { ...reasoning, effort: effortForBudget(reasoning.budgetTokens as number) };
  }
  return { maxTokens, reasoning };
}

/**
 * The reasoning a model's own settings send on every call (before the call's limit is known), or undefined when this
 * driver / model must not carry it. Extended thinking on Bedrock is a Claude feature, the other Converse families have
 * their own reasoning envelope and are left alone; and an operator-supplied `thinking` block in the extra body is the
 * whole instruction: a second, translated one would conflict with it.
 */
export function modelDefaultReasoning(
  driver: string,
  modelId: string,
  overrides: ModelSettingsOverrides,
  reasoning: NativeReasoning | undefined,
): NativeReasoning | undefined {
  if (driver === 'bedrock' && !bedrockCarriesThinking(modelId)) return undefined;
  if ((driver === 'anthropic' || driver === 'bedrock') && hasExplicitThinking(overrides.extraBody)) return undefined;
  return reasoning;
}

/**
 * Converse top-level fields the SDK builds from the request itself. An extra body (the operator's or a caller's
 * passthrough) does not get to replace them: the gateway's resolved limit, system prompt and tools are the last word.
 */
const BEDROCK_REQUEST_FIELDS: ReadonlySet<string> = new Set(['messages', 'system', 'inferenceConfig', 'toolConfig']);

/**
 * The extra body of a Bedrock call. It is handed to the SDK AS IS: the SDK sends Converse's own top-level fields
 * (`guardrailConfig`, `performanceConfig`, `serviceTier`, `requestMetadata` ...) at the top level, merges an explicit
 * `additionalModelRequestFields` and puts every other key (`top_k`, `anthropic_beta` ...) into it, so nothing is
 * wrapped here.
 */
function bedrockExtra(extra: AnyRecord | undefined): AnyRecord | undefined {
  if (!extra) return undefined;
  // `__*` keys are the SDK's escape hatches (`__top` forces keys to the Converse top level): never forwarded.
  const out = Object.fromEntries(
    Object.entries(extra).filter(([key]) => !BEDROCK_REQUEST_FIELDS.has(key) && !key.startsWith('__')),
  );
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A caller's extra body on Bedrock: everything goes into `additionalModelRequestFields` (its own fields of that name
 * merged in), never to the Converse top level - only the operator's model-level extra body reaches the top level.
 * A caller's `guardrailConfig` is therefore inert model-specific data, not a replacement for the operator's.
 */
function bedrockRequestExtra(extra: AnyRecord | undefined): AnyRecord | undefined {
  const safe = bedrockExtra(extra);
  if (!safe) return undefined;
  const { additionalModelRequestFields, ...rest } = safe;
  const fields = { ...(isRecord(additionalModelRequestFields) ? additionalModelRequestFields : {}), ...rest };
  return Object.keys(fields).length > 0 ? { additionalModelRequestFields: fields } : undefined;
}

/**
 * The top-level Gemini request keys the model's extra body may set on Vertex. The SDK assigns the extra body
 * SHALLOWLY at the top level of the request, so `generationConfig`, `tools` or `toolConfig` in it would replace the ones
 * it built (limit, thinking, tools), and the OpenAI-style keys of a requestDefaults are errors there. `safetySettings`
 * and `labels` are request-level fields of their own that the SDK does not set.
 */
const VERTEX_EXTRA_FIELDS = ['safetySettings', 'labels'] as const;

function vertexExtra(extra: AnyRecord | undefined): AnyRecord | undefined {
  if (!extra) return undefined;
  const out: AnyRecord = {};
  for (const key of VERTEX_EXTRA_FIELDS) {
    if (extra[key] !== undefined) out[key] = extra[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A request's extra body over the model's. One level deep for Converse's `additionalModelRequestFields`: a request adding
 * one model-specific field must not wipe the ones the model record sets.
 */
function mergeExtra(driver: string, base: AnyRecord | undefined, overlay: AnyRecord | undefined): AnyRecord | undefined {
  if (driver === 'bedrock') {
    base = bedrockExtra(base);
    overlay = bedrockRequestExtra(overlay);
  }
  if (!base && !overlay) return undefined;
  const merged: AnyRecord = { ...(base ?? {}), ...(overlay ?? {}) };
  const baseFields = base?.additionalModelRequestFields;
  const overlayFields = overlay?.additionalModelRequestFields;
  if (driver === 'bedrock' && isRecord(baseFields) && isRecord(overlayFields)) {
    merged.additionalModelRequestFields = { ...baseFields, ...overlayFields };
  }
  return merged;
}

/**
 * Sampling and token settings of the model record, as the request defaults.
 * `stream` says which kind of call the token default is for (a non-streaming default is capped); the
 * client itself re-resolves the limit per call, so a request's own value and its stream mode apply.
 */
export function buildNativeOptions(input: {
  driver: string;
  modelId: string;
  overrides: ModelSettingsOverrides;
  settings: AnyRecord;
  reasoning?: NativeReasoning;
  stream?: boolean;
  modelMax?: number;
}): NativeModelOptions {
  const { driver, overrides } = input;
  const openAiSchema = OPENAI_SCHEMA_DRIVERS.has(driver);

  // The Messages API refuses a request without `max_tokens`; the default is the model maximum (or a floor),
  // and thinking tokens come out of the same limit - see `computeOutputTokenLimit`.
  const { maxTokens, reasoning } = resolveNativeCall({
    driver,
    modelId: input.modelId,
    overrides,
    reasoning: modelDefaultReasoning(driver, input.modelId, overrides, input.reasoning),
    // The gateway marks a limit the caller set (gatewayRequest.ts `buildChatModelSettings`).
    requestMaxTokens: firstPositive(input.settings.requestMaxTokens),
    stream: input.stream,
    modelMax: input.modelMax,
  });

  let extra: AnyRecord | undefined = overrides.extraBody ? { ...overrides.extraBody } : undefined;
  // Converse: the SDK sorts the extra body into its top level and `additionalModelRequestFields` itself.
  if (driver === 'bedrock') extra = bedrockExtra(extra);
  // The LangChain Vertex client never forwarded the extra body; it would land at the top level of the Gemini
  // request, where OpenAI-style keys are errors. Only the request-level keys Gemini defines on its own go through.
  if (driver === 'vertex') extra = vertexExtra(extra);

  const options: NativeModelOptions = {
    model: input.modelId,
    ...(overrides.temperature !== undefined ? { temperature: overrides.temperature } : {}),
    ...(overrides.topP !== undefined ? { topP: overrides.topP } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(openAiSchema && overrides.presencePenalty !== undefined ? { presencePenalty: overrides.presencePenalty } : {}),
    ...(openAiSchema && overrides.frequencyPenalty !== undefined ? { frequencyPenalty: overrides.frequencyPenalty } : {}),
  };

  if (reasoning) {
    // The provider turns it into the wire form itself (`reasoning_effort`, `reasoning: {effort, summary}`, thinking).
    options.reasoning = reasoning as NonNullable<NativeModelOptions['reasoning']>;
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
    onModelRuleLearned: logModelRuleLearned,
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

  // The model's maximum output as the gateway resolved it (the record's declared value or the built-in table);
  // without it the table by model id applies.
  const modelMax = firstPositive(settings.maxOutputTokens, settings.max_output_tokens);

  // The settings carry the full normalized reasoning (includeThoughts too); the typed
  // overrides only know effort/summary.
  const settingsReasoning = normalizeNativeReasoning(settings.reasoning) ?? normalizeNativeReasoning(overrides.reasoning);
  const defaults = buildNativeOptions({
    driver,
    modelId,
    overrides,
    settings,
    modelMax,
    reasoning: settingsReasoning,
  });
  // `defaults.reasoning` is fitted to the settings' own limit; every call fits the model's default again to ITS limit.
  const { transformRequest, extra: defaultExtra, reasoning: fittedDefaultReasoning, ...scalarDefaults } = defaults;
  void scalarDefaults.model;
  void fittedDefaultReasoning;
  const defaultReasoning = modelDefaultReasoning(driver, modelId, overrides, settingsReasoning);

  const prepare = async (request: NativeChatRequest, stream: boolean): Promise<ChatCompletionRequest> => {
    const merged: ChatCompletionRequest = {
      ...request,
      model: request.model ?? modelId,
      temperature: request.temperature ?? scalarDefaults.temperature,
      topP: request.topP ?? scalarDefaults.topP,
      presencePenalty: request.presencePenalty ?? scalarDefaults.presencePenalty,
      frequencyPenalty: request.frequencyPenalty ?? scalarDefaults.frequencyPenalty,
      stop: request.stop ?? scalarDefaults.stop,
      stream,
    };
    for (const key of Object.keys(merged) as Array<keyof ChatCompletionRequest>) {
      if (merged[key] === undefined) delete merged[key];
    }
    const requested = request.reasoning ?? defaultReasoning;
    // Thinking cannot continue a tool loop whose signed blocks were lost on the
    // way in: that call runs without it (the first turn of the loop kept it).
    const mustDropThinking = (driver === 'anthropic' || driver === 'bedrock') && hasUnreplayableToolTurn(merged.messages);
    // Decided per call, limit and reasoning together: the request's own value beats the model record's, a non-streaming
    // default is capped, the thinking headroom only applies when the call actually thinks, and a limit that cannot
    // move (the caller's cap) is never raised for a budget: the budget is fitted under it, or thinking is dropped.
    const call = resolveNativeCall({
      driver,
      modelId,
      overrides,
      reasoning: mustDropThinking ? undefined : requested,
      requestMaxTokens: request.maxTokens ?? firstPositive(settings.requestMaxTokens),
      stream,
      modelMax,
    });
    if (call.reasoning) merged.reasoning = call.reasoning;
    else delete merged.reasoning;
    if (call.maxTokens !== undefined) merged.maxTokens = call.maxTokens;
    else delete merged.maxTokens;
    if (requested && !mustDropThinking && (!call.reasoning || call.reasoning.budgetTokens !== requested.budgetTokens)) {
      logger.debug('Thinking fitted to the output limit of the call', {
        driver,
        modelId,
        limit: call.maxTokens,
        requestedBudget: requested.budgetTokens,
        effort: requested.effort,
        dropped: !call.reasoning,
      });
    }
    // Nothing per request on Vertex (see `vertexExtra`); Bedrock keeps its Converse envelope sorted by the SDK.
    const extra = mergeExtra(driver, defaultExtra, driver === 'vertex' ? undefined : request.extra);
    if (extra) merged.extra = extra;
    else delete merged.extra;
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
