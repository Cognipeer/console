/**
 * Dynamic LLM resolution of the gateway: a router model owns no provider, it picks
 * a concrete child model per request (rules, a decider, a pool policy, cost
 * guards, shadow mode) and calls it through the core.
 */

import crypto from 'crypto';
import { fireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { IModel, runWithTenantScope } from '@/lib/database';
import type {
  DynamicPoolPolicy,
  IDynamicPoolEstimate,
  IDynamicRoutingConfig,
  IDynamicRoutingTarget,
  IModelUsageRouting,
} from '@/lib/database';
import { listUserGroupIds } from '@/lib/iam/groupGrants';
import type { DecisionQuestion } from '@/lib/providers';
import type { ParsedDecisionRequest } from '@/lib/providers/contracts/decisionHelpers';
import { mergeRoutingCaller } from './routingCallerContext';
import { getModelByKey } from './modelService';
import { logModelUsage, type TokenUsage } from './usageLogger';
import { OutputTokenLimitError } from './openaiErrors';
import { describeRequestContract, sanitizeForLogging } from './gatewayRequest';
import { openAiMessagesToNative, type OpenAIMessage } from './openaiAdapter';
import type { ModelCallInput, ModelCallOutcome } from './gatewayTypes';
import {
  COMPLEXITY_QUESTION_ID,
  DECIDER_QUESTION_ID,
  applyCostGuards,
  buildComplexityQuestion,
  buildDeciderMessages,
  buildDeciderQuestion,
  candidateIneligibility,
  deriveConversationId,
  estimateRequestCostUsd,
  evaluateRules,
  extractRoutingSignals,
  getDynamicRoutingConfig,
  isInCanary,
  normalizeTarget,
  parseDeciderLabel,
  pickDecisionLabel,
  predictOutputTokens,
  primaryModelKey,
  publicSignals,
  rulesReferenceSignal,
  segmentKey,
  selectPoolCandidate,
  type PoolCandidateEstimate,
  type RoutingSignals,
} from './dynamicRouting';
import {
  getConversationCostUsd,
  getConversationState,
  getModelProfiles,
  getRouterSpendUsd,
  getSegmentIoRatio,
  type ConversationState,
} from './dynamicRoutingState';
import { resolveModelCapabilities } from './modelCapabilities';

const logger = createLogger('inference');

/** Output tokens a router assumes when neither max_tokens nor history is known. */
const DEFAULT_ROUTER_OUTPUT_TOKENS = 512;

/** A decision request over the latest user message, for router-side decider / scoring calls. */
function decisionRequestFor(
  modelKey: string,
  signals: RoutingSignals,
  questions: Record<string, DecisionQuestion>,
): ParsedDecisionRequest {
  return {
    model: modelKey,
    input: [{ type: 'text', text: signals.lastUserText || '(empty request)' }],
    questions,
    includeRationale: false,
  };
}

// ── Dynamic LLM resolution ────────────────────────────────────────────────
// Resolves a Dynamic LLM router to a concrete child model and invokes it through
// the gateway core (recursively, depth-guarded). The decision runs in
// layers: rules / the decider pick a *target* (a fixed model or a pool), the
// pool's policy picks one candidate, and router-wide guards may move the
// request to a cheaper model. The router records its own decision row (route
// 'chat.completions.router', pricing zero); the child + decider rows carry the
// same routing metadata as attribution (`role: 'child' | 'decider'`) and log
// their real usage, so cost is never double-counted and every routed dollar
// can be traced back to the router, route and policy that spent it.

/** A router guard refused the request (budget exhausted, `onExceeded: 'reject'`). */
export class DynamicRoutingBudgetError extends Error {
  readonly status = 429;
  readonly code = 'router_budget_exceeded';
  constructor(message: string) {
    super(message);
    this.name = 'DynamicRoutingBudgetError';
  }
}

interface ResolvedChoice {
  modelKey: string;
  estimatedCostUsd?: number;
  predictedOutputTokens?: number;
  policy?: DynamicPoolPolicy;
  pool?: IDynamicPoolEstimate[];
  /** Cheapest eligible candidate — what a tripped guard downgrades to. */
  downgrade?: { modelKey: string; estimatedCostUsd?: number } | null;
  reason?: string;
}

export async function resolveDynamicCompletion(args: {
  input: ModelCallInput;
  /** The OpenAI-shaped view the routing signals, the conversation id and the router row read. */
  wire: Record<string, unknown>;
  router: IModel;
  config: IDynamicRoutingConfig;
  depth: number;
  /** The core: a child (and a chat decider) is an ordinary call into it, one level deeper. */
  execute: (input: ModelCallInput) => Promise<ModelCallOutcome>;
}): Promise<ModelCallOutcome> {
  const { input, wire, router, config, depth, execute } = args;
  const { tenantDbName, tenantId, projectId, stream } = input;
  const onUsageSettled = input.context?.onUsageSettled;
  const callerContext = mergeRoutingCaller(input.context?.callerContext);
  const start = Date.now();
  const routerRequestId =
    typeof wire.request_id === 'string' && wire.request_id.length > 0
      ? wire.request_id
      : crypto.randomUUID();

  const signals = extractRoutingSignals(wire, callerContext && { ...callerContext, projectId: callerContext.projectId ?? projectId });
  const conversationId = deriveConversationId(wire as { messages?: unknown; metadata?: unknown; user?: unknown });
  const guards = config.guards;
  const defaultOutputTokens = config.defaultOutputTokens ?? DEFAULT_ROUTER_OUTPUT_TOKENS;
  const baselineModelKey = config.baselineModelKey || config.defaultModelKey;

  // Per-request memo: a pool, a guard and the baseline can all ask for the
  // same model, history or counter.
  const models = new Map<string, Promise<IModel | null>>();
  const loadModel = (key: string) => {
    let pending = models.get(key);
    if (!pending) {
      pending = getModelByKey(tenantDbName, key, projectId).catch(() => null);
      models.set(key, pending);
    }
    return pending;
  };
  let conversationState: Promise<ConversationState> | undefined;
  const getConversation = () =>
    (conversationState ??= getConversationState(tenantDbName, router.key, conversationId));
  let conversationCost: Promise<number | undefined> | undefined;
  const getConversationCost = () =>
    (conversationCost ??= getConversationCostUsd(tenantDbName, router.key, conversationId));
  let budgetPct: Promise<number | undefined> | undefined;
  const getBudgetPct = () =>
    (budgetPct ??= (async () => {
      const budget = guards?.budget;
      if (!budget || !(budget.limitUsd > 0)) return undefined;
      const spent = await getRouterSpendUsd(tenantDbName, router.key, budget.windowHours);
      return spent === undefined ? undefined : (spent / budget.limitUsd) * 100;
    })());

  // Decider / complexity-scorer attribution recorded on the router row (the scorer is the
  // decider of a rule-based router, so its latency belongs here too).
  let deciderModelKey: string | undefined;
  let deciderLatencyMs: number | undefined;

  // Lazy rule signals — computed only when a rule references them.
  if (config.strategy === 'rule-based') {
    const rules = config.rules ?? [];
    // Group membership is only looked up when a rule asks for it.
    if (
      rulesReferenceSignal(rules, 'groupIds') &&
      signals.caller?.userId &&
      signals.caller.groupIds === undefined
    ) {
      try {
        const userId = signals.caller.userId;
        const groupIds = await runWithTenantScope(tenantDbName, (db) => listUserGroupIds(db, userId));
        signals.caller = { ...signals.caller, groupIds };
      } catch (error) {
        logger.warn('Dynamic routing: group lookup failed; groupIds conditions will not match', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
    if (rulesReferenceSignal(rules, 'complexityScore') && config.complexity) {
      const scoringStart = Date.now();
      try {
        const { handleDecisionRequest } = await import('./decisionService');
        const outcome = await handleDecisionRequest({
          tenantDbName,
          projectId,
          request: decisionRequestFor(config.complexity.modelKey, signals, {
            [COMPLEXITY_QUESTION_ID]: buildComplexityQuestion(config.complexity),
          }),
          routing: {
            role: 'decider',
            routerKey: router.key,
            routerModelDbId: router._id ? String(router._id) : undefined,
            strategy: config.strategy,
            decision: 'rule',
            chosenModelKey: config.complexity.modelKey,
            reason: 'Complexity scoring',
            conversationId,
          },
        });
        // The scoring is part of what this request costs the caller.
        onUsageSettled?.(outcome.cost);
        const answer = outcome.result.answers[COMPLEXITY_QUESTION_ID];
        if (answer?.type === 'score') signals.complexityScore = answer.score;
      } catch (error) {
        // A missing signal never matches a condition, so the rules that depend
        // on it fall through to the default — same as an unreachable decider.
        logger.warn('Complexity scoring failed; rules on complexityScore will not match', {
          router: router.key,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // A failed scoring still delayed the request, so its time is recorded either way.
        deciderLatencyMs = Date.now() - scoringStart;
        deciderModelKey = config.complexity.modelKey;
      }
    }
    if (rulesReferenceSignal(rules, 'conversationCostUsd')) {
      signals.conversationCostUsd = await getConversationCost();
    }
    if (rulesReferenceSignal(rules, 'budgetUsedPct')) {
      signals.budgetUsedPct = await getBudgetPct();
    }
    if (rulesReferenceSignal(rules, 'predictedOutputTokens') || rulesReferenceSignal(rules, 'ioRatio')) {
      const ratio =
        (await getConversation()).ioRatio ?? getSegmentIoRatio(tenantDbName, router.key, '*')?.ratio;
      if (ratio !== undefined) {
        signals.ioRatio = ratio;
        const predicted = Math.round(signals.inputTokensEst * ratio);
        signals.predictedOutputTokens =
          signals.maxOutputTokens !== undefined ? Math.min(signals.maxOutputTokens, predicted) : predicted;
      }
    }
  }

  // ── Layer 1: rules / decider pick a target ─────────────────────────────
  let target: IDynamicRoutingTarget = config.defaultTarget
    ? normalizeTarget({ target: config.defaultTarget })
    : { modelKey: config.defaultModelKey };
  let route = 'default';
  let decision: IModelUsageRouting['decision'] = 'default';
  let matchedRuleLabel: string | undefined;
  let deciderLabel: string | undefined;
  let deciderProbability: number | undefined;
  let deciderConfidence: number | undefined;
  let deciderMargin: number | undefined;
  let reason = 'No rule matched; used default';

  const attribution = (role: 'router' | 'child' | 'decider'): IModelUsageRouting => ({
    role,
    routerKey: router.key,
    routerModelDbId: router._id ? String(router._id) : undefined,
    strategy: config.strategy,
    decision,
    chosenModelKey: '',
    reason,
    conversationId,
  });

  if (config.strategy === 'rule-based') {
    const rule = evaluateRules(config.rules ?? [], signals);
    if (rule) {
      target = normalizeTarget(rule);
      route = `rule:${rule.label}`;
      decision = 'rule';
      matchedRuleLabel = rule.label;
      reason = `Matched rule "${rule.label}"`;
    }
  } else if (config.strategy === 'model-based' && config.decider) {
    const decider = config.decider;
    deciderModelKey = decider.modelKey;
    const deciderStart = Date.now();
    try {
      const deciderModel = await loadModel(decider.modelKey);
      if (deciderModel?.category === 'decision') {
        const { handleDecisionRequest } = await import('./decisionService');
        const outcome = await handleDecisionRequest({
          tenantDbName,
          projectId,
          request: decisionRequestFor(decider.modelKey, signals, {
            [DECIDER_QUESTION_ID]: buildDeciderQuestion(decider),
          }),
          routing: { ...attribution('decider'), chosenModelKey: decider.modelKey },
        });
        deciderLatencyMs = Date.now() - deciderStart;
        // The classification is part of what this request costs the caller.
        onUsageSettled?.(outcome.cost);
        const pick = pickDecisionLabel(outcome.result.answers[DECIDER_QUESTION_ID], decider);
        deciderProbability = pick.probability;
        deciderConfidence = pick.confidence;
        deciderMargin = pick.margin;
        if (pick.label && pick.belowThreshold) {
          if (decider.belowConfidence) target = normalizeTarget({ target: decider.belowConfidence });
          route = `label:${pick.label.label}:low-confidence`;
          decision = 'model';
          deciderLabel = pick.label.label;
          reason = `Decider "${decider.modelKey}" chose "${pick.label.label}" below minConfidence ${decider.minConfidence}; used ${decider.belowConfidence ? 'the fallback target' : 'default'}`;
        } else if (pick.label) {
          target = normalizeTarget(pick.label);
          route = `label:${pick.label.label}`;
          decision = 'model';
          deciderLabel = pick.label.label;
          reason = `Decider "${decider.modelKey}" classified as "${pick.label.label}"`;
        } else {
          reason = `Decider "${decider.modelKey}" gave no usable answer; used default`;
        }
      } else {
        // Legacy chat decider (configs saved before decision models existed).
        const deciderResult = await execute({
          tenantDbName,
          tenantId,
          projectId,
          modelKey: decider.modelKey,
          request: {
            messages: openAiMessagesToNative(buildDeciderMessages(decider, signals) as OpenAIMessage[]),
            temperature: 1,
            maxTokens: 256,
          },
          context: {
            routingDepth: depth + 1,
            onUsageSettled,
            routedBy: { routing: { ...attribution('decider'), chosenModelKey: decider.modelKey } },
          },
        });
        deciderLatencyMs = Date.now() - deciderStart;
        const text = deciderResult.result?.response.content ?? '';
        const label = parseDeciderLabel(text, decider.labels);
        if (label) {
          target = normalizeTarget(label);
          route = `label:${label.label}`;
          decision = 'model';
          deciderLabel = label.label;
          reason = `Decider "${decider.modelKey}" classified as "${label.label}"`;
        } else {
          reason = `Decider returned an unrecognized label "${text.slice(0, 40)}"; used default`;
        }
      }
    } catch (error) {
      deciderLatencyMs = Date.now() - deciderStart;
      reason = `Decider failed (${error instanceof Error ? error.message : 'error'}); used default`;
    }
  }

  // Never route back to the router itself (would loop until the depth cap).
  if (target.pool) {
    const pool = target.pool.filter((c) => c.modelKey && c.modelKey !== router.key);
    target = pool.length > 0 ? { ...target, pool } : { modelKey: config.defaultModelKey };
  }
  if (!target.pool && (!target.modelKey || target.modelKey === router.key)) {
    target = { modelKey: config.defaultModelKey === router.key ? '' : config.defaultModelKey };
  }

  const segment = segmentKey(route, signals);
  const costAware = Boolean(target.pool) || Boolean(guards);

  // ── Layer 2: the pool's policy picks a candidate ───────────────────────
  const estimateFixed = async (modelKey: string): Promise<{ modelKey: string; estimatedCostUsd?: number; predictedOutputTokens?: number }> => {
    const model = await loadModel(modelKey);
    if (!model?.pricing) return { modelKey };
    const profile = (await getModelProfiles(tenantDbName, projectId, [modelKey])).get(modelKey);
    const output = predictOutputTokens('simple', signals.inputTokensEst, { modelAvgOutputTokens: profile?.avgOutputTokens }, {
      maxOutputTokens: signals.maxOutputTokens,
      defaultOutputTokens,
    });
    return {
      modelKey,
      estimatedCostUsd: estimateRequestCostUsd(model.pricing, signals.inputTokensEst, output),
      predictedOutputTokens: output,
    };
  };

  const resolvePool = async (
    pool: NonNullable<IDynamicRoutingTarget['pool']>,
    policy: DynamicPoolPolicy,
  ): Promise<ResolvedChoice> => {
    const keys = pool.map((c) => c.modelKey);
    const [candidates, profiles, conversation] = await Promise.all([
      Promise.all(keys.map(loadModel)),
      getModelProfiles(tenantDbName, projectId, keys),
      policy === 'token-profile' ? getConversation() : Promise.resolve<ConversationState>({}),
    ]);
    const mode = policy === 'token-profile' ? 'profile' : 'simple';
    const ratios = [...profiles.values()].map((p) => p?.ioRatio).filter((r): r is number => r !== undefined);
    const poolMeanIoRatio = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : undefined;
    const segmentIoRatio = getSegmentIoRatio(tenantDbName, router.key, segment)?.ratio;
    const sticky = (guards?.sticky ?? true) ? conversation.lastModelKey : undefined;

    const estimates: PoolCandidateEstimate[] = pool.map((candidate, i) => {
      const tier = candidate.tier ?? 1;
      const model = candidates[i];
      if (!model) return { modelKey: candidate.modelKey, tier, eligible: false, skipped: 'model not found' };
      if (getDynamicRoutingConfig(model)) {
        return { modelKey: candidate.modelKey, tier, eligible: false, skipped: 'nested router' };
      }
      const profile = profiles.get(candidate.modelKey) ?? undefined;
      const predicted = predictOutputTokens(
        mode,
        signals.inputTokensEst,
        {
          conversationIoRatio: conversation.ioRatio,
          segmentIoRatio,
          modelIoRatio: profile?.ioRatio,
          poolMeanIoRatio,
          modelAvgOutputTokens: profile?.avgOutputTokens,
        },
        { maxOutputTokens: signals.maxOutputTokens, defaultOutputTokens },
      );
      const skipped = candidateIneligibility(resolveModelCapabilities(model), signals, predicted);
      if (skipped) return { modelKey: candidate.modelKey, tier, eligible: false, skipped };
      // Only the model that already holds this conversation's prefix gets
      // cache-read pricing; switching away forfeits it.
      const cachedShare =
        mode === 'profile' && sticky === candidate.modelKey ? (profile?.cachedShare ?? 0) : 0;
      return {
        modelKey: candidate.modelKey,
        tier,
        eligible: true,
        predictedOutputTokens: predicted,
        estimatedCostUsd: model.pricing
          ? estimateRequestCostUsd(model.pricing, signals.inputTokensEst, predicted, cachedShare)
          : undefined,
      };
    });

    const persisted: IDynamicPoolEstimate[] = estimates.map((e) => ({
      modelKey: e.modelKey,
      tier: e.tier,
      ...(e.estimatedCostUsd !== undefined ? { estimatedCostUsd: e.estimatedCostUsd } : {}),
      ...(e.predictedOutputTokens !== undefined ? { predictedOutputTokens: e.predictedOutputTokens } : {}),
      ...(e.skipped ? { skipped: e.skipped } : {}),
    }));
    const selection = selectPoolCandidate(estimates, policy, {
      maxCostPerRequestUsd: guards?.maxCostPerRequestUsd,
      stickyModelKey: sticky,
      switchMarginPct: guards?.switchMarginPct,
    });
    const cheapest = estimates
      .filter((e) => e.eligible && e.estimatedCostUsd !== undefined)
      .sort((a, b) => (a.estimatedCostUsd ?? 0) - (b.estimatedCostUsd ?? 0))[0];
    const downgrade = cheapest ? { modelKey: cheapest.modelKey, estimatedCostUsd: cheapest.estimatedCostUsd } : null;
    if (!selection) {
      const fallback = await estimateFixed(config.defaultModelKey);
      return { ...fallback, policy, pool: persisted, downgrade, reason: 'No eligible pool candidate; used default model' };
    }
    return { ...selection, policy, pool: persisted, downgrade };
  };

  let proposed: ResolvedChoice;
  if (target.pool) {
    proposed = await resolvePool(target.pool, target.policy ?? 'best-under-cap');
  } else if (costAware) {
    proposed = { ...(await estimateFixed(target.modelKey ?? '')) };
    proposed.downgrade = guards?.economyModelKey ? await estimateFixed(guards.economyModelKey) : null;
  } else {
    proposed = { modelKey: target.modelKey ?? '' };
  }

  // ── Layer 3: guards ────────────────────────────────────────────────────
  let guard: string | undefined;
  let guardReason: string | undefined;
  let rejectReason: string | undefined;
  if (guards && proposed.modelKey) {
    const [conversationCostUsd, budgetUsedPct] = await Promise.all([
      guards.conversationBudgetUsd !== undefined ? getConversationCost() : Promise.resolve(undefined),
      guards.budget ? getBudgetPct() : Promise.resolve(undefined),
    ]);
    const outcome = applyCostGuards(proposed, guards, { conversationCostUsd, budgetUsedPct }, proposed.downgrade ?? null);
    guard = outcome.guard;
    guardReason = outcome.reason;
    if (outcome.reject) rejectReason = outcome.reason;
    if (outcome.modelKey !== proposed.modelKey) {
      const moved = proposed.pool?.find((e) => e.modelKey === outcome.modelKey);
      proposed = {
        ...proposed,
        modelKey: outcome.modelKey,
        estimatedCostUsd: outcome.estimatedCostUsd,
        predictedOutputTokens: moved?.predictedOutputTokens ?? proposed.predictedOutputTokens,
      };
    }
  }

  const proposedReason = [proposed.reason, guardReason].filter(Boolean).join('; ');

  // ── Shadow / canary ────────────────────────────────────────────────────
  // Shadow keeps traffic on each target's primary model and only records the
  // decision the pool + guards would have made.
  const enforced = config.mode !== 'shadow' && isInCanary(conversationId, config.canaryPercent);
  let chosenModelKey = proposed.modelKey;
  let shadow: IModelUsageRouting['shadow'];
  let mode: IModelUsageRouting['mode'] = 'enforce';
  if (costAware && !enforced) {
    mode = 'shadow';
    const primary = primaryModelKey(target) || config.defaultModelKey;
    shadow = {
      chosenModelKey: proposed.modelKey,
      estimatedCostUsd: proposed.estimatedCostUsd,
      reason: proposedReason || 'Pool / guard decision',
      ...(proposed.policy ? { policy: proposed.policy } : {}),
      ...(guard ? { guard } : {}),
    };
    chosenModelKey = primary;
    if (primary !== proposed.modelKey) {
      const primaryEstimate = proposed.pool?.find((e) => e.modelKey === primary);
      proposed = {
        ...proposed,
        modelKey: primary,
        estimatedCostUsd: primaryEstimate?.estimatedCostUsd,
        predictedOutputTokens: primaryEstimate?.predictedOutputTokens,
      };
    }
    rejectReason = undefined;
  }
  if (mode === 'enforce' && proposedReason) reason = `${reason}; ${proposedReason}`;
  if (chosenModelKey === router.key) chosenModelKey = '';

  const baselinePricing = (await loadModel(baselineModelKey))?.pricing;

  const buildRouting = (
    role: 'router' | 'child',
    chosen: string,
    decisionValue: IModelUsageRouting['decision'],
    reasonValue: string,
  ): IModelUsageRouting => ({
    role,
    routerKey: router.key,
    routerModelDbId: router._id ? String(router._id) : undefined,
    strategy: config.strategy,
    decision: decisionValue,
    chosenModelKey: chosen,
    matchedRuleLabel,
    deciderLabel,
    deciderModelKey,
    deciderLatencyMs,
    deciderProbability,
    deciderConfidence,
    deciderMargin,
    reason: reasonValue,
    ...(role === 'router' ? { signals: publicSignals(signals) } : {}),
    ...(proposed.policy ? { policy: proposed.policy } : {}),
    ...(role === 'router' && proposed.pool ? { pool: proposed.pool } : {}),
    ...(guard && mode === 'enforce' ? { guard } : {}),
    ...(chosen === proposed.modelKey && proposed.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: proposed.estimatedCostUsd }
      : {}),
    ...(chosen === proposed.modelKey && proposed.predictedOutputTokens !== undefined
      ? { predictedOutputTokens: proposed.predictedOutputTokens }
      : {}),
    conversationId,
    segment,
    mode,
    ...(shadow ? { shadow } : {}),
    baselineModelKey,
  });

  const runChild = (childKey: string, routing: IModelUsageRouting) =>
    execute({
      ...input,
      modelKey: childKey,
      context: {
        ...input.context,
        routingDepth: depth + 1,
        callerContext,
        routedBy: { routing, baselinePricing },
      },
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
          messages: input.context?.logPrompt === false
            ? { count: Array.isArray(wire.messages) ? wire.messages.length : 0 }
            : wire.messages,
          ...input.context?.requestTags,
          signals: routing.signals,
          ...describeRequestContract(wire),
        }),
        providerResponse: sanitizeForLogging({
          chosenModelKey: routing.chosenModelKey,
          decision: routing.decision,
          reason: routing.reason,
          ...(routing.pool ? { pool: routing.pool } : {}),
          ...(routing.shadow ? { shadow: routing.shadow } : {}),
        }),
        errorMessage,
        latencyMs: Date.now() - start,
        usage,
        routing,
      }),
    );
  };

  if (rejectReason) {
    const message = `Dynamic LLM "${router.key}" refused the request: ${rejectReason}`;
    logDecision(buildRouting('router', '', decision, `${reason}; ${rejectReason}`), 'error', {}, message);
    throw new DynamicRoutingBudgetError(message);
  }

  let finalModelKey = chosenModelKey;
  let finalDecision: IModelUsageRouting['decision'] = decision;
  let finalReason = reason;
  let childResult: ModelCallOutcome;

  try {
    if (!chosenModelKey) throw new Error('No target model resolved for dynamic router');
    childResult = await runChild(chosenModelKey, buildRouting('child', chosenModelKey, decision, reason));
  } catch (primaryError) {
    if (config.fallbackModelKey && config.fallbackModelKey !== chosenModelKey && config.fallbackModelKey !== router.key) {
      finalModelKey = config.fallbackModelKey;
      finalDecision = 'fallback';
      finalReason = `${reason}; primary "${chosenModelKey || '(none)'}" failed, fell back to "${config.fallbackModelKey}"`;
      try {
        childResult = await runChild(
          finalModelKey,
          buildRouting('child', finalModelKey, finalDecision, finalReason),
        );
        // A primary that hit its output limit was billed (its row is written):
        // the run totalling this call must see those tokens next to the answer.
        if (primaryError instanceof OutputTokenLimitError && primaryError.usage) {
          childResult = { ...childResult, burnedUsage: primaryError.usage };
        }
      } catch (fallbackError) {
        logDecision(
          buildRouting('router', finalModelKey, finalDecision, finalReason),
          'error',
          {},
          fallbackError instanceof Error ? fallbackError.message : 'error',
        );
        throw fallbackError;
      }
    } else {
      logDecision(
        buildRouting('router', chosenModelKey, decision, reason),
        'error',
        {},
        primaryError instanceof Error ? primaryError.message : 'error',
      );
      throw primaryError;
    }
  }

  const routing = buildRouting('router', finalModelKey, finalDecision, finalReason);

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

