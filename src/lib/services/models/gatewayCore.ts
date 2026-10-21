/**
 * The gateway core: ONE model call, in agent-sdk native terms.
 *
 * Every rule configured at the model level applies here, whoever calls: the
 * Dynamic LLM router, replica pool, request-parameter rules (unsupportedParams,
 * requestDefaults / extraBody, the reasoning precedence), input guardrails, the
 * semantic cache, output and stream guardrails, usage / cost logging. The HTTP
 * edges translate their wire formats to `ModelCallInput` and back; an in-process
 * caller (an agent) uses it directly.
 *
 * Stage order (unchanged from the LangChain pipeline this replaces):
 *
 *   model resolve -> Dynamic LLM routing -> input guardrails -> parameter /
 *   reasoning resolution -> semantic cache -> replica pool -> provider call
 *   (native client, retries owned by `withResilience`) -> output / stream
 *   guardrails -> usage logging -> `onUsageSettled`
 *
 * What is native: the request the provider receives, the response and the stream
 * chunks it answers with (reasoning blocks and their signatures, tool-call
 * deltas with an index, the raw finish reason, real usage). What is OpenAI-shaped
 * on purpose: the `wire` view of the request (logs, cache key, routing signals,
 * caller passthrough) and the rendition the semantic cache stores.
 */

import crypto from 'crypto';
import type { ChatCompletionChunk, ChatCompletionResponse, ProviderResponseFields, UnifiedMessage } from '@cognipeer/agent-sdk';
import { AGENT_REASONING_OVERRIDE, shouldReturnReasoning, withReasoningVisibility } from '@/lib/services/models/reasoning';
import { resolveUpstreamApi, supportsUpstreamApiChoice } from '@/lib/services/models/upstreamApi';
import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { fireAndForget } from '@/lib/core/asyncTask';
import type { IModel } from '@/lib/database';
import type { UsageAttribution } from '@/lib/services/usage/usageEvents';
import { createInlineReasoningSplitter, splitInlineReasoning } from '@/lib/shared/inlineReasoning';
import { repairJsonContent } from '@/lib/shared/jsonExtraction';
import { InvalidRequestError } from '@/lib/providers/contracts/upstreamError';
import { OPENAI_SCHEMA_DRIVERS, normalizeNativeReasoning } from '@/lib/providers/contracts/nativeClients';
import type { NativeChatClient, NativeChatRequest } from '@/lib/providers/domains/model';
import { createStreamGate } from '@/lib/services/guardrail';
import type { HookScope } from '@/lib/services/guardrail';
import type { StreamGateEmission } from '@/lib/services/guardrail/hooks/streamGate';
import { evaluateGuardrail } from '@/lib/services/guardrail';
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
import { getModelByKey } from './modelService';
import { buildModelRuntime } from './runtimeService';
import { replicaOrder, modelForReplica, shouldTryNextReplica, type ResolvedReplica } from './replicaPool';
import { MAX_ROUTING_DEPTH, getDynamicRoutingConfig } from './dynamicRouting';
import { normalizeInferenceError, OutputTokenLimitError } from './openaiErrors';
import { buildCacheVariantKey, isSemanticCacheEnabled, lookupCache, storeInCache } from './semanticCacheService';
import { calculateCost, logModelUsage, type TokenUsage } from './usageLogger';
import {
  describeRequestContract,
  resolveModelInvocationConfig,
  resolveOutputTokenLimit,
  sanitizeForLogging,
} from './gatewayRequest';
import {
  GuardrailBlockError,
  annotateResponseWithGuardrails,
  enforceModelGuardrailChain,
  foldGuardrailAnnotation,
  gatewayActor,
  guardrailContentToText,
  latestUserTextNative,
  outputGuardrailPolicyVersions,
  replaceLatestUserText,
  replaceLatestUserTextNative,
} from './gatewayGuardrails';
import { resolveDynamicCompletion } from './gatewayRouting';
import {
  type ImagePartWithDetail,
  OpenAiStreamFramer,
  imagePartToOpenAi,
  newCompletionId,
  nativeRequestToWire,
  openAIStreamDeltaChunk,
  openAiResponseToNative,
  toOpenAIChatResponse,
} from './openaiAdapter';
import { StreamAssembler, finishWithToolCalls, frameHasContent, fromGateFrame, toGateFrame, wireFinishReason } from './gatewayStream';
import { estimateTokensFromText, toGatewayUsage, toWireUsage } from './gatewayUsage';
import type {
  GatewayChatRequest,
  ContentPart,
  GuardrailAnnotation,
  ModelCallInput,
  ModelCallOutcome,
  ModelStreamDelta,
  ModelStreamEvent,
  ReasoningPayload,
} from './gatewayTypes';

const logger = createLogger('inference');

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function ensureLlmModel(model: IModel) {
  if (model.category !== 'llm') {
    throw new InvalidRequestError('Model is not configured for chat completions');
  }
}

/** True when the caller (or the model's defaults) asked for a JSON document. */
function wantsJsonOutput(responseFormat: unknown): boolean {
  const type = (responseFormat as { type?: unknown } | undefined)?.type;
  return type === 'json_object' || type === 'json_schema';
}

// ── Replica pool ──────────────────────────────────────────────────────────

/**
 * The replica detail carried on a usage row. Absent for an unpooled model, so
 * existing rows and dashboards are untouched until someone adds a replica.
 */
function replicaTrace(
  model: IModel,
  replica: ResolvedReplica,
  failed: readonly ResolvedReplica[] = [],
): Record<string, unknown> | undefined {
  const pooled = Array.isArray(model.replicas) && model.replicas.length > 0;
  if (!pooled) return undefined;
  return {
    replica: {
      index: replica.index,
      providerKey: replica.providerKey,
      modelId: replica.modelId,
      ...(replica.label ? { label: replica.label } : {}),
      ...(failed.length > 0
        ? { failedOver: failed.map((entry) => `${entry.providerKey}:${entry.modelId}`) }
        : {}),
    },
  };
}

/**
 * Runs one call across a model's replica pool.
 *
 * Each replica is a full attempt: its own parameter resolution (drivers differ,
 * so the set of parameters an upstream rejects differs with them), its own
 * runtime, and its own circuit breaker. A capacity or availability fault moves
 * to the next replica; the caller's own mistakes do not travel, because a 400
 * fails identically everywhere and retrying it only multiplies the bill.
 *
 * `attempt` is handed the model AS THAT REPLICA - `providerKey`, `modelId` and
 * merged `settings` already swapped - so nothing downstream has to know a pool
 * exists.
 */
