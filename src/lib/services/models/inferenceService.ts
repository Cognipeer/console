import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { fireAndForget } from '@/lib/core/asyncTask';
import type { AIMessage, AIMessageChunk } from '@langchain/core/messages';

const logger = createLogger('inference');
import { IModel } from '@/lib/database';
import type {
  SttRuntime,
  SttTranscribeInput,
  SttTranslateInput,
  TtsRuntime,
  TtsSynthesizeInput,
  OcrRuntime,
  OcrExtractInput,
  OcrResult,
} from '@/lib/providers';
import { getModelByKey } from './modelService';
import {
  toLangChainMessages,
  toOpenAIChatResponse,
  toOpenAIStreamChunk,
  summarizeUsage,
} from './openaiAdapter';

import { logModelUsage, TokenUsage } from './usageLogger';
import {
  MAX_ROUTING_DEPTH,
  buildDeciderMessages,
  evaluateRules,
  extractRoutingSignals,
  getDynamicRoutingConfig,
  parseDeciderLabel,
  publicSignals,
} from './dynamicRouting';
import type { IDynamicRoutingConfig, IModelUsageRouting } from '@/lib/database';
import { buildModelRuntime } from './runtimeService';
import { isSemanticCacheEnabled, lookupCache, storeInCache } from './semanticCacheService';
import { evaluateGuardrail } from '@/lib/services/guardrail';

const encoder = new TextEncoder();

// ── Guardrail block error ────────────────────────────────────────────────
export class GuardrailBlockError extends Error {
  readonly guardrailKey: string;
  readonly action: string;
  readonly findings: unknown[];

  constructor(
    message: string,
    guardrailKey: string,
    action: string,
    findings: unknown[] = [],
  ) {
    super(message);
    this.name = 'GuardrailBlockError';
    this.guardrailKey = guardrailKey;
    this.action = action;
    this.findings = findings;
  }
}

// ── Model guardrail enforcement ───────────────────────────────────────────
// A guardrail attached to a model runs on every chat completion. The direction
// is decided by the slot it is bound to: `inputGuardrailKey` checks the user
// message before the model is called, `outputGuardrailKey` checks the assistant
// response (non-streaming only). Blocking guardrails throw GuardrailBlockError.

function guardrailContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && 'text' in part
            ? String((part as { text?: unknown }).text ?? '')
            : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function extractLatestUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role === 'user') return guardrailContentToText(msg.content);
  }
  return '';
}

function extractAssistantText(response: unknown): string {
  const choices = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  return guardrailContentToText(choices?.[0]?.message?.content);
}

async function enforceModelGuardrail(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  guardrailKey: string;
  text: string;
  phase: 'input' | 'output';
}): Promise<void> {
  if (!params.text.trim()) return;
  const result = await evaluateGuardrail({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    projectId: params.projectId,
    guardrailKey: params.guardrailKey,
    text: params.text,
  });
  if (!result.passed && result.action === 'block') {
    const reasons = result.findings
      .map((f) => f.category || f.type)
      .filter(Boolean)
      .join(', ');
    throw new GuardrailBlockError(
      `${params.phase === 'input' ? 'Input' : 'Output'} blocked by guardrail "${result.guardrailName}"${reasons ? `: ${reasons}` : ''}`,
      result.guardrailKey,
      result.action,
      result.findings,
    );
  }
}

interface ChatRunnable {
  invoke(input: unknown, options?: Record<string, unknown>): Promise<AIMessage>;
  stream?(
    input: unknown,
    options?: Record<string, unknown>,
  ): AsyncIterable<AIMessageChunk> | Promise<AsyncIterable<AIMessageChunk>>;
}

function ensureChatRunnable(value: unknown): ChatRunnable {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid chat runtime.');
  }

  const candidate = value as Partial<ChatRunnable>;
  if (typeof candidate.invoke !== 'function') {
    throw new Error('Model provider returned an invalid chat runtime.');
  }

  return candidate as ChatRunnable;
}

type EmbeddingVector = number[] | Float32Array | { values: number[] };

interface EmbeddingRunnable {
  embedDocuments(inputs: string[]): Promise<EmbeddingVector[]>;
}

