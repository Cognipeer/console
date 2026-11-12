/**
 * Pricing of an agent turn: the cost estimator the SDK's cost limit runs on, the
 * credit pricer of a managed model, and the price of a playground turn.
 */

import { isManagedModel, loadManagedCreditPricer } from '@/enterprise/managed-credits';
import type { AgentInvokeResult as AgentSdkInvokeResult } from '@cognipeer/agent-sdk';
import type { IAgentConfig, IModelPricing } from '@/lib/database';
import { budgetStopDetail, type SessionBudgetPlan, type SessionBudgetSettlement } from './sessionBudget';
import { buildCostEstimator, type AgentTurnOutcome } from './agentTurnState';
import type { AgentPlaygroundChatResult } from './agentChatTypes';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

/**
 * `limits.maxCostUsd` is enforced by the SDK only through a `costEstimator`;
 * without one the limit did nothing at all. Built when the limit is set — or
 * the session has a spend budget, which rides on the same SDK limit — and also
 * whenever a sub-agent runs on a model of its own: the SDK's per-request usage
 * carries the delegated calls too (each tagged with its sub-agent), and pricing
 * them takes their model's rates, not the parent's. Priced from the agent's
 * model and every model a sub-agent was given, so a delegated call spends from
 * the same budget at its own price.
 */
export async function buildAgentCostEstimator(
    config: IAgentConfig,
    primary: PricedModel,
    subagentModels: PricedModel[],
    sessionBudgetActive = false,
    onWarning?: (message: string) => void,
    tenantId?: string,
): Promise<ReturnType<typeof buildCostEstimator>> {
    const limited = sessionBudgetActive || Number(config.runtime?.limits?.maxCostUsd) > 0;
    // A model paid with credits has no token price: its turn cost is the sum of its calls, so the estimator is
    // built for it even without a limit.
    const primaryManaged = isManagedModel(primary);
    if (!limited && subagentModels.length === 0 && !primaryManaged) return undefined;
    const { calculateCost } = await import('@/lib/services/models/usageLogger');
    const creditPricer = primaryManaged || subagentModels.some((child) => isManagedModel(child))
        ? await loadManagedCreditPricer(tenantId)
        : null;
    const callPricer = (model: PricedModel) => creditCallPricer(creditPricer, model);
    const primaryPrice = primaryManaged ? callPricer(primary) : undefined;
    const models: Parameters<typeof buildCostEstimator>[0] = [
        { names: [primary.key, primary.modelId], pricing: primary.pricing, model: primary, ...(primaryPrice ? { price: primaryPrice } : {}) },
    ];
    for (const child of subagentModels) {
        if (child.key && child.key === primary.key) continue;
        const price = isManagedModel(child) ? callPricer(child) : undefined;
        models.push({ names: [child.key, child.modelId], pricing: child.pricing, model: child, noFallback: true, ...(price ? { price } : {}) });
        if (limited && !price && !(((child.pricing?.inputTokenPer1M ?? 0) > 0) || ((child.pricing?.outputTokenPer1M ?? 0) > 0))) {
            onWarning?.(`Sub-agent model "${child.key}" has no pricing, so its calls are not counted against the cost limit or the session budget.`);
        }
    }
    const estimator = buildCostEstimator(models, primary.pricing, calculateCost, primary, primaryPrice);
    if (!estimator && limited) {
        logger.warn('A cost limit is set but the agent model has no pricing; the cost limit cannot be enforced', {
            modelKey: primary.key,
        });
    }
    return estimator;
}

/**
 * One call of a model paid with credits, in USD at the rate the tenant's next credits would be taken at. Undefined
 * when there is no pricer (no host, plan limits off, no known rate): the model then stays unpriced.
 */
function creditCallPricer(
    pricer: Awaited<ReturnType<typeof loadManagedCreditPricer>>,
    model: PricedModel,
): ((usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) => number | null) | undefined {
    if (!pricer || !model.providerKey) return undefined;
    const query = { providerKey: model.providerKey, modelKey: model.key, modelId: model.modelId, kind: 'chat' as const };
    return (usage) => pricer(query, usage)?.usd ?? null;
}

/** What the cost estimator needs of a model: the names its requests are reported under, and its prices. */
export type PricedModel = { key?: string; modelId?: string; providerKey?: string; providerDriver?: string; pricing?: IModelPricing | null };

/**
 * Prices a turn from the model's own `pricing` record. `usage` is the console's
 * canonical shape: `inputTokens` is the whole prompt, with the cache-read and
 * cache-write counts as subsets of it, each billed at its own rate.
 *
 * Returns undefined rather than 0 when the model has no pricing configured —
 * a displayed "$0.00" reads as "this was free", which is a different claim
 * from "nobody told the console what this model costs".
 */
