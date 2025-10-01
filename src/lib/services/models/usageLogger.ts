import { getDatabase, IModel, IModelPricing } from '@/lib/database';

const TOKENS_PER_MILLION = 1_000_000;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
}

export interface UsageCostResult {
  currency: string;
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  totalCost: number;
}

export function calculateCost(pricing: IModelPricing, usage: TokenUsage): UsageCostResult {
  const currency = pricing.currency || 'USD';
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedTokens = usage.cachedInputTokens ?? 0;

  const inputCost = (pricing.inputTokenPer1M * inputTokens) / TOKENS_PER_MILLION;
  const outputCost = (pricing.outputTokenPer1M * outputTokens) / TOKENS_PER_MILLION;
  const cachedCost = (pricing.cachedTokenPer1M ?? 0) * cachedTokens / TOKENS_PER_MILLION;
  const totalCost = inputCost + outputCost + cachedCost;

  return {
    currency,
    inputCost,
    outputCost,
    cachedCost,
    totalCost,
  };
}

export async function logModelUsage(tenantDbName: string, model: IModel, payload: {
  requestId: string;
  route: string;
  status: 'success' | 'error';
  providerRequest: any;
  providerResponse: any;
  errorMessage?: string;
  latencyMs?: number;
  usage: TokenUsage;
}) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const usage = payload.usage;
  const pricingSnapshot = {
    ...model.pricing,
    ...calculateCost(model.pricing, usage),
  };

  await db.createModelUsageLog({
    tenantId: model.tenantId,
    modelKey: model.key,
    modelId: model._id ? (typeof model._id === 'string' ? model._id : model._id.toString()) : undefined,
    requestId: payload.requestId,
    route: payload.route,
    status: payload.status,
    providerRequest: payload.providerRequest,
    providerResponse: payload.providerResponse,
    errorMessage: payload.errorMessage,
    latencyMs: payload.latencyMs,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    totalTokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cachedInputTokens ?? 0)),
    toolCalls: usage.toolCalls ?? 0,
    pricingSnapshot,
  });
}