function ensureEmbeddingRunnable(value: unknown): EmbeddingRunnable {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid embedding runtime.');
  }

  const candidate = value as Partial<EmbeddingRunnable>;
  if (typeof candidate.embedDocuments !== 'function') {
    throw new Error('Model provider returned an invalid embedding runtime.');
  }

  return candidate as EmbeddingRunnable;
}

function normalizeEmbeddingVector(vector: EmbeddingVector): number[] {
  if (Array.isArray(vector)) {
    return vector;
  }

  if (vector instanceof Float32Array) {
    return Array.from(vector);
  }

  if (
    vector &&
    typeof vector === 'object' &&
    Array.isArray((vector as { values?: unknown }).values)
  ) {
    return (vector as { values: number[] }).values;
  }

  return [];
}

type ToolCallPayload = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

function getToolCallCount(message: AIMessage): number {
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls)) {
    return 0;
  }

  return toolCalls.length;
}

interface ChatCompletionRequestBody extends Record<string, unknown> {
  messages?: unknown;
  stream?: unknown;
  request_id?: string;
}

interface EmbeddingRequestBody extends Record<string, unknown> {
  input?: string | string[];
  request_id?: string;
  input_tokens?: number;
  inputTokenCount?: number;
}

function sanitizeForLogging(payload: unknown, maxLength = 20000) {
  if (payload === null || payload === undefined) {
    return payload;
  }

  try {
    const json = JSON.stringify(payload);
    if (json.length <= maxLength) {
      return payload;
    }
    return {
      truncated: true,
      preview: json.slice(0, maxLength),
    };
  } catch {
    return '[unserializable]';
  }
}

function buildOverrides(body: Record<string, unknown>) {
  const overrides: Record<string, unknown> = {};
  const fields = [
    'temperature',
    'top_p',
    'max_tokens',
    'presence_penalty',
    'frequency_penalty',
    'seed',
  ];

  fields.forEach((field) => {
    if (body[field] !== undefined) {
      overrides[field] = body[field];
    }
  });

  if (body.stop !== undefined) overrides.stop = body.stop;
  if (body.tools !== undefined) overrides.tools = body.tools;
  if (body.tool_choice !== undefined) overrides.tool_choice = body.tool_choice;
  if (body.response_format !== undefined)
    overrides.response_format = body.response_format;
  if (body.modality !== undefined) overrides.modality = body.modality;
  if (body.max_output_tokens !== undefined)
    overrides.max_output_tokens = body.max_output_tokens;

  // Reasoning model support (o1, o3, o4-mini, etc.)
  // max_completion_tokens is required for reasoning models instead of max_tokens
  if (body.max_completion_tokens !== undefined)
    overrides.max_completion_tokens = body.max_completion_tokens;

  // reasoning parameter: { effort: "low" | "medium" | "high", summary?: "auto" | "concise" }
  if (body.reasoning !== undefined) overrides.reasoning = body.reasoning;

  // Legacy reasoning_effort parameter (deprecated but still supported)
  // Will be mapped to reasoning.effort by LangChain
  if (body.reasoning_effort !== undefined)
    overrides.reasoning_effort = body.reasoning_effort;

  return overrides;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, unknown>) };
}

function buildChatModelSettings(
  modelSettings: unknown,
  overrides: Record<string, unknown>,
) {
  const settings = asRecord(modelSettings);

  if (overrides.temperature !== undefined) {
    settings.temperature = overrides.temperature;
  }

  if (overrides.max_tokens !== undefined) {
    settings.maxTokens = overrides.max_tokens;
  }

  if (overrides.max_completion_tokens !== undefined) {
    settings.maxCompletionTokens = overrides.max_completion_tokens;
  }

  if (overrides.reasoning !== undefined) {
    settings.reasoning = overrides.reasoning;
  } else if (overrides.reasoning_effort !== undefined) {
    settings.reasoning = {
      ...(typeof settings.reasoning === 'object' && settings.reasoning !== null
        ? settings.reasoning as Record<string, unknown>
        : {}),
      effort: overrides.reasoning_effort,
    };
  }

  return settings;
}