async function priceTurn(
    pricing: IModelPricing | null | undefined,
    usage: AgentPlaygroundChatResult['usage'],
    model?: { providerDriver?: string; modelId?: string },
): Promise<number | undefined> {
    if (!pricing || !usage) return undefined;
    try {
        const { calculateCost } = await import('@/lib/services/models/usageLogger');
        return calculateCost(pricing, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            ...(usage.cachedWriteTokens ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
        }, model).totalCost;
    } catch {
        return undefined;
    }
}

/** The cache-write count of one SDK ledger request: a ledger field if the SDK has one, else the raw message usage. */
function ledgerCacheWriteTokens(usage: {
    prompt_tokens_details?: { cache_write_tokens?: number };
    raw?: { prompt_tokens_details?: { cache_write_tokens?: number }; cache_write_tokens?: number };
} | undefined): number {
    return Number(
        usage?.prompt_tokens_details?.cache_write_tokens
        ?? usage?.raw?.prompt_tokens_details?.cache_write_tokens
        ?? usage?.raw?.cache_write_tokens,
    ) || 0;
}

/**
 * What a turn cost. With a budget in force this is the SDK's own per-request
 * usage priced by the cost estimator — the figure the budget was enforced
 * against, sub-agent models at their own prices. A turn that delegated is priced
 * the same way even without a budget: the SDK's ledger holds the sub-agents'
 * model calls next to the parent's (each tagged `subagent`, with the model it
 * ran on), so the turn's total at the primary model's price would charge a
 * cheaper or dearer child at the wrong rate. Otherwise (or when the SDK
 * reported no per-request usage) it is the turn's total usage at the primary
 * model's price. Both read the console's canonical usage (the gateway chat model hands the
 * SDK inclusive prompt/completion counts), so the two agree on a single-request turn.
 */
export async function priceAgentTurn(input: {
    plan: SessionBudgetPlan | null;
    result: Pick<AgentSdkInvokeResult, 'state'>;
    costEstimator: ReturnType<typeof buildCostEstimator>;
    pricing: IModelPricing | null | undefined;
    usage: AgentPlaygroundChatResult['usage'];
    /** Driver + model id of the pricing's model (a Claude cache write follows the provider's rate). */
    model?: { providerKey?: string; providerDriver?: string; modelId?: string };
}): Promise<number | undefined> {
    const perRequest = (input.result.state as {
        usage?: {
            perRequest?: Array<{
                modelName?: string;
                subagent?: { name?: string };
                usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
                    completion_tokens_details?: { reasoning_tokens?: number };
                    // The SDK message usage as the provider adapter reported it: agent-sdk
                    // 0.20's ledger keeps a cache write only here, not in the normalized fields.
                    raw?: {
                        prompt_tokens_details?: { cache_write_tokens?: number };
                        cache_write_tokens?: number;
                    };
                };
            }>;
        };
    } | undefined)?.usage?.perRequest;
    // A turn whose own model has no price stays unpriced however its children are priced:
    // a cost that left the parent's calls out would read as the whole bill.
    const estimate = input.costEstimator;
    // A model paid with credits is charged per call (by its tier), never at a token price: only its calls price it.
    const perCall = isManagedModel(input.model);
    if (
        estimate && Array.isArray(perRequest) && perRequest.length > 0
        && (perCall || input.plan || (input.pricing && perRequest.some((request) => request.subagent)))
    ) {
        let cost = 0;
        for (const request of perRequest) {
            cost += estimate({
                modelName: request.modelName,
                inputTokens: Number(request.usage?.prompt_tokens) || 0,
                outputTokens: Number(request.usage?.completion_tokens) || 0,
                cachedInputTokens: Number(request.usage?.prompt_tokens_details?.cached_tokens) || 0,
                cacheWriteTokens: ledgerCacheWriteTokens(request.usage),
                reasoningTokens: Number(request.usage?.completion_tokens_details?.reasoning_tokens) || 0,
            }) || 0;
        }
        return cost;
    }
    // Its token price is 0, which would read as "free": a turn that cannot be priced by its calls stays unpriced.
    if (perCall) return undefined;
    return priceTurn(input.pricing, input.usage, input.model);
}

/**
 * The turn's outcome as it is reported when the SESSION budget stopped it: the
 * SDK's `limit` becomes `budget_reached`, with the budget's own wording.
 */
export function budgetAwareOutcome(outcome: AgentTurnOutcome, settlement: SessionBudgetSettlement | undefined): AgentTurnOutcome {
    return settlement?.reached ? { ...outcome, stopDetail: budgetStopDetail(settlement) } : outcome;
}
