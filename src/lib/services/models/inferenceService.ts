import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { fireAndForget } from '@/lib/core/asyncTask';
import { AIMessageChunk, type AIMessage } from '@langchain/core/messages';

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
import { resolveUnsupportedParamNames } from '@/lib/providers/unsupportedParams';
import { getModelByKey } from './modelService';
import {
  toLangChainMessages,
  toOpenAIChatResponse,
  newCompletionId,
  openAIStreamRoleChunk,
  openAIStreamStopChunk,
  toOpenAIStreamChunk,
  summarizeUsage,
} from './openaiAdapter';
import {
  normalizeInferenceError,
  OutputTokenLimitError,
} from './openaiErrors';

export { OutputTokenLimitError } from './openaiErrors';

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
import {
  buildCacheVariantKey,
  isSemanticCacheEnabled,
  lookupCache,
  storeInCache,
} from './semanticCacheService';
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

interface GuardrailEnforcementOutcome {
  /** Text with redact-action findings masked; undefined when nothing was redacted. */
  redactedText?: string;
  /** Non-blocking findings (warn/flag/redact) to surface to the caller. */
  findings: Awaited<ReturnType<typeof evaluateGuardrail>>['findings'];
  guardrailKey: string;
}

async function enforceModelGuardrail(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  guardrailKey: string;
  text: string;
  phase: 'input' | 'output';
  requestId?: string;
  source?: string;
}): Promise<GuardrailEnforcementOutcome | null> {
  if (!params.text.trim()) return null;
  const result = await evaluateGuardrail({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    projectId: params.projectId,
    guardrailKey: params.guardrailKey,
    text: params.text,
    phase: params.phase,
    requestId: params.requestId,
    source: params.source ?? 'chat.completions',
  });
  if (!result.passed && result.findings.some((f) => f.block)) {
    // Prefer the finding's own message: a fail-closed guardrail whose judge model
    // could not run already explains that, and reducing it to the bare category
    // `evaluation_error` threw that explanation away — leaving a provider
    // misconfiguration looking like a content violation.
    const reasons = result.findings
      .filter((f) => f.block)
      .map((f) => f.message || f.category || f.type)
      .filter(Boolean)
      .join('; ');
    throw new GuardrailBlockError(
      `${params.phase === 'input' ? 'Input' : 'Output'} blocked by guardrail "${result.guardrailName}"${reasons ? `: ${reasons}` : ''}`,
      result.guardrailKey,
      result.action,
      result.findings,
    );
  }
  return {
    redactedText: result.redactedText,
    findings: result.findings,
    guardrailKey: result.guardrailKey,
  };
}

/** Rewrites the latest user message's textual content (used by the redact action). */
function replaceLatestUserText(messages: unknown, newText: string): unknown {
  if (!Array.isArray(messages)) return messages;
  const cloned = [...messages];
  for (let i = cloned.length - 1; i >= 0; i--) {
    const msg = cloned[i] as { role?: string; content?: unknown };
    if (msg?.role === 'user') {
      cloned[i] = { ...msg, content: newText };
      break;
    }
  }
  return cloned;
}