function buildChatCallOptions(overrides: Record<string, unknown>) {
  const options: Record<string, unknown> = {};

  if (overrides.stop !== undefined) options.stop = overrides.stop;
  if (overrides.tools !== undefined) options.tools = overrides.tools;
  if (overrides.tool_choice !== undefined) options.tool_choice = overrides.tool_choice;
  if (overrides.response_format !== undefined) {
    options.response_format = overrides.response_format;
  }
  if (overrides.seed !== undefined) options.seed = overrides.seed;
  if (overrides.modality !== undefined) {
    options.modalities = Array.isArray(overrides.modality)
      ? overrides.modality
      : [overrides.modality];
  }
  if (overrides.max_output_tokens !== undefined) {
    options.max_output_tokens = overrides.max_output_tokens;
  }

  return options;
}

function ensureLlmModel(model: IModel) {
  if (model.category !== 'llm') {
    throw new Error('Model is not configured for chat completions');
  }
}

function ensureEmbeddingModel(model: IModel) {
  if (model.category !== 'embedding') {
    throw new Error('Model is not configured for embeddings');
  }
}

/**
 * Unified result shape for chat completions. A single object (not a union) so
 * callers can probe `stream` / `response` / `usage` without narrowing — exactly
 * how every existing call site already uses it. `routing` is present only on
 * Dynamic LLM responses.
 */
export interface ChatCompletionOutcome {
  response?: Record<string, unknown>;
  usage?: TokenUsage;
  latencyMs?: number;
  requestId: string;
  cacheHit?: boolean;
  stream?: ReadableStream<Uint8Array>;
  routing?: IModelUsageRouting;
}

