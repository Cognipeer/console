import {
  getDatabase,
  IModel,
  IModelPricing,
  IModelUsageLog,
  IModelUsageRouting,
  ModelUsageStatus,
} from '@/lib/database';
import { currentRestrictedKnowledgeTags } from '@/lib/services/rag/access/exposure';
import type { RoutingRunAttribution } from './routingCallerContext';
import {
  recordUsageEvent,
  type UsageAttribution,
} from '@/lib/services/usage/usageEvents';
import {
  redactLogPayload,
  redactLogString,
} from '@/lib/services/logRedaction';
import {
  redactPiiFromLogPayload,
  redactPiiFromLogString,
} from '@/lib/services/logPiiRedaction';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';
import { normalizeFinishReason } from '@/lib/shared/finishReason';
import { recordRoutedUsage } from './dynamicRoutingState';
import { resolveTokenRates, tokenRateOptionsFor } from './pricingRates';

export { hasCacheReadPrice, hasCacheWritePrice, resolveTokenRates, type TokenRates } from './pricingRates';

const TOKENS_PER_MILLION = 1_000_000;
const SECONDS_PER_THOUSAND = 1_000;
const CHARACTERS_PER_MILLION = 1_000_000;
const PAGES_PER_THOUSAND = 1_000;
const IMAGES_PER_THOUSAND = 1_000;

/**
 * One model call's usage. `inputTokens` is the WHOLE prompt (uncached, cache-read
 * and cache-write tokens) and `outputTokens` the whole completion (visible and
 * reasoning); the cache and reasoning counts are SUBSETS of them, never added on
 * top. `toGatewayUsage` turns every provider's shape into this one.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Subset of `inputTokens` read from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Subset of `inputTokens` written to the provider's prompt cache (Anthropic
   *  `cache_creation_input_tokens`, Bedrock `cacheWriteInputTokens`). */
  cachedWriteTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  // Non-token units used by STT / TTS / OCR / image models. Optional and only
  // honored when the model pricing exposes the matching per-unit rate.
  inputSeconds?: number;
  outputSeconds?: number;
  inputCharacters?: number;
  pages?: number;
  images?: number;
  /** Subset of `outputTokens` (e.g. OpenAI `completion_tokens_details.reasoning_tokens`).
   *  Recorded for attribution only — never added into `totalTokens` and never
   *  fed into `calculateCost` / any pricing arithmetic below. */
  reasoningTokens?: number;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return { value };
}

export interface UsageCostResult {
  currency: string;
  inputCost: number;
  outputCost: number;
  /** The cache-read slice of the prompt. */
  cachedCost: number;
  /** The cache-write slice of the prompt. */
  cacheWriteCost: number;
  totalCost: number;
  /** Cache tokens this cost priced at an assumed rate (the input rate, 1.25 x it for a Claude cache write)
   *  because the model has no price entered for them. Absent when nothing was assumed. */
  assumedRates?: Array<'cacheRead' | 'cacheWrite'>;
}

/**
 * `model` (driver + model id) lets the cache-write rate follow the provider: a Claude model whose cache-write
 * price was not entered is billed at 1.25 x the input price and flagged as assumed (see `resolveTokenRates`).
 */
