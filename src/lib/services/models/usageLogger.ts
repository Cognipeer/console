import { getDatabase, IModel, IModelPricing } from '@/lib/database';

const TOKENS_PER_MILLION = 1_000_000;
const SECONDS_PER_THOUSAND = 1_000;
const CHARACTERS_PER_MILLION = 1_000_000;
const PAGES_PER_THOUSAND = 1_000;
const IMAGES_PER_THOUSAND = 1_000;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  // Non-token units used by STT / TTS / OCR / image models. Optional and only
  // honored when the model pricing exposes the matching per-unit rate.
  inputSeconds?: number;
  outputSeconds?: number;
  inputCharacters?: number;
  pages?: number;
  images?: number;
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
  cachedCost: number;
  totalCost: number;
}

export function calculateCost(
  pricing: IModelPricing,
  usage: TokenUsage,
): UsageCostResult {
  const currency = pricing.currency || 'USD';
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedTokens = usage.cachedInputTokens ?? 0;

  const inputCost =
    ((pricing.inputTokenPer1M ?? 0) * inputTokens) / TOKENS_PER_MILLION;
  const outputCost =
    ((pricing.outputTokenPer1M ?? 0) * outputTokens) / TOKENS_PER_MILLION;
  const cachedCost =
    ((pricing.cachedTokenPer1M ?? 0) * cachedTokens) / TOKENS_PER_MILLION;

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

  const totalCost = totalInputCost + totalOutputCost + cachedCost;

  return {
    currency,
    inputCost: totalInputCost,
    outputCost: totalOutputCost,
    cachedCost,
    totalCost,
  };
}

export async function logModelUsage(
  tenantDbName: string,
  model: IModel,
  payload: {
    requestId: string;
    route: string;
    status: 'success' | 'error';
    providerRequest: unknown;
    providerResponse: unknown;
    errorMessage?: string;
    latencyMs?: number;
    usage: TokenUsage;
    cacheHit?: boolean;
  },
) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const usage = payload.usage;
  const pricingSnapshot = {
    ...model.pricing,
    ...calculateCost(model.pricing, usage),
  };

  await db.createModelUsageLog({
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
    providerRequest: toRecord(payload.providerRequest),
    providerResponse: toRecord(payload.providerResponse),
    errorMessage: payload.errorMessage,
    latencyMs: payload.latencyMs,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    totalTokens:
      usage.totalTokens ??
      (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) +
        (usage.cachedInputTokens ?? 0),
    toolCalls: usage.toolCalls ?? 0,
    cacheHit: payload.cacheHit,
    pricingSnapshot,
  });
}