// ── Dynamic LLM resolution ────────────────────────────────────────────────
// Resolves a Dynamic LLM router to a concrete child model and invokes it via
// `handleChatCompletion` (recursively, depth-guarded). The router records its
// own decision row (route 'chat.completions.router') with the full routing
// metadata; the child + any decider model log their real usage independently,
// so cost is never double-counted (router pricing is zero).
async function resolveDynamicCompletion(args: {
  tenantDbName: string;
  tenantId?: string;
  projectId: string;
  body: ChatCompletionRequestBody;
  stream?: boolean;
  router: IModel;
  config: IDynamicRoutingConfig;
  depth: number;
}): Promise<ChatCompletionOutcome> {
  const { tenantDbName, tenantId, projectId, body, stream, router, config, depth } = args;
  const start = Date.now();
  const routerRequestId =
    typeof body.request_id === 'string' && body.request_id.length > 0
      ? body.request_id
      : crypto.randomUUID();

  const signals = extractRoutingSignals(body);

  let chosenModelKey = config.defaultModelKey;
  let decision: IModelUsageRouting['decision'] = 'default';
  let matchedRuleLabel: string | undefined;
  let deciderLabel: string | undefined;
  let deciderModelKey: string | undefined;
  let deciderLatencyMs: number | undefined;
  let reason = 'No rule matched; used default model';

  if (config.strategy === 'rule-based') {
    const rule = evaluateRules(config.rules ?? [], signals);
    if (rule) {
      chosenModelKey = rule.targetModelKey;
      decision = 'rule';
      matchedRuleLabel = rule.label;
      reason = `Matched rule "${rule.label}"`;
    }
  } else if (config.strategy === 'model-based' && config.decider) {
    deciderModelKey = config.decider.modelKey;
    const deciderStart = Date.now();
    try {
      const deciderResult = (await handleChatCompletion({
        tenantDbName,
        tenantId,
        modelKey: config.decider.modelKey,
        projectId,
        body: {
          messages: buildDeciderMessages(config.decider, signals),
          temperature: 1,
          max_tokens: 256,
        },
        _routingDepth: depth + 1,
      })) as { response?: unknown };
      deciderLatencyMs = Date.now() - deciderStart;
      const text = extractAssistantText(deciderResult.response);
      const label = parseDeciderLabel(text, config.decider.labels);
      if (label) {
        chosenModelKey = label.targetModelKey;
        decision = 'model';
        deciderLabel = label.label;
        reason = `Decider "${config.decider.modelKey}" classified as "${label.label}"`;
      } else {
        reason = `Decider returned an unrecognized label "${text.slice(0, 40)}"; used default model`;
      }
    } catch (error) {
      deciderLatencyMs = Date.now() - deciderStart;
      reason = `Decider failed (${error instanceof Error ? error.message : 'error'}); used default model`;
    }
  }

  // Never route back to the router itself (would loop until the depth cap).
  if (chosenModelKey === router.key) {
    chosenModelKey = config.defaultModelKey === router.key ? '' : config.defaultModelKey;
  }

  const runChild = (childKey: string) =>
    handleChatCompletion({
      tenantDbName,
      tenantId,
      modelKey: childKey,
      projectId,
      body,
      stream,
      _routingDepth: depth + 1,
    });

  const buildRouting = (
    chosen: string,
    decisionValue: IModelUsageRouting['decision'],
    reasonValue: string,
  ): IModelUsageRouting => ({
    routerKey: router.key,
    routerModelDbId: router._id ? String(router._id) : undefined,
    strategy: config.strategy,
    decision: decisionValue,
    chosenModelKey: chosen,
    matchedRuleLabel,
    deciderLabel,
    deciderModelKey,
    deciderLatencyMs,
    reason: reasonValue,
    signals: publicSignals(signals),
  });

  const logDecision = (
    routing: IModelUsageRouting,
    status: 'success' | 'error',
    usage: TokenUsage,
    errorMessage?: string,
  ) => {
    fireAndForget('log-router-decision', () =>
      logModelUsage(tenantDbName, router, {
        requestId: routerRequestId,
        route: 'chat.completions.router',
        status,
        providerRequest: sanitizeForLogging({
          model: router.key,
          messages: body.messages,
          signals: routing.signals,
        }),
        providerResponse: sanitizeForLogging({
          chosenModelKey: routing.chosenModelKey,
          decision: routing.decision,
          reason: routing.reason,
        }),
        errorMessage,
        latencyMs: Date.now() - start,
        usage,
        routing,
      }),
    );
  };

  let finalModelKey = chosenModelKey;
  let finalDecision: IModelUsageRouting['decision'] = decision;
  let finalReason = reason;
  let childResult: ChatCompletionOutcome;

  try {
    if (!chosenModelKey) throw new Error('No target model resolved for dynamic router');
    childResult = await runChild(chosenModelKey);
  } catch (primaryError) {
    if (config.fallbackModelKey && config.fallbackModelKey !== chosenModelKey) {
      finalModelKey = config.fallbackModelKey;
      finalDecision = 'fallback';
      finalReason = `${reason}; primary "${chosenModelKey || '(none)'}" failed, fell back to "${config.fallbackModelKey}"`;
      try {
        childResult = await runChild(config.fallbackModelKey);
      } catch (fallbackError) {
        logDecision(
          buildRouting(finalModelKey, finalDecision, finalReason),
          'error',
          {},
          fallbackError instanceof Error ? fallbackError.message : 'error',
        );
        throw fallbackError;
      }
    } else {
      logDecision(
        buildRouting(chosenModelKey, decision, reason),
        'error',
        {},
        primaryError instanceof Error ? primaryError.message : 'error',
      );
      throw primaryError;
    }
  }

  const routing = buildRouting(finalModelKey, finalDecision, finalReason);

  // Streaming children return { stream, requestId }; non-streaming return
  // { response, usage, ... }. Mirror the child's token usage onto the router
  // row for traffic accounting (router pricing is zero, so cost never doubles).
  routing.childRequestId = childResult.requestId;

  if (stream) {
    logDecision(routing, 'success', {});
    return { ...childResult, routing };
  }

  logDecision(routing, 'success', childResult.usage ?? {});
  return { ...childResult, routing };
}