export function calculateCost(
  pricing: IModelPricing,
  usage: TokenUsage,
  model?: { providerDriver?: string; modelId?: string },
): UsageCostResult {
  const currency = pricing.currency || 'USD';
  const rates = resolveTokenRates(pricing, model ? tokenRateOptionsFor(model.providerDriver, model.modelId) : undefined);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteTokens = usage.cachedWriteTokens ?? 0;

  // Cache reads and writes are *subsets* of the prompt count, not additions to
  // it — that is true of OpenAI's `prompt_tokens_details.cached_tokens`, of
  // LangChain's standardized `input_token_details.cache_read` and of the
  // Anthropic / Bedrock counts once `toGatewayUsage` has folded them in. Billing
  // the full prompt at the input rate and then adding a cached portion again
  // charges those tokens twice. Each slice is priced in full at its own rate.
  const uncachedInputTokens = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);

  const inputCost = (rates.input * uncachedInputTokens) / TOKENS_PER_MILLION;
  const outputCost = (rates.output * outputTokens) / TOKENS_PER_MILLION;
  const cachedCost = (rates.cacheRead * cachedTokens) / TOKENS_PER_MILLION;
  const cacheWriteCost = (rates.cacheWrite * cacheWriteTokens) / TOKENS_PER_MILLION;

  // A free model (input rate 0) assumes nothing: every slice is free either way.
  const assumedRates: Array<'cacheRead' | 'cacheWrite'> = [];
  if (rates.input > 0 && cachedTokens > 0 && rates.cacheReadAssumed) assumedRates.push('cacheRead');
  if (rates.input > 0 && cacheWriteTokens > 0 && rates.cacheWriteAssumed) assumedRates.push('cacheWrite');

  // Non-token components. Each contributes to either inputCost or outputCost
  // depending on direction so the existing aggregate fields stay meaningful.
  const audioInputCost =
    ((pricing.inputSecondPer1K ?? 0) * (usage.inputSeconds ?? 0)) /
    SECONDS_PER_THOUSAND;
  const audioOutputCost =
    ((pricing.outputSecondPer1K ?? 0) * (usage.outputSeconds ?? 0)) /
    SECONDS_PER_THOUSAND;
  const characterInputCost =
    ((pricing.inputCharacterPer1M ?? 0) * (usage.inputCharacters ?? 0)) /
    CHARACTERS_PER_MILLION;
  const pageInputCost =
    ((pricing.pagePer1K ?? 0) * (usage.pages ?? 0)) / PAGES_PER_THOUSAND;
  const imageInputCost =
    ((pricing.imagePer1K ?? 0) * (usage.images ?? 0)) / IMAGES_PER_THOUSAND;

  const totalInputCost =
    inputCost + audioInputCost + characterInputCost + pageInputCost + imageInputCost;
  const totalOutputCost = outputCost + audioOutputCost;

  const totalCost = totalInputCost + totalOutputCost + cachedCost + cacheWriteCost;

  return {
    currency,
    inputCost: totalInputCost,
    outputCost: totalOutputCost,
    cachedCost,
    cacheWriteCost,
    totalCost,
    ...(assumedRates.length > 0 ? { assumedRates } : {}),
  };
}