/** Attaches non-blocking guardrail findings to an OpenAI-shaped response. */
function annotateResponseWithGuardrails(
  response: unknown,
  annotations: Record<string, { guardrail_key: string; findings: unknown[] }>,
): unknown {
  if (!response || typeof response !== 'object' || Object.keys(annotations).length === 0) {
    return response;
  }
  return { ...(response as Record<string, unknown>), guardrails: annotations };
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

/**
 * Body fields the gateway understands natively. Everything else is a candidate
 * for passthrough (see `buildPassthroughBody`) rather than being dropped.
 */
const KNOWN_REQUEST_FIELDS = new Set([
  // Unwrapped below rather than forwarded as-is; forwarding the literal key too
  // makes OpenAI and Azure answer 400 "Unrecognized request argument".
  'extra_body',
  'frequency_penalty',
  'max_completion_tokens',
  'max_output_tokens',
  'max_tokens',
  'messages',
  'modality',
  'model',
  'presence_penalty',
  'reasoning',
  'reasoning_effort',
  'request_id',
  'response_format',
  'seed',
  'stop',
  'stream',
  'temperature',
  'tool_choice',
  'tools',
  'top_p',
]);

/**
 * Fields a caller must never be able to inject into the upstream body — they
 * either address our own routing or would let a request rewrite the transport.
 */
const PASSTHROUGH_DENYLIST = new Set([
  'api_key',
  'apikey',
  'authorization',
  'base_url',
  'messages',
  'model',
  'stream',
]);

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
  if (body.parallel_tool_calls !== undefined) {
    overrides.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.strict !== undefined) overrides.strict = body.strict;
  if (body.stream_options !== undefined) {
    overrides.stream_options = body.stream_options;
  }
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

  // top_p / presence_penalty / frequency_penalty were collected from the request
  // and then read by nobody, so the API accepted them and silently sampled at
  // the provider's defaults.
  if (overrides.top_p !== undefined) {
    settings.topP = overrides.top_p;
  }

  if (overrides.presence_penalty !== undefined) {
    settings.presencePenalty = overrides.presence_penalty;
  }

  if (overrides.frequency_penalty !== undefined) {
    settings.frequencyPenalty = overrides.frequency_penalty;
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

function normalizeStrictJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStrictJsonSchema);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const schema = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
      key,
      normalizeStrictJsonSchema(nestedValue),
    ]),
  );

  if (schema.type === 'object' || schema.properties) {
    schema.additionalProperties = false;
  }

  return schema;
}

function normalizeTools(tools: unknown, strictOverride: unknown): unknown {
  if (!Array.isArray(tools)) {
    return tools;
  }

  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    const normalizedTool = { ...(tool as Record<string, unknown>) };
    if (!normalizedTool.function || typeof normalizedTool.function !== 'object') {
      return normalizedTool;
    }

    const fn = { ...(normalizedTool.function as Record<string, unknown>) };
    const strict = typeof strictOverride === 'boolean' ? strictOverride : fn.strict;
    if (strict === true) {
      fn.strict = true;
      if (fn.parameters !== undefined) {
        fn.parameters = normalizeStrictJsonSchema(fn.parameters);
      }
    }

    normalizedTool.function = fn;
    return normalizedTool;
  });
}