async function runAcrossReplicas<T>(
  model: IModel,
  prefix: 'chat' | 'chat-stream',
  attempt: (activeModel: IModel, replica: ResolvedReplica) => Promise<T>,
): Promise<{ value: T; replica: ResolvedReplica; failed: ResolvedReplica[] }> {
  const order = replicaOrder(model, prefix);
  const failed: ResolvedReplica[] = [];
  let lastError: unknown;

  for (let i = 0; i < order.length; i += 1) {
    const replica = order[i];
    try {
      const value = await attempt(modelForReplica(model, replica), replica);
      if (failed.length > 0) {
        logger.info('Replica failover succeeded', {
          modelKey: model.key,
          served: `${replica.providerKey}:${replica.modelId}`,
          skipped: failed.map((entry) => `${entry.providerKey}:${entry.modelId}`),
        });
      }
      return { value, replica, failed };
    } catch (error) {
      lastError = error;
      const isLast = i === order.length - 1;
      if (isLast || !shouldTryNextReplica(error)) throw error;
      failed.push(replica);
      logger.warn('Replica failed, trying the next one', {
        modelKey: model.key,
        replica: `${replica.providerKey}:${replica.modelId}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError;
}

/**
 * Circuit-breaker key for a chat call.
 *
 * Scoped to the MODEL, not just the provider. One Model Hub entry can be broken
 * on its own - a model id the upstream rejects, a response shape that fails to
 * parse - and a provider-wide key let that one model trip the breaker for every
 * other model behind the same credentials, which then answered `503 Circuit
 * breaker is open` for requests that would have succeeded. A genuine provider
 * outage still trips, once per model in use, which is what the breaker is for.
 */
function chatResilienceKey(prefix: 'chat' | 'chat-stream', tenantDbName: string, model: IModel): string {
  // Tenant-scoped: the breaker map is process-global and provider keys are tenant-chosen names.
  return `${prefix}:${tenantDbName}:${model.providerKey}:${model.modelId}`;
}

// ── Input guardrails: once per turn ───────────────────────────────────────

interface InputGuardrailVerdict {
  redactedText?: string;
  results: Array<{ guardrail_key: string; findings: unknown[] }>;
}

const TURN_CACHE_MAX = 512;
const TURN_CACHE_TTL_MS = 15 * 60 * 1000;
const turnGuardrailVerdicts = new Map<string, { at: number; verdict: InputGuardrailVerdict }>();

function turnCacheKey(parts: string[], text: string): string {
  return `${parts.join('\u0000')}\u0000${crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

function rememberTurnVerdict(key: string, verdict: InputGuardrailVerdict): void {
  const now = Date.now();
  if (turnGuardrailVerdicts.size >= TURN_CACHE_MAX) {
    for (const [existing, entry] of turnGuardrailVerdicts) {
      if (now - entry.at > TURN_CACHE_TTL_MS || turnGuardrailVerdicts.size >= TURN_CACHE_MAX) turnGuardrailVerdicts.delete(existing);
      if (turnGuardrailVerdicts.size < TURN_CACHE_MAX / 2) break;
    }
  }
  turnGuardrailVerdicts.set(key, { at: now, verdict });
}

// ── Native request of one call ────────────────────────────────────────────

/** Fields of an OpenAI request that are not functions: forwarded verbatim to OpenAI-schema upstreams. */
function hasNonFunctionTools(tools: unknown): boolean {
  return Array.isArray(tools) && tools.some((tool) => asRecord(tool).type !== 'function' || !asRecord(tool).function);
}

/**
 * The request a replica's native client receives. Sampling, the token limit and
 * the reasoning are NOT here: they live in the model settings the client is built
 * from (request values already folded in, the Model Hub rules applied), and the
 * client fills them in. What goes here is what is per call: messages, tools,
 * tool choice, response format, stop, seed, and the few wire facts only an
 * OpenAI-schema upstream can take verbatim.
 */
const KNOWN_PART_TYPES = new Set(['text', 'image', 'file', 'audio']);

/**
 * The messages a provider receives. An OpenAI-schema upstream gets an image's
 * `detail` hint and any part type this gateway does not know exactly as the
 * caller wrote them (the SDK forwards an unrecognised part untouched); a provider
 * with its own schema cannot read an unknown part, so it is dropped there.
 */
function messagesFor(client: NativeChatClient, messages: UnifiedMessage[]): UnifiedMessage[] {
  const openAiSchema = OPENAI_SCHEMA_DRIVERS.has(client.driver);
  return messages.map((message) => {
    if (typeof message.content === 'string') return message;
    const parts = message.content.flatMap((part): ContentPart[] => {
      if (!KNOWN_PART_TYPES.has(part.type)) return openAiSchema ? [part] : [];
      if (openAiSchema && part.type === 'image' && (part as ImagePartWithDetail).detail) {
        return [imagePartToOpenAi(part as ImagePartWithDetail) as unknown as ContentPart];
      }
      return [part];
    });
    return { ...message, content: parts };
  });
}

function buildNativeCall(
  client: NativeChatClient,
  request: GatewayChatRequest,
  wire: AnyRecord,
): NativeChatRequest {
  const out: NativeChatRequest = { messages: messagesFor(client, request.messages) };
  if (request.tools?.length) out.tools = request.tools;
  if (request.toolChoice !== undefined) out.toolChoice = request.toolChoice;
  if (request.responseFormat) out.responseFormat = request.responseFormat;
  if (request.stop) out.stop = request.stop;
  if (request.seed !== undefined) out.seed = request.seed;
  if (request.parallelToolCalls !== undefined) out.parallelToolCalls = request.parallelToolCalls;

  if (OPENAI_SCHEMA_DRIVERS.has(client.driver)) {
    const extra: AnyRecord = {};
    // The SDK pins `strict: true` on a json_schema it builds itself; the caller's
    // own `response_format` (strict or not, with any extra keys, of any type) goes
    // through verbatim.
    if (wire.response_format !== undefined) extra.response_format = wire.response_format;
    if (hasNonFunctionTools(wire.tools)) {
      const functions = new Map((request.tools ?? []).map((tool) => [tool.name, tool]));
      extra.tools = (wire.tools as unknown[]).map((tool) => {
        const fn = asRecord(asRecord(tool).function);
        const native = typeof fn.name === 'string' ? functions.get(fn.name) : undefined;
        if (!native) return tool;
        return {
          type: 'function',
          function: {
            name: native.name,
            description: native.description,
            parameters: native.parameters,
            ...(native.strict !== undefined ? { strict: native.strict } : {}),
          },
        };
      });
    }
    const modalities = wire.modality;
    if (modalities !== undefined) extra.modalities = Array.isArray(modalities) ? modalities : [modalities];
    if (Object.keys(extra).length > 0) out.extra = extra;
  }
  return out;
}

async function* replayAsStream(response: ChatCompletionResponse): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  yield {
    id: response.id,
    model: response.model,
    delta: {
      ...(response.content ? { content: response.content } : {}),
      ...(response.toolCalls.length > 0
        ? { toolCalls: response.toolCalls.map((call, index) => ({ ...call, index })) }
        : {}),
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    },
    usage: response.usage,
    finishReason: response.finishReason,
    rawFinishReason: response.rawFinishReason ?? response.finishReason,
    ...(response.providerFields ? { providerFields: response.providerFields } : {}),
  };
}

async function* withFirst(
  first: IteratorResult<ChatCompletionChunk, void>,
  rest: AsyncGenerator<ChatCompletionChunk, void, unknown>,
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  try {
    if (first.done) return;
    yield first.value;
    for (;;) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rest.return?.(undefined);
  }
}

function mergeReasoning(reasoning: ReasoningPayload | undefined, inline: string | undefined): ReasoningPayload | undefined {
  if (!inline) return reasoning;
  const known = reasoning?.summary ?? '';
  return { ...(reasoning ?? {}), summary: `${known}${inline}` };
}

// ── The call ──────────────────────────────────────────────────────────────

interface CallState {
  input: ModelCallInput;
  tenantDbName: string;
  tenantId?: string;
  projectId: string;
  modelKey: string;
  model: IModel;
  request: GatewayChatRequest;
  wire: AnyRecord;
  requestId: string;
  start: number;
  route: string;
  routedByLog: AnyRecord;
  attribution?: Partial<UsageAttribution>;
  context: NonNullable<ModelCallInput['context']>;
  invocationBody: AnyRecord;
  cacheEnabled: boolean;
  cacheVariantKey: string;
  outputGuardrailKeys: string[];
  guardrailAnnotations: Record<string, GuardrailAnnotation>;
  includeReasoning: boolean;
  /** What a usage row records of the prompt: the messages, or just their count when the caller opted out (`logPrompt: false`). */
  loggedMessages: unknown;
}

/** The caller's tags ride along on every usage row's request. */
function loggedRequest(state: CallState, request: unknown): unknown {
  const { requestTags } = state.context;
  return requestTags ? { ...asRecord(request), ...requestTags } : request;
}

/** The agent a call runs for (agent runs set it on the caller context and the request tags). */
function callerAgentKey(state: CallState): string | undefined {
  const fromTags = state.context.requestTags?.agentKey;
  const key = state.context.callerContext?.agentKey ?? fromTags;
  return typeof key === 'string' && key ? key : undefined;
}

function usageRow(state: CallState, label: string, payload: Parameters<typeof logModelUsage>[2]) {
  fireAndForget(label, () =>
    logModelUsage(state.tenantDbName, state.model, {
      ...payload,
      providerRequest: loggedRequest(state, payload.providerRequest),
      ...state.routedByLog,
      ...(state.attribution ? { attribution: state.attribution } : {}),
      ...(callerAgentKey(state) ? { agentKey: callerAgentKey(state) } : {}),
      ...(state.context.callerContext?.channel ? { channel: state.context.callerContext.channel } : {}),
      // A snapshot: the run fills its attribution in as it goes, and the row says what was known when the call settled.
      ...(state.context.callerContext?.run ? { run: { ...state.context.callerContext.run } } : {}),
    } as Parameters<typeof logModelUsage>[2]),
  );
}

/** Everything needed to place ONE call, resolved for the replica that will serve it. */
async function prepareCall(state: CallState, activeModel: IModel) {
  const { runtime } = await buildModelRuntime(
    state.tenantDbName,
    activeModel.tenantId,
    activeModel.providerKey,
    state.projectId,
  );

  if (!runtime.createNativeChatClient) {
    throw new InvalidRequestError('Model provider does not support chat completions');
  }

  // Per replica rather than per request: the parameter registry is keyed on
  // driver AND model id, so a pool spanning Azure and Bedrock strips (and
  // forces) different fields on each leg, and the runtime is built from the
  // replica's own provider credentials. The cache variant key and the quota
  // context are resolved once from the pool model - a pool must not fork the
  // cache or split a budget.
  const call = resolveModelInvocationConfig(activeModel, state.invocationBody);
  const { overrides } = call;
  // `extraBody` is the sanitized merge of the operator's request defaults and the
  // caller's passthrough (reserved keys removed). The raw `requestDefaults` stays
  // out of the client's settings: the client would fall back to it, unsanitized.
  const modelSettings: Record<string, unknown> = { ...call.modelSettings, requestDefaults: undefined };
  // Thought text is requested from the provider only when someone will see it.
  const visibleReasoning = withReasoningVisibility(
    normalizeNativeReasoning(modelSettings.reasoning),
    state.includeReasoning,
    activeModel.providerDriver,
    supportsUpstreamApiChoice(activeModel.providerDriver) ? resolveUpstreamApi(activeModel.settings) : undefined,
  );
  if (visibleReasoning) modelSettings.reasoning = visibleReasoning;
  // The resolved invocation settings are a fresh object (sampling, limits, reasoning):
  // the model's Upstream API choice has to be carried over for the provider spec.
  if (supportsUpstreamApiChoice(activeModel.providerDriver)) modelSettings.upstreamApi = resolveUpstreamApi(activeModel.settings);
  const outputTokenLimit = resolveOutputTokenLimit(overrides, modelSettings);

  const client = await runtime.createNativeChatClient({
    modelId: activeModel.modelId,
    category: activeModel.category,
    modelSettings,
    // `withResilience` owns retry and circuit-breaking on this path, so the
    // provider must not retry underneath it.
    options: { maxRetries: 0 },
  });

  return {
    client,
    request: buildNativeCall(client, state.request, state.wire),
    modelSettings,
    overrides,
    outputTokenLimit,
    // A model behind an upstream that cannot stream tool calls (opt-in per model).
    disableProviderStreaming: Boolean(
      state.input.stream
      && modelSettings.disableStreamingWithTools === true
      && (state.request.tools?.length ?? 0) > 0,
    ),
    includeStreamUsage: asRecord(overrides.stream_options).include_usage === true,
  };
}

type Prepared = Awaited<ReturnType<typeof prepareCall>>;

/**
 * The semantic cache keys an entry on the LAST USER message (plus the variant
 * key); the system prompt, the tool list and everything after that message are
 * not part of it. That is right for a plain question and wrong the moment the
 * answer depends on more than the question: step 2 of a tool loop shares step
 * 1's last user text, so a hit would replay step 1's tool call forever, and two
 * agents with different system prompts would trade answers. Such calls bypass the
 * cache: anything that offers tools, replays tool turns, or comes from an agent.
 */
function isCacheableConversation(request: ModelCallInput['request'], wire: AnyRecord, route: string): boolean {
  if (route.startsWith('agent.')) return false;
  if ((request.tools?.length ?? 0) > 0) return false;
  if (Array.isArray(wire.tools) && wire.tools.length > 0) return false;
  if (Array.isArray(wire.functions) && wire.functions.length > 0) return false;
  const turns = [
    ...(request.messages as unknown as Array<{ role?: string; toolCalls?: unknown[] }>),
    ...(Array.isArray(wire.messages) ? (wire.messages as Array<{ role?: string; tool_calls?: unknown[] }>) : []),
  ] as Array<{ role?: string; toolCalls?: unknown[]; tool_calls?: unknown[] }>;
  return !turns.some(
    (turn) =>
      turn?.role === 'tool'
      || turn?.role === 'function'
      || (turn?.toolCalls?.length ?? 0) > 0
      || (turn?.tool_calls?.length ?? 0) > 0,
  );
}

export async function executeModelCall(input: ModelCallInput): Promise<ModelCallOutcome> {
  const { tenantDbName, tenantId, modelKey, projectId, stream } = input;
  const context = input.context ?? {};
  let { request } = input;

  if (!Array.isArray(request?.messages)) {
    throw new Error('`messages` array is required');
  }

  let wire: AnyRecord = input.wire ?? nativeRequestToWire(request, { streamUsage: true });
  const requestId =
    request.requestId
    || (typeof wire.request_id === 'string' && wire.request_id.length > 0 ? wire.request_id : crypto.randomUUID());
  const start = Date.now();
  // Dynamic LLM attribution: rows this call writes carry the router decision
  // that caused them (and the baseline pricing to measure savings against).
  const routedByLog = context.routedBy
    ? { routing: context.routedBy.routing, routingBaselinePricing: context.routedBy.baselinePricing }
    : {};

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  // Dynamic LLM: this model owns no provider - it routes to a concrete child
  // model. Resolve and recurse before any provider/runtime work happens.
  const dynamicConfig = getDynamicRoutingConfig(model);
  if (dynamicConfig) {
    const depth = context.routingDepth ?? 0;
    if (depth >= MAX_ROUTING_DEPTH) {
      throw new Error(
        `Dynamic routing depth exceeded (${MAX_ROUTING_DEPTH}) resolving model "${modelKey}"`,
      );
    }
    return resolveDynamicCompletion({
      input: { ...input, wire },
      wire,
      router: model,
      config: dynamicConfig,
      depth,
      execute: executeModelCall,
    });
  }

  ensureLlmModel(model);

  const route = context.route ?? 'chat.completions';

  // Input guardrails: check the latest user message before calling the model.
  // Non-blocking findings (warn/flag) are surfaced on the response; redact
  // findings rewrite the user message before it reaches the provider, and chain
  // through the rest of the bound guardrails.
  const guardrailAnnotations: Record<string, GuardrailAnnotation> = {};
  const inputGuardrailKeys = resolveBindings(model, 'input.pre');
  if (inputGuardrailKeys.length > 0) {
    const latest = latestUserTextNative(request.messages);
    // A caller that calls the model repeatedly inside one turn (an agent's tool
    // loop) names the turn: the same message is adjudicated once, and its
    // redaction is re-applied to the later steps, whose history still carries the
    // original text.
    const turnKey = context.guardrailTurnKey
      ? turnCacheKey([tenantDbName, model.key, context.guardrailTurnKey], latest)
      : undefined;
    let verdict: InputGuardrailVerdict | undefined = turnKey ? turnGuardrailVerdicts.get(turnKey)?.verdict : undefined;
    if (!verdict) {
      verdict = await enforceModelGuardrailChain({
        tenantDbName,
        tenantId: model.tenantId,
        projectId,
        guardrailKeys: inputGuardrailKeys,
        text: latest,
        phase: 'input',
        requestId,
        source: route,
      });
      if (turnKey) rememberTurnVerdict(turnKey, verdict);
    }
    if (verdict.redactedText !== undefined) {
      request = { ...request, messages: replaceLatestUserTextNative(request.messages, verdict.redactedText) };
      wire = { ...wire, messages: replaceLatestUserText(wire.messages, verdict.redactedText) };
    }
    const annotation = foldGuardrailAnnotation(verdict.results);
    if (annotation) guardrailAnnotations.input = annotation;
  }

  // The agent's own reasoning pick rides beside the wire body, not in it: it
  // outranks the Model Hub default, which a caller's JSON can never claim.
  const invocationBody: AnyRecord = { ...wire };
  if (context.reasoningOverride !== undefined) {
    (invocationBody as { [AGENT_REASONING_OVERRIDE]?: unknown })[AGENT_REASONING_OVERRIDE] = context.reasoningOverride;
  }

  // Resolved before the cache lookup on purpose: the sampling parameters, the
  // RESOLVED reasoning and any passthrough body fields change what the model
  // produces from the same prompt, so they have to take part in the cache key.
  const invocation = resolveModelInvocationConfig(model, invocationBody);
  const resolvedReasoning = invocation.modelSettings.reasoning;

  // THE OUTPUT POLICY IS PART OF THE CACHE KEY. What gets cached is the
  // response AFTER the `output.pre` chain, so an entry is only valid for a
  // caller under the SAME output policy: a model whose binding changed, or a
  // model with no output guardrail at all, must not be served a hit that was
  // redacted - or NOT redacted - under a different one. Keyed on the
  // guardrail's `policyVersion` (`key@updatedAt`) when the record is cheaply
  // available, so an edit to a policy also retires the entries produced under
  // the old one.
  const outputGuardrailKeys = resolveBindings(model, 'output.pre');
  const includeReasoning = shouldReturnReasoning(model.settings, wire) && context.showReasoning !== false;
  const cacheEnabled = Boolean(
    !stream && tenantId && isSemanticCacheEnabled(model) && isCacheableConversation(request, wire, route),
  );
  const cacheVariantKey = buildCacheVariantKey({
    ...invocation.overrides,
    ...(invocation.extraBody ?? {}),
    // The reasoning the call really runs with: the agent's pick or the Model Hub
    // default can differ from what the request carries, and so can the answer.
    ...(resolvedReasoning ? { __reasoning: resolvedReasoning } : {}),
    // The cached wire response is stored AS RENDERED, so whether it carries
    // `reasoning_content` is part of what an entry is: a hit must never show
    // text the operator (or this caller) hid, nor hide what a caller asked for.
    __returnReasoning: includeReasoning,
    ...(cacheEnabled
      ? { __outputGuardrails: await outputGuardrailPolicyVersions(tenantDbName, projectId, outputGuardrailKeys) }
      : {}),
  });

  const state: CallState = {
    input,
    tenantDbName,
    tenantId,
    projectId,
    modelKey,
    model,
    request,
    wire,
    requestId,
    start,
    route,
    routedByLog,
    attribution: context.attribution,
    context,
    invocationBody,
    cacheEnabled,
    cacheVariantKey,
    outputGuardrailKeys,
    guardrailAnnotations,
    includeReasoning,
    loggedMessages: context.logPrompt === false
      ? { count: Array.isArray(wire.messages) ? wire.messages.length : 0 }
      : wire.messages,
  };

  // Semantic cache: check for cached response before calling the model
  if (cacheEnabled && model.semanticCache) {
    try {
      const cacheResult = await lookupCache({
        tenantDbName,
        tenantId: tenantId as string,
        projectId,
        config: model.semanticCache,
        messages: wire.messages as unknown[],
        variantKey: cacheVariantKey,
      });

      if (cacheResult.hit && cacheResult.response) {
        const latencyMs = Date.now() - start;

        usageRow(state, 'log-cache-hit', {
          requestId,
          route,
          status: 'success',
          providerRequest: sanitizeForLogging({
            model: modelKey,
            messages: state.loggedMessages,
            stream: false,
            ...describeRequestContract(wire),
          }),
          providerResponse: sanitizeForLogging(cacheResult.response),
          latencyMs,
          usage: {},
          cacheHit: true,
        });

        const cached = openAiResponseToNative(cacheResult.response);
        return {
          requestId,
          wire: cacheResult.response,
          result: {
            response: cached.response,
            guardrails: cached.guardrails,
            wireFinishReason: cached.wireFinishReason,
          },
          usage: {} as TokenUsage,
          latencyMs,
          cacheHit: true,
          wireModel: model.modelId,
          includeReasoning: state.includeReasoning,
        };
      }
    } catch (cacheError) {
      logger.warn('Cache lookup error, proceeding with model', { error: cacheError });
    }
  }

  try {
    return await (stream ? openStream(state) : completeOnce(state));
  } catch (error) {
    logFailedCall(state, error);
    throw error;
  }
}

/**
 * A call that ends in an exception before any usage was written. A caller that walked
 * away (its `signal` aborted) is `cancelled`, never a fault; any other failure is an
 * `error` row only for a caller that asked for it (`logFailures`). A guardrail block
 * has its own record already.
 */
function logFailedCall(state: CallState, error: unknown): void {
  if (error instanceof GuardrailBlockError) return;
  const cancelled = Boolean(state.context.signal?.aborted);
  if (!cancelled && !state.context.logFailures) return;
  const message = error instanceof Error ? error.message : String(error);
  usageRow(state, cancelled ? 'log-call-cancelled' : 'log-call-error', {
    requestId: state.requestId,
    route: state.route,
    status: cancelled ? 'cancelled' : 'error',
    providerRequest: sanitizeForLogging({ model: state.modelKey, messages: state.loggedMessages, stream: Boolean(state.input.stream) }),
    providerResponse: sanitizeForLogging(cancelled ? { cancelled: 'client_disconnected' } : { error: message }),
    ...(cancelled ? {} : { errorMessage: message }),
    latencyMs: Date.now() - state.start,
    usage: {},
  });
}

// ── Non-streamed call ─────────────────────────────────────────────────────

async function completeOnce(state: CallState): Promise<ModelCallOutcome> {
  const { model, context, wire, requestId, modelKey, tenantDbName, projectId, tenantId } = state;

  const completed = await runAcrossReplicas(model, 'chat', async (candidate) => {
    const prepared = await prepareCall(state, candidate);
    const response = await withResilience(
      (signal) => prepared.client.complete({ ...prepared.request, signal }),
      {
        key: chatResilienceKey('chat', tenantDbName, candidate),
        ...(context.signal ? { signal: context.signal } : {}),
      },
    );
    return { prepared, response };
  });

  const servingReplica = completed.replica;
  const { prepared, response: native } = completed.value;
  const { overrides, outputTokenLimit, client } = prepared;
  const latencyMs = Date.now() - state.start;

  // Upstreams that leave a reasoning model's chain-of-thought inside `content`
  // (Bedrock's `/openai/v1` gpt-oss shim, some vLLM builds) would otherwise hand
  // the caller `<reasoning>...</reasoning>{"answer":1}` as the answer. Splitting
  // is idempotent: content the fetch-level normalization already cleaned has no
  // tag left to find.
  const rawText = native.content ?? '';
  const split = splitInlineReasoning(rawText);
  let finalResponse: ChatCompletionResponse = {
    ...native,
    content: split.content.length > 0 ? split.content : null,
    ...(mergeReasoning(native.reasoning, split.reasoning)
      ? { reasoning: mergeReasoning(native.reasoning, split.reasoning) }
      : {}),
  };

  // JSON mode is a contract: the caller asked for a parseable document and is
  // going to `JSON.parse` whatever comes back. Some providers break it anyway -
  // Bedrock's `/openai/v1` gpt-oss path splices a stray brace or a truncated
  // prose answer in front of the payload under `response_format`. Recover the
  // model's own JSON bytes rather than handing the caller something it asked
  // not to receive. A response that already parses is never touched.
  if (wantsJsonOutput(overrides.response_format ?? wire.response_format) || (state.request.responseFormat && wantsJsonOutput(state.request.responseFormat))) {
    const content = finalResponse.content;
    if (typeof content === 'string' && content.length > 0) {
      const { content: repairedContent, repaired } = repairJsonContent(content);
      if (repaired) {
        finalResponse = { ...finalResponse, content: repairedContent };
        logger.warn('Repaired malformed JSON-mode response from provider', {
          requestId,
          modelKey,
          providerDriver: model.providerDriver,
          discardedPrefix: content.slice(0, content.indexOf(repairedContent)).slice(0, 120),
        });
      }
    }
  }

  if (
    native.finishReason === 'length'
    && !guardrailContentToText(rawText).trim()
    && native.toolCalls.length === 0
  ) {
    throw new OutputTokenLimitError(outputTokenLimit);
  }

  const usage = toGatewayUsage(client.driver, native.usage);
  if (native.toolCalls.length > 0) usage.toolCalls = native.toolCalls.length;
  const wireFinish = finishWithToolCalls(
    client.driver,
    wireFinishReason(client.driver, native.rawFinishReason, native.finishReason),
    native.toolCalls.length > 0,
  );

  const wireResponse = toOpenAIChatResponse(finalResponse, {
    // The MODEL's id, never the replica's: the caller asked for this model and
    // must not be able to tell which deployment answered.
    model: model.modelId,
    usage,
    wireFinishReason: wireFinish,
    includeReasoning: state.includeReasoning,
  });

  context.onUsageSettled?.(calculateCost(model.pricing, usage), usage);

  usageRow(state, 'log-chat-usage', {
    requestId,
    route: state.route,
    status: 'success',
    providerRequest: sanitizeForLogging({
      model: modelKey,
      messages: state.loggedMessages,
      overrides,
      stream: false,
      ...describeRequestContract(wire),
      ...replicaTrace(model, servingReplica, completed.failed),
    }),
    providerResponse: sanitizeForLogging(wireResponse),
    latencyMs,
    usage,
    cacheHit: false,
    finishReason: wireFinish,
  });

  // Output guardrails: check the assistant response before returning it
  // (streamed responses are gated in real time and audited post-hoc after the
  // stream completes). `outputGuardrailKeys` was resolved before the cache
  // lookup, because it is part of the cache key.
  let finalWire: AnyRecord = wireResponse;
  if (state.outputGuardrailKeys.length > 0) {
    const outputOutcome = await enforceModelGuardrailChain({
      tenantDbName,
      tenantId: model.tenantId,
      projectId,
      guardrailKeys: state.outputGuardrailKeys,
      text: finalResponse.content ?? '',
      phase: 'output',
      requestId,
      source: state.route,
    });
    if (outputOutcome.redactedText !== undefined) {
      finalResponse = { ...finalResponse, content: outputOutcome.redactedText };
      const withChoices = finalWire as { choices?: Array<{ message?: AnyRecord }> };
      if (withChoices.choices?.[0]?.message) {
        finalWire = {
          ...withChoices,
          choices: withChoices.choices.map((choice, index) =>
            index === 0 && choice.message
              ? { ...choice, message: { ...choice.message, content: outputOutcome.redactedText } }
              : choice,
          ),
        };
      }
    }
    const annotation = foldGuardrailAnnotation(outputOutcome.results);
    if (annotation) state.guardrailAnnotations.output = annotation;
  }

  finalWire = annotateResponseWithGuardrails(finalWire, state.guardrailAnnotations) as AnyRecord;

  // Semantic cache: store the response for future lookups - the FINAL one,
  // redacted and annotated, never the raw provider message. A cache hit returns
  // before any output guardrail runs, so a raw entry would hand the next
  // semantically-similar caller the exact text the guardrail removed - with
  // `cacheHit: true` and no evaluation row. The variant key carries the output
  // policy, so the entry is only ever served under the policy that produced it.
  if (state.cacheEnabled && tenantId && model.semanticCache) {
    storeInCache({
      tenantDbName,
      tenantId,
      projectId,
      config: model.semanticCache,
      messages: wire.messages as unknown[],
      response: finalWire,
      variantKey: state.cacheVariantKey,
    }).catch((err) => logger.warn('Failed to store response in cache', { error: err }));
  }

  return {
    requestId,
    wire: finalWire,
    result: {
      response: finalResponse,
      guardrails: state.guardrailAnnotations,
      wireFinishReason: wireFinish,
    },
    usage,
    latencyMs,
    cacheHit: false,
    wireModel: model.modelId,
    includeReasoning: state.includeReasoning,
  };
}

// ── Streamed call ─────────────────────────────────────────────────────────

async function openStream(state: CallState): Promise<ModelCallOutcome> {
  const { model, context, tenantDbName, projectId, requestId } = state;

  // Aborting THIS controller is how the core ends the upstream on its own
  // initiative (a guardrail block). The caller's own signal is separate: that one
  // means "the caller walked away", which is logged as a cancellation.
  const blockCtl = new AbortController();

  // FAILOVER ENDS HERE. Opening the stream is the last moment a different
  // replica can serve this request: once a byte has reached the client, the
  // answer is half-written and retrying elsewhere would splice two different
  // completions together. So the pool covers connection and handshake
  // failures (the first provider event is awaited inside the attempt), and a
  // mid-stream fault stays a mid-stream fault.
  const opened = await runAcrossReplicas(model, 'chat-stream', async (activeModel) => {
    const prepared = await prepareCall(state, activeModel);

    if (prepared.disableProviderStreaming) {
      const response = await withResilience(
        (signal) => prepared.client.complete({ ...prepared.request, signal }),
        {
          key: chatResilienceKey('chat', state.tenantDbName, activeModel),
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
      const gen = replayAsStream(response);
      return { activeModel, prepared, gen, first: await gen.next() };
    }

    const { gen, first } = await withResilience(
      async (signal) => {
        // The resilience timeout, the caller's cancellation and the core's own
        // abort all end the upstream request; a retry gets a fresh attempt signal.
        const signals = [signal, blockCtl.signal, ...(context.signal ? [context.signal] : [])];
        const generator = prepared.client.stream({ ...prepared.request, signal: AbortSignal.any(signals) });
        return { gen: generator, first: await generator.next() };
      },
      {
        key: chatResilienceKey('chat-stream', state.tenantDbName, activeModel),
        ...(context.signal ? { signal: context.signal } : {}),
      },
    );
    return { activeModel, prepared, gen, first };
  });

  const completionId = newCompletionId();
  const created = Math.floor(Date.now() / 1000);

  // ── Real-time streaming enforcement ──────────────────────────────────────
  // The gate withholds a streamed answer behind a release frontier, adjudicates
  // a window that overlaps what was already released - so a secret split across
  // two provider chunks is still caught - and only then lets the characters out.
  //
  // Only the DETERMINISTIC families run per window; the gate enforces that
  // itself. The LLM judge and the webhook family stay post-hoc, because a 4K
  // answer is ~17 windows and nobody wants 17 judge calls on the token path.
  //
  // `audit: false` because `auditStreamedOutput` still owns the terminal
  // `output.pre` pass on every exit - success, block and client hang-up alike.
  // Nothing is gated when the model binds no guardrail to the stream hook.
  //
  // The two hooks are resolved SEPARATELY because a multi-binding model can
  // scope a guardrail to the real-time gate and not to the terminal audit, or
  // the other way round.
  const streamGuardrailKeys = resolveBindings(model, 'output.stream.delta');
  const auditGuardrailKeys = resolveBindings(model, 'output.pre');

  const streamHeaders: Record<string, string> = {};
  const gate = streamGuardrailKeys.length > 0
    ? createStreamGate({
      scope: {
        tenantId: model.tenantId,
        tenantDbName,
        projectId,
        actor: gatewayActor(),
        surface: 'gateway',
        source: `${state.route}:stream`,
        requestId,
        // The evaluation log has no traceId column; this ties one stream's
        // window verdicts together and fills the block message's {{traceId}}.
        traceId: requestId,
      } satisfies HookScope,
      guardrailKeys: streamGuardrailKeys,
      // The gate cannot forward the provider's own chunk once it has delayed or
      // rewritten that chunk's content, so it asks for the envelope those
      // characters should arrive in.
      makeChunk: (text: string) => openAIStreamDeltaChunk(
        { model: model.modelId, completionId, created },
        { content: text },
      ),
      audit: false,
    })
    : null;

  const generator = streamEvents({
    state,
    opened,
    blockCtl,
    gate,
    streamGuardrailKeys,
    auditGuardrailKeys,
    streamHeaders,
    completionId,
    created,
  });

  return {
    requestId,
    stream: generator,
    streamHeaders,
    wireModel: model.modelId,
    includeReasoning: state.includeReasoning,
    wireCompletion: { id: completionId, created },
  };
}

type OpenedStream = {
  activeModel: IModel;
  prepared: Prepared;
  gen: AsyncGenerator<ChatCompletionChunk, void, unknown>;
  first: IteratorResult<ChatCompletionChunk, void>;
};

async function* streamEvents(args: {
  state: CallState;
  opened: { value: OpenedStream; replica: ResolvedReplica; failed: ResolvedReplica[] };
  blockCtl: AbortController;
  gate: ReturnType<typeof createStreamGate> | null;
  streamGuardrailKeys: string[];
  auditGuardrailKeys: string[];
  streamHeaders: Record<string, string>;
  completionId: string;
  created: number;
}): AsyncGenerator<ModelStreamEvent, void, void> {
  const { state, opened, blockCtl, gate, streamGuardrailKeys, auditGuardrailKeys, streamHeaders, completionId, created } = args;
  const { model, context, tenantDbName, projectId, requestId, wire, modelKey } = state;
  const { prepared } = opened.value;
  const { overrides, outputTokenLimit, includeStreamUsage, client } = prepared;
  const driver = client.driver;
  const servingReplica = opened.replica;
  const external = context.signal;
  const startedAt = Date.now();

  const assembler = new StreamAssembler();
  // Upstreams that leak a reasoning model's chain-of-thought into `content`
  // (Bedrock's `/openai/v1` gpt-oss shim among them) do it across delta
  // boundaries, so one splitter carries the state for this whole completion.
  const splitter = createInlineReasoningSplitter();
  const gateFramer = gate ? new OpenAiStreamFramer({ model: model.modelId, completionId, created }) : null;

  let emittedContent = '';
  let inlineReasoning = '';
  let pendingFinish: string | undefined;
  let hasFinalOutput = false;
  let outputLimitError: OutputTokenLimitError | null = null;
  /** True once gated characters actually reached the caller. */
  let releasedGatedText = false;

  const toolCallCount = () => assembler.toolCallCount || undefined;
  const emptyNativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0 };

  // A cancelled stream almost never carries provider usage: the counts ride on
  // the terminal chunk, which is precisely the chunk the client did not stay for.
  // Reporting zero there writes off output the provider generated and bills us
  // for, so fall back to an estimate over the text we did stream - the same
  // chars/4 rule the quota pre-flight uses. The log marks it
  // `output_tokens_estimated` so a measured count and a guessed one stay
  // distinguishable downstream. Input tokens are never guessed.
  const partialUsage = (): TokenUsage => {
    if (assembler.usage) return { ...toGatewayUsage(driver, assembler.usage), toolCalls: toolCallCount() };
    const outputTokens = estimateTokensFromText(assembler.content);
    return { outputTokens, totalTokens: outputTokens, toolCalls: toolCallCount() };
  };

  const partialMessage = () => ({
    role: 'assistant',
    content: assembler.content || null,
    ...(assembler.toolCallCount > 0
      ? {
        tool_calls: assembler.toolCalls().map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }
      : {}),
    ...(assembler.reasoningSummary ? { reasoning_content: assembler.reasoningSummary } : {}),
  });

  // Output guardrails (streaming): the text has already reached the client, so
  // this is a post-hoc audit - violations land in the evaluation log and alert
  // metrics rather than blocking the stream. It runs on a cancelled stream too:
  // those tokens were delivered, and auditing only completed answers would let a
  // caller skip the audit by hanging up.
  //
  // One evaluation row PER BOUND GUARDRAIL; a legacy row still produces exactly
  // one. They are started together rather than in sequence because these are
  // independent audits: `evaluateGuardrail` throws for a key whose record is
  // gone, and a sequential loop would let that one misconfiguration erase the
  // audit trail of every guardrail behind it.
  const auditStreamedOutput = (source: string) => {
    if (auditGuardrailKeys.length === 0) return;
    const streamedText = guardrailContentToText(assembler.content);
    if (!streamedText.trim()) return;

    fireAndForget('guardrail-stream-output-audit', async () => {
      await Promise.all(
        auditGuardrailKeys.map((guardrailKey) =>
          evaluateGuardrail({
            tenantDbName,
            tenantId: model.tenantId,
            projectId,
            guardrailKey,
            text: streamedText,
            phase: 'output',
            requestId,
            source,
          }),
        ),
      );
    });
  };

  const requestLog = (extra: AnyRecord = {}) => sanitizeForLogging({
    model: modelKey,
    messages: state.loggedMessages,
    overrides,
    stream: true,
    ...extra,
  });

  // The gate hands back the frames that are safe NOW: whatever it has cleared,
  // plus this step's non-content residual (tool-call deltas, finish_reason) in
  // order. It never throws.
  // The gate adjudicates OpenAI-shaped text frames, and that shape has no room for
  // what only a native consumer (the agent loop) needs: a Gemini tool call's
  // `thoughtSignature`, the provider's response fields. A frame it releases is
  // converted back to a native step, and those are put back from what the assembler
  // saw - a signature on the first released fragment of its call, the response
  // fields on the first released step - so a gated stream replays like an ungated one.
  const signatureSent = new Set<number>();
  let heldProviderFields: ProviderResponseFields | undefined;
  const restoreNativeExtras = (event: ModelStreamDelta): ModelStreamDelta => {
    let restored = event;
    if (event.toolCalls?.length) {
      restored = {
        ...restored,
        toolCalls: event.toolCalls.map((call) => {
          if (call.index === undefined || signatureSent.has(call.index)) return call;
          const thoughtSignature = assembler.thoughtSignatureAt(call.index);
          if (!thoughtSignature) return call;
          signatureSent.add(call.index);
          return { ...call, thoughtSignature };
        }),
      };
    }
    if (heldProviderFields) {
      restored = { ...restored, providerFields: heldProviderFields };
      heldProviderFields = undefined;
    }
    return restored;
  };

  const emit = async (
    step: ModelStreamDelta,
  ): Promise<{ events: ModelStreamEvent[]; blocked?: StreamGateEmission['verdict'] | null }> => {
    if (!gate || !gateFramer) return { events: [step] };
    if (step.providerFields) heldProviderFields = { ...(heldProviderFields ?? {}), ...step.providerFields };
    const frame = toGateFrame(step, gateFramer);
    if (!frame) return { events: [] };
    const gated = await gate.push(frame);
    const events = gated.emit.map((released) => {
      if (frameHasContent(released)) releasedGatedText = true;
      return restoreNativeExtras(fromGateFrame(released));
    });
    return gated.blocked ? { events, blocked: gated.verdict ?? null } : { events };
  };

  // Set the moment a window blocks; checked in the catch below BEFORE the
  // cancellation test - the block path aborts the upstream on purpose, so without
  // this a policy block would be filed as a client hang-up.
  let blockedByGuardrail = false;
  let blockVerdict: StreamGateEmission['verdict'] | null | undefined;
  let blockFinalized = false;
  let donePending = false;
  let settled = false;

  let exitedEarly = true;
  const settleCancelled = () => {
    settled = true;
    const latencyMs = Date.now() - startedAt;
    const cancelledUsage = partialUsage();
    context.onUsageSettled?.(calculateCost(model.pricing, cancelledUsage), cancelledUsage);
    usageRow(state, 'log-stream-cancelled', {
      requestId,
      route: state.route,
      status: 'cancelled',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        messages: state.loggedMessages,
        overrides,
        stream: true,
      }),
      providerResponse: sanitizeForLogging({
        cancelled: 'client_disconnected',
        partial: partialMessage(),
        ...(assembler.usage ? {} : { output_tokens_estimated: true }),
      }),
      latencyMs,
      usage: cancelledUsage,
    });
    auditStreamedOutput(`${state.route}:stream:cancelled`);
  };

  const finalizeBlock = () => {
    if (blockFinalized || !blockedByGuardrail) return;
    blockFinalized = true;
    const verdict = blockVerdict ?? undefined;
    const blockMessage = verdict?.message?.body ?? 'Response blocked by an output guardrail.';
    const blockedKey = verdict?.guardrailKey ?? streamGuardrailKeys[0];

    // ONLY NOW. The consumer has written the terminal frames and closed. Aborting
    // first would make the provider iterator throw into the catch below, which
    // tests for a caller cancellation: none of the frames would ever be written,
    // a policy block would be reported as a user pressing stop, and the usage row
    // would be wrong with it.
    blockCtl.abort();

    // The provider generated and billed these tokens whether or not they were delivered.
    const blockedUsage = partialUsage();
    if (!settled) {
      settled = true;
      context.onUsageSettled?.(calculateCost(model.pricing, blockedUsage), blockedUsage);
    }

    usageRow(state, 'log-stream-guardrail-block', {
      requestId,
      route: state.route,
      // 'error' rather than a new status: the non-streaming path throws
      // GuardrailBlockError and lands here as an error too, and the two halves
      // of one feature must not report differently.
      status: 'error',
      providerRequest: requestLog({ ...describeRequestContract(wire), ...replicaTrace(model, servingReplica, opened.failed) }),
      providerResponse: sanitizeForLogging({
        guardrail_blocked: true,
        guardrail_key: blockedKey,
        codes: verdict?.codes,
        risk_score: verdict?.riskScore,
        partial_delivery: releasedGatedText,
        // The provider produced this whether or not we delivered it.
        partial: partialMessage(),
        ...(assembler.usage ? {} : { output_tokens_estimated: true }),
      }),
      errorMessage: blockMessage,
      latencyMs: Date.now() - startedAt,
      // The same estimator the cancel path uses, for the same reason.
      usage: blockedUsage,
      finishReason: 'content_filter',
    });

    // The gate was built with `audit: false`, so this is still the single
    // post-hoc `output.pre` row for the answer - and it audits the aggregated
    // provider text, which INCLUDES the withheld characters that caused the block.
    auditStreamedOutput(`${state.route}:stream`);
  };

  const beginBlock = function* (verdict: StreamGateEmission['verdict'] | null): Generator<ModelStreamEvent, void, void> {
    blockedByGuardrail = true;
    blockVerdict = verdict;
    // A verdict is normally present, but `StreamGateEmission` types it as
    // optional (a latched gate replays a block whose verdict it never had), and
    // "blocked with no reason at all" is the one thing worse than blocking.
    const message = verdict?.message?.body ?? 'Response blocked by an output guardrail.';
    // Characters already rendered cannot be recalled, so say so on both channels:
    // a header for the transport and a frame for the client holding the prefix.
    if (releasedGatedText) streamHeaders['x-guardrail-partial'] = 'true';
    yield {
      type: 'blocked',
      message,
      guardrailKey: verdict?.guardrailKey ?? streamGuardrailKeys[0],
      code: verdict?.message?.reasonClass,
      discardPrior: releasedGatedText,
    };
    finalizeBlock();
  };

  const settleSuccess = (finish: string) => {
    if (settled) return;
    settled = true;
    const latencyMs = Date.now() - startedAt;
    const usage: TokenUsage = assembler.usage
      ? { ...toGatewayUsage(driver, assembler.usage), toolCalls: toolCallCount() }
      : { toolCalls: toolCallCount() };

    context.onUsageSettled?.(calculateCost(model.pricing, usage), usage);

    usageRow(state, 'log-stream-usage', {
      requestId,
      route: state.route,
      status: outputLimitError ? 'error' : 'success',
      providerRequest: requestLog({ ...describeRequestContract(wire), ...replicaTrace(model, servingReplica, opened.failed) }),
      providerResponse: sanitizeForLogging({ ...partialMessage(), finish_reason: finish }),
      errorMessage: outputLimitError?.message,
      latencyMs,
      usage,
      finishReason: finish,
    });

    auditStreamedOutput(`${state.route}:stream`);
  };

  let finishForSettle = 'stop';

  try {
    yield { type: 'start' };

    for await (const chunk of withFirst(opened.value.first, opened.value.gen)) {
      assembler.push(chunk);
      const delta = chunk.delta ?? {};

      let contentText: string | undefined = delta.content || undefined;
      let inline: string | undefined;
      if (delta.content) {
        // A leaked `<reasoning>` block arrives split across deltas.
        const split = splitter.push(delta.content);
        contentText = split.content.length > 0 ? split.content : undefined;
        inline = split.reasoning.length > 0 ? split.reasoning : undefined;
      }
      if (inline) inlineReasoning += inline;
      const reasoningDelta = `${delta.reasoning?.summary ?? ''}${inline ?? ''}`;

      if (typeof chunk.rawFinishReason === 'string') {
        // The terminal frame is said LAST (after the splitter tail and the
        // argument repairs), so it is held here.
        pendingFinish = wireFinishReason(driver, chunk.rawFinishReason, chunk.finishReason);
        if (chunk.finishReason === 'length' && !hasFinalOutput && !contentText?.trim() && !(delta.toolCalls?.length)) {
          outputLimitError = new OutputTokenLimitError(outputTokenLimit);
        }
      }
      if (contentText?.trim() || (delta.toolCalls && delta.toolCalls.length > 0)) hasFinalOutput = true;
      if (outputLimitError) continue;

      // The reasoning splitter can consume a whole delta while it waits for the
      // rest of a tag. What is left carries nothing - it is dropped.
      if (!contentText && !reasoningDelta && !(delta.toolCalls && delta.toolCalls.length > 0)) continue;

      const step: ModelStreamDelta = {
        type: 'delta',
        ...(contentText ? { content: contentText } : {}),
        ...(reasoningDelta ? { reasoning: reasoningDelta } : {}),
        ...(delta.reasoning ? { reasoningPayload: delta.reasoning } : {}),
        ...(delta.toolCalls && delta.toolCalls.length > 0 ? { toolCalls: delta.toolCalls } : {}),
        ...(chunk.providerFields ? { providerFields: chunk.providerFields } : {}),
      };
      const out = await emit(step);
      for (const event of out.events) {
        if (event.type === 'delta' && event.content) emittedContent += event.content;
        yield event;
      }
      if (out.blocked !== undefined) {
        yield* beginBlock(out.blocked);
        return;
      }
    }

    // A stream that ended mid-tag - or mid-thought, when the model was cut off
    // inside its reasoning - leaves text in the splitter. Release it instead of
    // truncating the answer.
    const tail = splitter.flush();
    if (!outputLimitError && (tail.content || tail.reasoning)) {
      if (tail.reasoning) inlineReasoning += tail.reasoning;
      const out = await emit({
        type: 'delta',
        ...(tail.content ? { content: tail.content } : {}),
        ...(tail.reasoning ? { reasoning: tail.reasoning } : {}),
      });
      for (const event of out.events) {
        if (event.type === 'delta' && event.content) emittedContent += event.content;
        yield event;
      }
      if (out.blocked !== undefined) {
        yield* beginBlock(out.blocked);
        return;
      }
    }

    // Arguments that do not parse on their own - empty, or the lone `{` Bedrock's
    // Qwen tool parser emits for a no-argument tool - are completed with the
    // missing fragment, so a strict client (and the agent loop) can parse them.
    if (!outputLimitError) {
      for (const blank of assembler.blankToolCalls()) {
        assembler.complete(blank.index, blank.completion);
        const out = await emit({ type: 'delta', toolCalls: [{ index: blank.index, arguments: blank.completion }] });
        for (const event of out.events) yield event;
        if (out.blocked !== undefined) {
          yield* beginBlock(out.blocked);
          return;
        }
      }
    }

    // The terminal frame the provider sent.
    if (!outputLimitError && pendingFinish !== undefined) {
      pendingFinish = finishWithToolCalls(driver, pendingFinish, assembler.toolCallCount > 0);
      const out = await emit({ type: 'delta', finishReason: pendingFinish });
      for (const event of out.events) yield event;
      if (out.blocked !== undefined) {
        yield* beginBlock(out.blocked);
        return;
      }
    }

    if (gate) {
      // An upstream that never sends a finish_reason leaves the gate holding its
      // hold-back tail, with no terminal chunk to trigger the final window - this
      // is what releases it. It is also the LAST chance for a window to block, so
      // it can come back blocked exactly like a push.
      const end = await gate.end();
      for (const released of end.emit) {
        if (frameHasContent(released)) releasedGatedText = true;
        const event = restoreNativeExtras(fromGateFrame(released));
        if (event.content) emittedContent += event.content;
        yield event;
      }
      if (end.blocked) {
        yield* beginBlock(end.verdict ?? null);
        return;
      }
    }

    if (outputLimitError) {
      yield { type: 'output_limit', error: normalizeInferenceError(outputLimitError).error };
    }

    // Some upstreams never send a terminal finish_reason. Clients that wait for
    // one would hang until the socket closed. A completion that ended in tool
    // calls must say so, or an agent client reads it as a finished answer and
    // never dispatches them.
    const syntheticFinish = !outputLimitError && pendingFinish === undefined
      ? (assembler.toolCallCount > 0 ? 'tool_calls' : 'stop')
      : undefined;
    if (syntheticFinish) yield { type: 'finish', finishReason: syntheticFinish };

    const usage: TokenUsage = assembler.usage
      ? { ...toGatewayUsage(driver, assembler.usage), toolCalls: toolCallCount() }
      : { toolCalls: toolCallCount() };

    // `usage` is only allowed on the wire when the caller asked for it with
    // `stream_options.include_usage`, and then only on a dedicated final frame.
    if (!outputLimitError && includeStreamUsage && assembler.usage) {
      yield { type: 'usage', usage, wire: toWireUsage(usage) };
    }

    finishForSettle = pendingFinish ?? syntheticFinish ?? 'stop';
    const assembled = assembler.toResponse(emptyNativeUsage);
    const reasoning = mergeReasoning(assembler.reasoning(), inlineReasoning || undefined);
    const response: ChatCompletionResponse = {
      ...assembled,
      content: emittedContent.length > 0 ? emittedContent : null,
      ...(reasoning ? { reasoning } : {}),
    };
    donePending = true;
    yield {
      type: 'done',
      response,
      usage,
      ...(assembler.usage ? { nativeUsage: assembler.usage } : {}),
      wireFinishReason: finishForSettle,
      outputLimitReached: Boolean(outputLimitError),
    };
    settleSuccess(finishForSettle);
    exitedEarly = false;
  } catch (error: unknown) {
    exitedEarly = false;
    // CHECKED FIRST, and before the cancellation branch below: a guardrail block
    // aborts the upstream itself, so the provider iterator can still throw its way
    // out of `for await`'s `return()` afterwards. Everything that had to be
    // written was written by `beginBlock`.
    if (blockedByGuardrail) return;

    const latencyMs = Date.now() - startedAt;

    // Only the caller's own signal means the caller walked away. That is not a
    // provider failure, and recording it as one blamed us for every user who
    // pressed stop: the error rate rose, alerting fired, and the tokens the
    // provider had already generated (and bills us for) were written as zero.
    if (external?.aborted) {
      settleCancelled();
      yield { type: 'cancelled' };
      return;
    }

    const normalized = normalizeInferenceError(error);
    usageRow(state, 'log-stream-error', {
      requestId,
      route: state.route,
      status: 'error',
      providerRequest: requestLog({ ...describeRequestContract(wire), ...replicaTrace(model, servingReplica, opened.failed) }),
      providerResponse: sanitizeForLogging({ error: normalized.error.message }),
      errorMessage: normalized.error.message,
      latencyMs,
      usage: {},
      finishReason: assembler.finishReason === "error" ? undefined : assembler.finishReason,
    });
    yield { type: 'failed', error: normalized.error, status: normalized.status };
  } finally {
    // A consumer that stopped reading right after a terminal event still gets its
    // bookkeeping: the block's abort + row, or the success row.
    if (blockedByGuardrail) finalizeBlock();
    else if (donePending) settleSuccess(finishForSettle);
    else if (exitedEarly && !settled) {
      // The consumer walked away without a terminal event or a signal: stop the
      // upstream and book what was generated, as for a cancellation.
      blockCtl.abort();
      settleCancelled();
    }
  }
}