export async function logModelUsage(
  tenantDbName: string,
  model: IModel,
  payload: {
    requestId: string;
    route: string;
    status: ModelUsageStatus;
    providerRequest: unknown;
    providerResponse: unknown;
    errorMessage?: string;
    latencyMs?: number;
    usage: TokenUsage;
    cacheHit?: boolean;
    routing?: IModelUsageRouting;
    /** Dynamic LLM child rows: the baseline model's pricing, used to record
     *  what this call's realized usage would have cost there. Not persisted. */
    routingBaselinePricing?: IModelPricing;
    /** Driver + model id of the baseline model (its cache-write rate follows the provider). */
    routingBaselineModel?: { providerDriver?: string; modelId?: string };
    /** Explicit attribution for call sites outside the request ALS scope. */
    attribution?: Partial<UsageAttribution>;
    /** Agent the call runs for; the usage rollup's `agent` dimension, and a column of the row. */
    agentKey?: string;
    /** The door the call came through (`RoutingCallerContext.channel`); a column of the row. */
    channel?: string;
    /** The agent run the call belongs to, as known when it settled; columns of the row (the per-turn ledger). */
    run?: RoutingRunAttribution;
    /** Raw provider finish reason for this call (e.g. `stop`, `length`,
     *  `tool_calls`) — a property of the call, not of token usage. Normalized
     *  via `normalizeFinishReason` before persisting. */
    finishReason?: string;
  },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const usage = payload.usage;
  // reasoningTokens is a SUBSET of outputTokens (e.g. OpenAI
  // `completion_tokens_details.reasoning_tokens`) — recorded below for
  // attribution only. It must never be added into totalTokens and never
  // flows into calculateCost / pricingSnapshot.
  const pricingSnapshot = {
    ...model.pricing,
    ...calculateCost(model.pricing, usage, model),
  };
  // The cache counts are subsets of inputTokens: a total never adds them again.
  const totalTokens =
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

  let routing = payload.routing;
  // A semantic-cache hit costs nothing on any model, so it is not a routing
  // saving — leave its baseline unset rather than credit the router with it.
  if (routing?.role === 'child' && payload.routingBaselinePricing && !payload.cacheHit) {
    routing = {
      ...routing,
      baselineCostUsd: calculateCost(payload.routingBaselinePricing, usage, payload.routingBaselineModel).totalCost,
    };
  }
  if (routing && (routing.role === 'child' || routing.role === 'decider')) {
    void recordRoutedUsage({
      tenantDbName,
      routing,
      modelKey: model.key,
      usage,
      costUsd: pricingSnapshot.totalCost,
      status: payload.status,
    });
  }

  const units: Record<string, number> = {};
  if (usage.toolCalls) units.toolCalls = usage.toolCalls;
  if (usage.inputSeconds) units.inputSeconds = usage.inputSeconds;
  if (usage.outputSeconds) units.outputSeconds = usage.outputSeconds;
  if (usage.inputCharacters) units.inputCharacters = usage.inputCharacters;
  if (usage.pages) units.pages = usage.pages;
  if (usage.images) units.images = usage.images;

  const attribution = recordUsageEvent({
    tenantDbName,
    tenantId: model.tenantId,
    projectId: model.projectId,
    service: 'models',
    refKey: model.key,
    status: payload.status,
    latencyMs: payload.latencyMs,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cachedWriteTokens: usage.cachedWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens,
    costUsd: pricingSnapshot.totalCost,
    units,
    attribution: payload.attribution,
    ...(payload.agentKey ? { agentKey: payload.agentKey } : {}),
  });

  // Health rollup: one observation per logged call. Cache hits carry a tiny
  // latency that would skew the histogram, so they count as requests only.
  recordEntityMetric({
    tenantDbName,
    tenantId: model.tenantId,
    projectId: model.projectId,
    entityType: 'model',
    entityKey: model.key,
    source: 'gateway',
    outcome:
      payload.status === 'success' ? 'ok' : payload.status === 'cancelled' ? 'cancelled' : 'error',
    latencyMs: payload.cacheHit ? null : payload.latencyMs,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    costUsd: pricingSnapshot.totalCost,
  });

  // Secret scrub first (known key names / outbound secret values), then a
  // free-text PII pass -- a customer's email or name inside
  // messages[].content has no distinctive key or known value to match
  // against the way a secret does, so it can only be found by scanning
  // the text itself. See logPiiRedaction.ts.
  // Read before the awaits below: what the work had handed on when the call settled.
  const kbRestricted = currentRestrictedKnowledgeTags();
  const [providerRequest, providerResponse, errorMessage] = await Promise.all([
    redactPiiFromLogPayload(redactLogPayload(payload.providerRequest)),
    redactPiiFromLogPayload(redactLogPayload(payload.providerResponse)),
    redactPiiFromLogString(redactLogString(payload.errorMessage)),
  ]);

  await db.createModelUsageLog({
    userId: attribution.userId,
    apiTokenId: attribution.apiTokenId,
    actorType: attribution.actorType,
    tenantId: model.tenantId,
    projectId: model.projectId,
    modelKey: model.key,
    modelId: model._id
      ? typeof model._id === 'string'
        ? model._id
        : model._id.toString()
      : undefined,
    requestId: payload.requestId,
    route: payload.route,
    status: payload.status,
    providerRequest: toRecord(providerRequest),
    providerResponse: toRecord(providerResponse),
    errorMessage,
    latencyMs: payload.latencyMs,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cachedWriteTokens: usage.cachedWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens,
    totalTokens,
    toolCalls: usage.toolCalls ?? 0,
    cacheHit: payload.cacheHit,
    pricingSnapshot,
    routing,
    finishReason: normalizeFinishReason(payload.finishReason),
    ...(payload.agentKey ? { agentKey: payload.agentKey } : {}),
    ...(payload.channel ? { channel: payload.channel } : {}),
    ...runColumns(payload.run),
    ...(kbRestricted.length > 0 ? { kbRestricted } : {}),
  });
}

/** The run attribution's string fields, as row columns. */
function runColumns(run: RoutingRunAttribution | undefined): Pick<IModelUsageLog, 'conversationId' | 'turnId' | 'runId' | 'traceSessionId'> {
  const columns: Pick<IModelUsageLog, 'conversationId' | 'turnId' | 'runId' | 'traceSessionId'> = {};
  if (!run) return columns;
  for (const key of ['conversationId', 'turnId', 'runId', 'traceSessionId'] as const) {
    const value = run[key];
    if (typeof value === 'string' && value) columns[key] = value;
  }
  return columns;
}