export async function handleChatCompletion(params: {
  tenantDbName: string;
  tenantId?: string;
  modelKey: string;
  projectId: string;
  body: ChatCompletionRequestBody;
  stream?: boolean;
  /** Internal: recursion depth when a Dynamic LLM resolves to another model. */
  _routingDepth?: number;
}): Promise<ChatCompletionOutcome> {
  const { tenantDbName, tenantId, modelKey, projectId, body, stream } = params;

  if (!Array.isArray(body?.messages)) {
    throw new Error('`messages` array is required');
  }

  const requestId =
    typeof body.request_id === 'string' && body.request_id.length > 0
      ? body.request_id
      : crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  // Dynamic LLM: this model owns no provider — it routes to a concrete child
  // model. Resolve and recurse before any provider/runtime work happens.
  const dynamicConfig = getDynamicRoutingConfig(model);
  if (dynamicConfig) {
    const depth = params._routingDepth ?? 0;
    if (depth >= MAX_ROUTING_DEPTH) {
      throw new Error(
        `Dynamic routing depth exceeded (${MAX_ROUTING_DEPTH}) resolving model "${modelKey}"`,
      );
    }
    return resolveDynamicCompletion({
      tenantDbName,
      tenantId,
      projectId,
      body,
      stream,
      router: model,
      config: dynamicConfig,
      depth,
    });
  }

  ensureLlmModel(model);

  // Input guardrail: check the latest user message before calling the model.
  if (model.inputGuardrailKey) {
    await enforceModelGuardrail({
      tenantDbName,
      tenantId: model.tenantId,
      projectId,
      guardrailKey: model.inputGuardrailKey,
      text: extractLatestUserText(body.messages),
      phase: 'input',
    });
  }

  // Semantic cache: check for cached response before calling the model
  const cacheEnabled = !stream && tenantId && isSemanticCacheEnabled(model);
  if (cacheEnabled && model.semanticCache) {
    try {
      const cacheResult = await lookupCache({
        tenantDbName,
        tenantId,
        projectId,
        config: model.semanticCache,
        messages: body.messages as unknown[],
      });

      if (cacheResult.hit && cacheResult.response) {
        const latencyMs = Date.now() - start;

        fireAndForget('log-cache-hit', () =>
          logModelUsage(tenantDbName, model, {
            requestId,
            route: 'chat.completions',
            status: 'success',
            providerRequest: sanitizeForLogging({
              model: modelKey,
              messages: body.messages,
              stream: false,
            }),
            providerResponse: sanitizeForLogging(cacheResult.response),
            latencyMs,
            usage: {},
            cacheHit: true,
          }),
        );

        return {
          response: cacheResult.response,
          usage: {} as TokenUsage,
          latencyMs,
          requestId,
          cacheHit: true,
        };
      }
    } catch (cacheError) {
      logger.warn('Cache lookup error, proceeding with model', { error: cacheError });
    }
  }

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createChatModel) {
    throw new Error('Model provider does not support chat completions');
  }

  const messagesInput = body.messages as Parameters<typeof toLangChainMessages>[0];
  const messages = toLangChainMessages(messagesInput);
  const overrides = buildOverrides(body);
  const modelSettings = buildChatModelSettings(model.settings, overrides);
  const callOptions = buildChatCallOptions(overrides);

  const chatModel = ensureChatRunnable(await runtime.createChatModel({
    modelId: model.modelId,
    category: model.category,
    modelSettings,
    options: { streaming: Boolean(stream) },
  }));

  if (stream) {
    if (typeof chatModel.stream !== 'function') {
      throw new Error('Model provider does not support streaming responses');
    }

    const asyncIterator = await withResilience(
      () => chatModel.stream!(messages, callOptions) as Promise<AsyncIterable<AIMessageChunk>>,
      { key: `chat-stream:${model.providerKey}` },
    );
    const startedAt = Date.now();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let aggregatedChunk: AIMessageChunk | null = null;
        let lastUsage: TokenUsage | undefined;
        const toolCalls: ToolCallPayload[] = [];

        try {
          for await (const chunk of asyncIterator) {
            aggregatedChunk = aggregatedChunk
              ? aggregatedChunk.concat(chunk)
              : chunk;

            const chunkToolCalls = (chunk as { tool_calls?: unknown }).tool_calls;
            if (Array.isArray(chunkToolCalls)) {
              chunkToolCalls.forEach((call) => {
                toolCalls.push(call as ToolCallPayload);
              });
            }

            const payload = toOpenAIStreamChunk(chunk, {
              model: model.modelId,
              stream: true,
            });

            if (payload.usage) {
              lastUsage = {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
                cachedInputTokens: payload.usage.cached_tokens,
                totalTokens: payload.usage.total_tokens,
              };
            }

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
            );
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();

          const latencyMs = Date.now() - startedAt;
          const usage: TokenUsage = lastUsage
            ? {
              ...lastUsage,
              toolCalls: toolCalls.length || undefined,
            }
            : { toolCalls: toolCalls.length || undefined };

          const providerResponse = aggregatedChunk
            ? aggregatedChunk
            : { tool_calls: toolCalls };

          fireAndForget('log-stream-usage', () =>
            logModelUsage(tenantDbName, model, {
              requestId,
              route: 'chat.completions',
              status: 'success',
              providerRequest: sanitizeForLogging({
                model: modelKey,
                messages: body.messages,
                overrides,
                stream: true,
              }),
              providerResponse: sanitizeForLogging(providerResponse),
              latencyMs,
              usage,
            }),
          );
        } catch (error: unknown) {
          const latencyMs = Date.now() - startedAt;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          fireAndForget('log-stream-error', () =>
            logModelUsage(tenantDbName, model, {
              requestId,
              route: 'chat.completions',
              status: 'error',
              providerRequest: sanitizeForLogging({
                model: modelKey,
                messages: body.messages,
                overrides,
                stream: true,
              }),
              providerResponse: sanitizeForLogging({ error: errorMessage }),
              errorMessage,
              latencyMs,
              usage: {},
            }),
          );

          controller.error(error);
        }
      },
    });

    return { stream: readable, requestId };
  }

  const aiMessage = await withResilience(
    () => chatModel.invoke(messages, callOptions),
    { key: `chat:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;
  const response = toOpenAIChatResponse(aiMessage, {
    model: model.modelId,
    stream: false,
  });

  const usage = summarizeUsage(aiMessage) as TokenUsage;
  const toolCallCount = getToolCallCount(aiMessage);
  if (toolCallCount) {
    usage.toolCalls = toolCallCount;
  }

  fireAndForget('log-chat-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'chat.completions',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        messages: body.messages,
        overrides,
        stream: false,
      }),
      providerResponse: sanitizeForLogging(response),
      latencyMs,
      usage,
      cacheHit: false,
    }),
  );

  // Output guardrail: check the assistant response before returning it
  // (non-streaming only — streamed responses can't be inspected up front).
  if (model.outputGuardrailKey) {
    await enforceModelGuardrail({
      tenantDbName,
      tenantId: model.tenantId,
      projectId,
      guardrailKey: model.outputGuardrailKey,
      text: extractAssistantText(response),
      phase: 'output',
    });
  }

  // Semantic cache: store the response for future lookups
  if (cacheEnabled && tenantId && model.semanticCache) {
    storeInCache({
      tenantDbName,
      tenantId,
      projectId,
      config: model.semanticCache,
      messages: body.messages as unknown[],
      response: response as Record<string, unknown>,
    }).catch((err) =>
      logger.warn('Failed to store response in cache', { error: err }),
    );
  }

  return { response, usage, latencyMs, requestId, cacheHit: false };
}

export async function handleEmbeddingRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  body: EmbeddingRequestBody;
}) {
  const { tenantDbName, modelKey, projectId, body } = params;

  if (!body?.input) {
    throw new Error('`input` is required');
  }

  const requestId = body?.request_id || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }

  ensureEmbeddingModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createEmbeddingModel) {
    throw new Error('Model provider does not support embeddings');
  }

  const embedder = ensureEmbeddingRunnable(await runtime.createEmbeddingModel({
    modelId: model.modelId,
    category: model.category,
    modelSettings: model.settings,
  }));
  const rawInput = body.input;
  const inputsArray = Array.isArray(rawInput) ? rawInput : [rawInput];
  const inputs = inputsArray.map((value) => {
    if (typeof value !== 'string') {
      throw new Error('`input` must be a string or an array of strings');
    }
    return value;
  });

  const embeddings = await withResilience(
    () => embedder.embedDocuments(inputs),
    { key: `embedding:${model.providerKey}` },
  );
  const latencyMs = Date.now() - start;

  const tokenEstimate =
    typeof body.input_tokens === 'number'
      ? body.input_tokens
      : typeof body.inputTokenCount === 'number'
        ? body.inputTokenCount
        : 0;

  const usage: TokenUsage = {
    inputTokens: tokenEstimate,
    outputTokens: 0,
    totalTokens: tokenEstimate,
  };

  fireAndForget('log-embedding-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'embeddings',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        input: inputs.slice(0, 5),
      }),
      providerResponse: sanitizeForLogging({
        embeddingsLength: embeddings.length,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      object: 'list',
      data: embeddings.map((vector, index) => ({
        object: 'embedding',
        index,
        embedding: normalizeEmbeddingVector(vector),
      })),
      model: model.modelId,
      usage: {
        prompt_tokens: usage.inputTokens ?? 0,
        total_tokens: usage.totalTokens ?? 0,
      },
    },
    latencyMs,
    requestId,
  };
}

// ── STT / TTS / OCR ─────────────────────────────────────────────────────────

function ensureSttModel(model: IModel) {
  if (model.category !== 'stt') {
    throw new Error('Model is not configured for speech-to-text');
  }
}

function ensureTtsModel(model: IModel) {
  if (model.category !== 'tts') {
    throw new Error('Model is not configured for text-to-speech');
  }
}

function ensureOcrModel(model: IModel) {
  if (model.category !== 'ocr') {
    throw new Error('Model is not configured for OCR');
  }
}

function getOcrMode(model: IModel): 'native' | 'vlm' {
  const settings = (model.settings ?? {}) as Record<string, unknown>;
  const ocrSettings = settings.ocr as Record<string, unknown> | undefined;
  const mode = ocrSettings?.mode;
  if (mode === 'native' || mode === 'vlm') return mode;
  // Default: if provider supports native OCR, prefer native; else vlm.
  return 'native';
}

function ensureSttRuntime(value: unknown): SttRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid STT runtime.');
  }
  const candidate = value as Partial<SttRuntime>;
  if (typeof candidate.transcribe !== 'function') {
    throw new Error('Model provider returned an invalid STT runtime.');
  }
  return candidate as SttRuntime;
}

function ensureTtsRuntime(value: unknown): TtsRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid TTS runtime.');
  }
  const candidate = value as Partial<TtsRuntime>;
  if (typeof candidate.synthesize !== 'function') {
    throw new Error('Model provider returned an invalid TTS runtime.');
  }
  return candidate as TtsRuntime;
}

function ensureOcrRuntime(value: unknown): OcrRuntime {
  if (!value || typeof value !== 'object') {
    throw new Error('Model provider returned an invalid OCR runtime.');
  }
  const candidate = value as Partial<OcrRuntime>;
  if (typeof candidate.extract !== 'function') {
    throw new Error('Model provider returned an invalid OCR runtime.');
  }
  return candidate as OcrRuntime;
}

export async function handleTranscriptionRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: SttTranscribeInput;
  /** When true, calls the provider's translate() instead of transcribe(). */
  translate?: boolean;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input, translate } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureSttModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createSttRuntime) {
    throw new Error('Model provider does not support speech-to-text');
  }

  const sttRuntime = ensureSttRuntime(
    await runtime.createSttRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  const operation = translate ? sttRuntime.translate : sttRuntime.transcribe;
  if (typeof operation !== 'function') {
    throw new Error(
      translate
        ? 'Model provider does not support audio translation'
        : 'Model provider does not support audio transcription',
    );
  }

  const result = await withResilience(
    () => operation.call(sttRuntime, input as SttTranscribeInput & SttTranslateInput),
    { key: `${translate ? 'stt-translate' : 'stt'}:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  const usage: TokenUsage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    totalTokens:
      result.usage?.totalTokens ??
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    inputSeconds: result.usage?.inputSeconds,
  };

  fireAndForget('log-stt-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: translate ? 'audio.translations' : 'audio.transcriptions',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        language: input.language,
        responseFormat: input.responseFormat,
        audioBytes: input.audio.data.byteLength,
      }),
      providerResponse: sanitizeForLogging({
        text: result.text.slice(0, 500),
        language: result.language,
        duration: result.duration,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
      words: result.words,
      usage: result.usage,
    },
    rawUsage: result.usage,
    latencyMs,
    requestId,
    model,
  };
}