function buildChatCallOptions(overrides: Record<string, unknown>) {
  const options: Record<string, unknown> = {};

  if (overrides.stop !== undefined) options.stop = overrides.stop;
  if (overrides.tools !== undefined) {
    options.tools = normalizeTools(overrides.tools, overrides.strict);
  }
  if (overrides.tool_choice !== undefined) options.tool_choice = overrides.tool_choice;
  if (overrides.parallel_tool_calls !== undefined) {
    options.parallel_tool_calls = overrides.parallel_tool_calls;
  }
  if (overrides.strict !== undefined) options.strict = overrides.strict;
  if (overrides.stream_options !== undefined) {
    options.stream_options = overrides.stream_options;
  }
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

function resolveOutputTokenLimit(
  overrides: Record<string, unknown>,
  modelSettings: Record<string, unknown>,
): number | undefined {
  const candidates = [
    overrides.max_completion_tokens,
    overrides.max_tokens,
    modelSettings.maxCompletionTokens,
    modelSettings.maxTokens,
  ];

  return candidates.find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
}

/**
 * Extra request-body fields destined for the upstream verbatim: the model's own
 * `settings.requestDefaults` merged under anything the caller sent that our
 * schema does not know (`chat_template_kwargs`, `top_k`, `repetition_penalty`,
 * `min_p`, …). Caller passthrough is opt-in per model, because forwarding
 * arbitrary fields to a provider is a decision the operator should make.
 *
 * Precedence is model defaults < caller body, and plain objects merge one level
 * deep so a caller's `chat_template_kwargs: { enable_thinking: true }` does not
 * erase a sibling key the operator set on the model.
 */
function buildPassthroughBody(
  modelSettings: unknown,
  body: Record<string, unknown>,
  blockedNames: Set<string>,
): Record<string, unknown> | undefined {
  const settings = asRecord(modelSettings);
  const defaults = asRecord(settings.requestDefaults);
  const explicit = asRecord(settings.extraBody);
  const merged: Record<string, unknown> = { ...defaults, ...explicit };

  // Operator-authored defaults are not exempt from the reserved-key rule: these
  // address our own routing, and the UI validator that rejects them only guards
  // one of the two surfaces that can write them.
  for (const key of Object.keys(merged)) {
    if (PASSTHROUGH_DENYLIST.has(key.toLowerCase())) delete merged[key];
  }

  if (settings.allowUnknownPassthrough === true) {
    // A parameter the operator declared unsupported must not come back through
    // the passthrough channel; and a parameter the gateway already resolves has
    // its own precedence rules, so it must not be duplicated here either —
    // extra-body fields are spread *after* them in the provider SDK and would
    // win.
    const accept = (key: string) =>
      !KNOWN_REQUEST_FIELDS.has(key)
      && !PASSTHROUGH_DENYLIST.has(key.toLowerCase())
      && !blockedNames.has(key.toLowerCase());

    const mergeField = (key: string, value: unknown) => {
      const existing = merged[key];
      merged[key] = isPlainObject(existing) && isPlainObject(value)
        ? { ...existing, ...value }
        : value;
    };

    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || !accept(key)) continue;
      mergeField(key, value);
    }

    // `extra_body` is how OpenAI SDK users carry non-schema fields; unwrap it so
    // those land as real top-level body fields rather than a nested object the
    // upstream would reject. `extra_body` itself is a known field, so the loop
    // above already skipped the literal key.
    for (const [key, value] of Object.entries(asRecord(body.extra_body))) {
      if (!accept(key)) continue;
      mergeField(key, value);
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}


function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The one place a chat runnable's parameters are decided. Every caller that
 * builds a chat model — the gateway, agents, guardrail judges — goes through
 * here so a model's `unsupportedParams` and `requestDefaults` apply everywhere,
 * not only on the routes that happen to remember to read them.
 *
 * `unsupportedParams` is stripped at the contract layer (`resolveOverrides`),
 * which is the last point before the provider SDK; passing it through the
 * settings object keeps that single strip point authoritative.
 */
export function resolveModelInvocationConfig(
  model: Pick<IModel, 'settings'> & Partial<Pick<IModel, 'modelId' | 'providerDriver'>>,
  body: Record<string, unknown>,
): {
  modelSettings: Record<string, unknown>;
  callOptions: Record<string, unknown>;
  overrides: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
  unsupportedParams: string[];
} {
  const settings = asRecord(model.settings);

  // Resolved here as well as in the contract layer, because the passthrough body
  // is assembled here and must not smuggle back a parameter the provider is
  // known to reject.
  const { params: unsupportedParams, detected } = resolveUnsupportedParamNames({
    driver: model.providerDriver,
    modelId: model.modelId,
    manual: settings.unsupportedParams,
    autoDetect: settings.autoDropUnsupportedParams,
  });

  const overrides = buildOverrides(body);
  const modelSettings = buildChatModelSettings(model.settings, overrides);
  const extraBody = buildPassthroughBody(
    model.settings,
    body,
    new Set(unsupportedParams.map((name) => name.toLowerCase())),
  );

  if (extraBody) {
    modelSettings.extraBody = extraBody;
  }

  // Stripping silently changes sampling behaviour, so leave a trace of which
  // rule did it and what the caller had asked for.
  if (detected.params.length > 0) {
    const overridden = detected.params.filter((name) => body[name] !== undefined);
    if (overridden.length > 0) {
      logger.debug('Dropping parameters this model does not accept', {
        driver: model.providerDriver,
        dropped: overridden,
        modelId: model.modelId,
        rule: detected.ruleId,
      });
    }
  }

  return {
    modelSettings,
    callOptions: buildChatCallOptions(overrides),
    overrides,
    extraBody,
    unsupportedParams,
  };
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
  const { tenantDbName, tenantId, modelKey, projectId, stream } = params;
  let { body } = params;

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
  // Non-blocking findings (warn/flag) are surfaced on the response; redact
  // findings rewrite the user message before it reaches the provider.
  const guardrailAnnotations: Record<string, { guardrail_key: string; findings: unknown[] }> = {};
  if (model.inputGuardrailKey) {
    const inputOutcome = await enforceModelGuardrail({
      tenantDbName,
      tenantId: model.tenantId,
      projectId,
      guardrailKey: model.inputGuardrailKey,
      text: extractLatestUserText(body.messages),
      phase: 'input',
      requestId,
    });
    if (inputOutcome?.redactedText !== undefined) {
      body = { ...body, messages: replaceLatestUserText(body.messages, inputOutcome.redactedText) as typeof body.messages };
    }
    if (inputOutcome && inputOutcome.findings.length > 0) {
      guardrailAnnotations.input = {
        guardrail_key: inputOutcome.guardrailKey,
        findings: inputOutcome.findings,
      };
    }
  }

  // Resolved before the cache lookup on purpose: the sampling parameters and
  // any passthrough body fields change what the model produces from the same
  // prompt, so they have to take part in the cache key.
  const invocation = resolveModelInvocationConfig(model, body);
  const cacheVariantKey = buildCacheVariantKey({
    ...invocation.overrides,
    ...(invocation.extraBody ?? {}),
  });

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
        variantKey: cacheVariantKey,
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
  const { modelSettings, callOptions, overrides } = invocation;
  const outputTokenLimit = resolveOutputTokenLimit(overrides, modelSettings);
  // A streamed request that carries tools used to be answered by a single
  // `invoke()` replayed as one SSE frame. The reason was real at the time —
  // the collapsed `tool_calls` on a streamed chunk arrive with empty arguments
  // — but `toOpenAIStreamChunk` now emits genuine `tool_call_chunks` deltas,
  // so all the workaround still did was turn streaming silently off for any
  // client that sends tools. That is every request from Open WebUI (native
  // function calling is its default, and it always ships its built-in time
  // tools) and from Onyx, i.e. exactly the clients that reported streaming not
  // working. Tools are the normal case, not the exception; the escape hatch
  // stays per-model for an upstream that really cannot stream them.
  const disableProviderStreaming = Boolean(
    stream
    && modelSettings.disableStreamingWithTools === true
    && Array.isArray(overrides.tools)
    && overrides.tools.length > 0,
  );
  const includeStreamUsage =
    asRecord(overrides.stream_options).include_usage === true;

  if (disableProviderStreaming) {
    delete callOptions.stream_options;
  }

  const chatModel = ensureChatRunnable(await runtime.createChatModel({
    modelId: model.modelId,
    category: model.category,
    modelSettings,
    options: {
      streaming: Boolean(stream),
      disableStreaming: disableProviderStreaming,
      // `withResilience` owns retry and circuit-breaking on this path, so the
      // provider SDK must not retry underneath it.
      maxRetries: 0,
    },
  }));

  if (stream) {
    if (!disableProviderStreaming && typeof chatModel.stream !== 'function') {
      throw new Error('Model provider does not support streaming responses');
    }

    // A disconnected client used to leave the provider generating (and billing)
    // until it finished on its own. Cancelling the readable — which Fastify does
    // when the response socket closes — now aborts the upstream call.
    const abortController = new AbortController();
    const streamCallOptions = { ...callOptions, signal: abortController.signal };

    let asyncIterator: AsyncIterable<AIMessageChunk>;
    if (disableProviderStreaming) {
      const eagerMessage = await withResilience(
        () => chatModel.invoke(messages, callOptions),
        { key: `chat:${model.providerKey}` },
      );
      asyncIterator = (async function* () {
        yield new AIMessageChunk({
          content: eagerMessage.content,
          additional_kwargs: eagerMessage.additional_kwargs,
          response_metadata: eagerMessage.response_metadata,
          id: eagerMessage.id,
          name: eagerMessage.name,
          usage_metadata: eagerMessage.usage_metadata,
          tool_calls: eagerMessage.tool_calls,
          invalid_tool_calls: eagerMessage.invalid_tool_calls,
        });
      })();
    } else {
      asyncIterator = await withResilience(
        () => chatModel.stream!(messages, streamCallOptions) as Promise<AsyncIterable<AIMessageChunk>>,
        { key: `chat-stream:${model.providerKey}` },
      );
    }
    const startedAt = Date.now();
    const completionId = newCompletionId();
    const completionCreated = Math.floor(Date.now() / 1000);

    const chunkOptions = {
      model: model.modelId,
      stream: true as const,
      completionId,
      created: completionCreated,
    };

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let aggregatedChunk: AIMessageChunk | null = null;
        let lastUsage: TokenUsage | undefined;
        let finalUsagePayload: Record<string, unknown> | undefined;
        let terminalFinishReason: string | undefined;
        let hasFinalOutput = false;
        let outputLimitError: OutputTokenLimitError | null = null;
        const toolCalls: ToolCallPayload[] = [];

        // A cancelled stream almost never carries provider usage: the counts
        // ride on the terminal chunk, which is precisely the chunk the client
        // did not stay for. Reporting zero there writes off output the
        // provider generated and bills us for, so fall back to an estimate
        // over the text we did stream — the same chars/4 rule the quota
        // pre-flight uses. The log marks it `output_tokens_estimated` so a
        // measured count and a guessed one stay distinguishable downstream.
        // Input tokens are never guessed; they are reported or absent.
        const partialUsageOnCancel = (): TokenUsage => {
          const toolCallCount = toolCalls.length || undefined;
          if (lastUsage) {
            return { ...lastUsage, toolCalls: toolCallCount };
          }

          const streamed = guardrailContentToText(
            (aggregatedChunk as { content?: unknown } | null)?.content,
          );
          const outputTokens = streamed ? Math.ceil(streamed.length / 4) : 0;
          return {
            outputTokens,
            totalTokens: outputTokens,
            toolCalls: toolCallCount,
          };
        };

        // Output guardrail (streaming): the text has already reached the
        // client, so this is a post-hoc audit — violations land in the
        // evaluation log and alert metrics rather than blocking the stream.
        // It runs on a cancelled stream too: those tokens were delivered, and
        // auditing only completed answers would let a caller skip the audit by
        // hanging up.
        const auditStreamedOutput = (source: string) => {
          if (!model.outputGuardrailKey) return;

          const streamedText = guardrailContentToText(
            (aggregatedChunk as { content?: unknown } | null)?.content,
          );
          if (!streamedText.trim()) return;

          fireAndForget('guardrail-stream-output-audit', async () => {
            await evaluateGuardrail({
              tenantDbName,
              tenantId: model.tenantId,
              projectId,
              guardrailKey: model.outputGuardrailKey!,
              text: streamedText,
              phase: 'output',
              requestId,
              source,
            });
          });
        };

        try {
          // OpenAI opens every stream with the assistant role before any content.
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(openAIStreamRoleChunk(chunkOptions))}\n\n`),
          );

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
              completionId,
              created: completionCreated,
            });
            const choice = payload.choices[0];
            if (typeof choice?.finish_reason === 'string') {
              terminalFinishReason = choice.finish_reason;
            }
            const delta = choice?.delta as Record<string, unknown> | undefined;
            if (
              guardrailContentToText(delta?.content).trim()
              || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
            ) {
              hasFinalOutput = true;
            }
            if (terminalFinishReason === 'length' && !hasFinalOutput) {
              outputLimitError = new OutputTokenLimitError(outputTokenLimit);
            }

            if (payload.usage) {
              lastUsage = {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
                cachedInputTokens: payload.usage.cached_tokens,
                totalTokens: payload.usage.total_tokens,
              };
              // `usage` is only allowed on the wire when the caller asked for
              // it with `stream_options.include_usage`, and then only on a
              // dedicated final frame. We were attaching it to whichever
              // content chunk happened to carry it, which is a shape strict
              // OpenAI clients do not expect on a delta.
              finalUsagePayload = payload.usage;
              payload.usage = undefined;
            }

            if (!outputLimitError) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
              );
            }
          }

          if (outputLimitError) {
            const normalizedError = normalizeInferenceError(outputLimitError);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                error: normalizedError.error,
                request_id: requestId,
              })}\n\n`),
            );
          }

          if (!outputLimitError && includeStreamUsage && finalUsagePayload) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: completionCreated,
                model: model.modelId,
                choices: [],
                usage: finalUsagePayload,
              })}\n\n`),
            );
          }

          // Some upstreams never send a terminal finish_reason. Clients that wait
          // for one would hang until the socket closed. A completion that ended in
          // tool calls must say so, or an agent client reads it as a finished
          // answer and never dispatches them.
          if (!outputLimitError && terminalFinishReason === undefined) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(openAIStreamStopChunk(
                chunkOptions,
                toolCalls.length ? 'tool_calls' : 'stop',
              ))}\n\n`),
            );
          }

          // `[DONE]` terminates every stream, including one that ended in an
          // error frame. Withholding it leaves a client that reads until the
          // sentinel — the OpenAI SDK, and everything built on it — blocked on
          // the socket instead of returning the error it was just handed.
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
              status: outputLimitError ? 'error' : 'success',
              providerRequest: sanitizeForLogging({
                model: modelKey,
                messages: body.messages,
                overrides,
                stream: true,
              }),
              providerResponse: sanitizeForLogging(providerResponse),
              errorMessage: outputLimitError?.message,
              latencyMs,
              usage,
            }),
          );

          auditStreamedOutput('chat.completions:stream');
        } catch (error: unknown) {
          const latencyMs = Date.now() - startedAt;

          // Only `cancel()` aborts this signal, and only a closed response
          // socket reaches `cancel()`. So an aborted signal means the client
          // walked away — the upstream call we abort in response then throws
          // out of the loop above. That is not a provider failure, and
          // recording it as one blamed us for every user who pressed stop:
          // the error rate rose, alerting fired, and the tokens the provider
          // had already generated (and bills us for) were written as zero.
          if (abortController.signal.aborted) {
            fireAndForget('log-stream-cancelled', () =>
              logModelUsage(tenantDbName, model, {
                requestId,
                route: 'chat.completions',
                status: 'cancelled',
                providerRequest: sanitizeForLogging({
                  model: modelKey,
                  messages: body.messages,
                  overrides,
                  stream: true,
                }),
                providerResponse: sanitizeForLogging({
                  cancelled: 'client_disconnected',
                  partial: aggregatedChunk ?? { tool_calls: toolCalls },
                  ...(lastUsage ? {} : { output_tokens_estimated: true }),
                }),
                latencyMs,
                usage: partialUsageOnCancel(),
              }),
            );
            auditStreamedOutput('chat.completions:stream:cancelled');
            // Nothing is left to write to: the controller is already cancelled,
            // and enqueueing on it throws.
            return;
          }

          const normalizedError = normalizeInferenceError(error);
          const errorMessage = normalizedError.error.message;
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

          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              error: normalizedError.error,
              request_id: requestId,
            })}\n\n`),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      },
      cancel(reason) {
        abortController.abort(reason);
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

  if (
    aiMessage.response_metadata?.finish_reason === 'length'
    && !guardrailContentToText(aiMessage.content).trim()
    && getToolCallCount(aiMessage) === 0
  ) {
    throw new OutputTokenLimitError(outputTokenLimit);
  }

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
  // (streamed responses are audited post-hoc after the stream completes).
  let finalResponse: unknown = response;
  if (model.outputGuardrailKey) {
    const outputOutcome = await enforceModelGuardrail({
      tenantDbName,
      tenantId: model.tenantId,
      projectId,
      guardrailKey: model.outputGuardrailKey,
      text: extractAssistantText(response),
      phase: 'output',
      requestId,
    });
    if (outputOutcome?.redactedText !== undefined) {
      const withChoices = finalResponse as { choices?: Array<{ message?: { content?: unknown } }> };
      if (withChoices?.choices?.[0]?.message) {
        finalResponse = {
          ...withChoices,
          choices: withChoices.choices.map((choice, index) =>
            index === 0 && choice.message
              ? { ...choice, message: { ...choice.message, content: outputOutcome.redactedText } }
              : choice,
          ),
        };
      }
    }
    if (outputOutcome && outputOutcome.findings.length > 0) {
      guardrailAnnotations.output = {
        guardrail_key: outputOutcome.guardrailKey,
        findings: outputOutcome.findings,
      };
    }
  }

  finalResponse = annotateResponseWithGuardrails(finalResponse, guardrailAnnotations);

  // Semantic cache: store the response for future lookups
  if (cacheEnabled && tenantId && model.semanticCache) {
    storeInCache({
      tenantDbName,
      tenantId,
      projectId,
      config: model.semanticCache,
      messages: body.messages as unknown[],
      response: response as Record<string, unknown>,
      variantKey: cacheVariantKey,
    }).catch((err) =>
      logger.warn('Failed to store response in cache', { error: err }),
    );
  }

  return {
    response: finalResponse as Record<string, unknown>,
    usage,
    latencyMs,
    requestId,
    cacheHit: false,
  };
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