export async function handleSpeechRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: TtsSynthesizeInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureTtsModel(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createTtsRuntime) {
    throw new Error('Model provider does not support text-to-speech');
  }

  const ttsRuntime = ensureTtsRuntime(
    await runtime.createTtsRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: model.settings,
    }),
  );

  const result = await withResilience(
    () => ttsRuntime.synthesize(input),
    { key: `tts:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  fireAndForget('log-tts-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'audio.speech',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        voice: input.voice,
        format: input.format,
        speed: input.speed,
        characterCount: input.text.length,
      }),
      providerResponse: sanitizeForLogging({
        contentType: result.contentType,
        format: result.format,
        audioBytes: result.audio.byteLength,
      }),
      latencyMs,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputCharacters: result.usage?.inputCharacters ?? input.text.length,
        outputSeconds: result.usage?.outputSeconds,
      },
    }),
  );

  return {
    audio: result.audio,
    contentType: result.contentType,
    format: result.format,
    usage: result.usage,
    latencyMs,
    requestId,
    model,
  };
}

export async function handleOcrRequest(params: {
  tenantDbName: string;
  modelKey: string;
  projectId: string;
  input: OcrExtractInput;
  requestId?: string;
}) {
  const { tenantDbName, modelKey, projectId, input } = params;
  const requestId = params.requestId || crypto.randomUUID();
  const start = Date.now();

  const model = await getModelByKey(tenantDbName, modelKey, projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  ensureOcrModel(model);

  const mode = getOcrMode(model);

  const { runtime } = await buildModelRuntime(
    tenantDbName,
    model.tenantId,
    model.providerKey,
    projectId,
  );

  if (!runtime.createOcrRuntime) {
    throw new Error('Model provider does not support OCR');
  }

  // The OCR factory itself decides native vs VLM based on the contract. We pass
  // the requested mode through modelSettings.ocr.mode so VLM-only providers can
  // refuse a native request explicitly if they wanted to.
  const ocrSettings = {
    ...((model.settings ?? {}) as Record<string, unknown>),
    ocr: {
      ...(((model.settings ?? {}) as Record<string, unknown>).ocr as
        | Record<string, unknown>
        | undefined),
      mode,
    },
  };

  const ocrRuntime = ensureOcrRuntime(
    await runtime.createOcrRuntime({
      modelId: model.modelId,
      category: model.category,
      modelSettings: ocrSettings,
    }),
  );

  const result: OcrResult = await withResilience(
    () => ocrRuntime.extract(input),
    { key: `ocr:${model.providerKey}` },
  );

  const latencyMs = Date.now() - start;

  const usage: TokenUsage = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    totalTokens:
      result.usage?.totalTokens ??
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    pages: result.usage?.pages,
  };

  fireAndForget('log-ocr-usage', () =>
    logModelUsage(tenantDbName, model, {
      requestId,
      route: 'ocr',
      status: 'success',
      providerRequest: sanitizeForLogging({
        model: modelKey,
        mode,
        documentKind: input.document.kind,
        documentBytes:
          input.document.kind === 'bytes' ? input.document.data.byteLength : undefined,
        documentUrl: input.document.kind === 'url' ? input.document.url : undefined,
        pages: input.pages,
        features: input.features,
      }),
      providerResponse: sanitizeForLogging({
        text: result.text.slice(0, 500),
        pageCount: result.pages?.length,
        tableCount: result.tables?.length,
        invokedVia: result.invokedVia,
      }),
      latencyMs,
      usage,
    }),
  );

  return {
    response: {
      text: result.text,
      pages: result.pages,
      tables: result.tables,
      keyValuePairs: result.keyValuePairs,
      language: result.language,
      invokedVia: result.invokedVia ?? mode,
      usage: result.usage,
    },
    latencyMs,
    requestId,
    model,
  };
}
