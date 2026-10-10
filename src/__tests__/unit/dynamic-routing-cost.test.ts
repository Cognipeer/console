/**
 * Unit tests — Dynamic LLM cost-aware routing (pure parts): target
 * normalization, conversation ids + canary bucketing, capability filtering,
 * output prediction, pool policies, cost guards, and routing analytics.
 */

import { describe, it, expect } from 'vitest';
import {
  applyCostGuards,
  candidateIneligibility,
  configModelKeys,
  deriveConversationId,
  estimateRequestCostUsd,
  extractRoutingSignals,
  isInCanary,
  normalizeTarget,
  predictOutputTokens,
  primaryModelKey,
  segmentKey,
  selectPoolCandidate,
  type PoolCandidateEstimate,
  pickDecisionLabel,
} from '@/lib/services/models/dynamicRouting';
import { summarizeRoutedUsage } from '@/lib/services/models/routingAnalytics';
import { validateDynamicConfig } from '@/lib/services/models/modelService';
import type { IDynamicRoutingConfig, IModelUsageLog } from '@/lib/database';

const signalsFor = (content: string, extra: Record<string, unknown> = {}) =>
  extractRoutingSignals({ messages: [{ role: 'user', content }], ...extra });

describe('normalizeTarget / primaryModelKey', () => {
  it('treats targetModelKey as a fixed-model shorthand', () => {
    expect(normalizeTarget({ targetModelKey: 'big' })).toEqual({ modelKey: 'big' });
  });

  it('prefers a pool target and defaults its policy', () => {
    const target = normalizeTarget({
      targetModelKey: 'ignored',
      target: { pool: [{ modelKey: 'a' }, { modelKey: 'b', tier: 2 }] },
    });
    expect(target.policy).toBe('best-under-cap');
    expect(primaryModelKey(target)).toBe('a');
  });

  it('collects every model a config can route to', () => {
    const config: IDynamicRoutingConfig = {
      strategy: 'rule-based',
      defaultModelKey: 'small',
      fallbackModelKey: 'fb',
      guards: { economyModelKey: 'eco' },
      rules: [
        { label: 'r', target: { pool: [{ modelKey: 'p1' }, { modelKey: 'p2' }] }, conditions: [] },
      ],
    };
    expect(configModelKeys(config).sort()).toEqual(['eco', 'fb', 'p1', 'p2', 'small']);
  });
});

describe('deriveConversationId / isInCanary', () => {
  it('uses an explicit metadata id and hashes it', () => {
    const a = deriveConversationId({ metadata: { conversationId: 'c-1' }, messages: [] });
    const b = deriveConversationId({ metadata: { conversationId: 'c-1' }, messages: [{ role: 'user', content: 'x' }] });
    expect(a).toBe(b);
    expect(a).not.toContain('c-1');
  });

  it('keeps the same id as a conversation grows (hashes its opening)', () => {
    const opening = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'first question' },
    ];
    const first = deriveConversationId({ messages: opening });
    const later = deriveConversationId({
      messages: [...opening, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'follow-up' }],
    });
    expect(later).toBe(first);
    expect(deriveConversationId({ messages: [{ role: 'user', content: 'other' }] })).not.toBe(first);
  });

  it('buckets deterministically', () => {
    const id = deriveConversationId({ metadata: { conversationId: 'stable' } });
    expect(isInCanary(id, 100)).toBe(true);
    expect(isInCanary(id, 0)).toBe(false);
    expect(isInCanary(id, 50)).toBe(isInCanary(id, 50));
    expect(isInCanary(id, undefined)).toBe(true);
  });
});

describe('segmentKey', () => {
  it('separates tools and input-size bands', () => {
    const small = segmentKey('default', signalsFor('hi'));
    const tools = segmentKey('default', signalsFor('hi', { tools: [{ type: 'function' }] }));
    const big = segmentKey('default', signalsFor('x'.repeat(40_000)));
    expect(small).not.toBe(tools);
    expect(small).not.toBe(big);
  });
});

describe('candidateIneligibility', () => {
  const caps = { contextWindow: 1000, inputModalities: ['text' as const], supportsToolCalls: false };

  it('excludes known-missing tool calling and image input', () => {
    expect(candidateIneligibility(caps, signalsFor('hi', { tools: [{}] }), 10)).toBe('no tool calling');
    expect(
      candidateIneligibility(
        caps,
        extractRoutingSignals({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }),
        10,
      ),
    ).toBe('no image input');
  });

  it('excludes a context window that cannot hold input + output', () => {
    expect(candidateIneligibility(caps, signalsFor('x'.repeat(4000)), 100)).toMatch(/context window/);
  });

  it('never excludes on unknown capabilities', () => {
    expect(
      candidateIneligibility(
        { inputModalities: ['text'], contextWindow: undefined, supportsToolCalls: undefined },
        signalsFor('hi', { tools: [{}] }),
        10,
      ),
    ).toBeNull();
    expect(candidateIneligibility(null, signalsFor('hi'), 10)).toBeNull();
  });
});

describe('extractRoutingSignals · max tokens', () => {
  it('reads max_completion_tokens before max_tokens', () => {
    expect(signalsFor('hi', { max_tokens: 100, max_completion_tokens: 50 }).maxOutputTokens).toBe(50);
    expect(signalsFor('hi', { max_tokens: 100 }).maxOutputTokens).toBe(100);
    expect(signalsFor('hi').maxOutputTokens).toBeUndefined();
  });
});

describe('estimateRequestCostUsd', () => {
  const pricing = { inputTokenPer1M: 10, outputTokenPer1M: 30, cachedTokenPer1M: 1 };

  it('prices cached input share at the cached rate', () => {
    expect(estimateRequestCostUsd(pricing, 1_000_000, 0, 0)).toBeCloseTo(10);
    expect(estimateRequestCostUsd(pricing, 1_000_000, 0, 1)).toBeCloseTo(1);
    expect(estimateRequestCostUsd(pricing, 1_000_000, 0, 0.5)).toBeCloseTo(5.5);
  });

  it('adds expected output', () => {
    expect(estimateRequestCostUsd(pricing, 0, 1_000_000)).toBeCloseTo(30);
  });
});

describe('predictOutputTokens', () => {
  const opts = { defaultOutputTokens: 512 };

  it('simple: max_tokens, then model average, then default', () => {
    expect(predictOutputTokens('simple', 1000, {}, { ...opts, maxOutputTokens: 64 })).toBe(64);
    expect(predictOutputTokens('simple', 1000, { modelAvgOutputTokens: 200 }, opts)).toBe(200);
    expect(predictOutputTokens('simple', 1000, {}, opts)).toBe(512);
  });

  it('profile: request ratio scaled by model verbosity', () => {
    // conversation ratio 0.5, model twice as verbose as the pool mean → 1000 * 0.5 * 2
    expect(
      predictOutputTokens('profile', 1000, { conversationIoRatio: 0.5, modelIoRatio: 0.4, poolMeanIoRatio: 0.2 }, opts),
    ).toBe(1000);
  });

  it('profile: clamps verbosity and caps by max_tokens', () => {
    expect(
      predictOutputTokens('profile', 1000, { segmentIoRatio: 1, modelIoRatio: 100, poolMeanIoRatio: 1 }, opts),
    ).toBe(4000);
    expect(
      predictOutputTokens('profile', 1000, { segmentIoRatio: 1 }, { ...opts, maxOutputTokens: 300 }),
    ).toBe(300);
  });

  it('profile: falls back to the model ratio, then to simple', () => {
    expect(predictOutputTokens('profile', 1000, { modelIoRatio: 0.3 }, opts)).toBe(300);
    expect(predictOutputTokens('profile', 1000, {}, opts)).toBe(512);
  });
});

const est = (modelKey: string, tier: number, cost: number | undefined, eligible = true): PoolCandidateEstimate => ({
  modelKey,
  tier,
  estimatedCostUsd: cost,
  eligible,
});

describe('selectPoolCandidate', () => {
  const pool = [est('small', 1, 0.001), est('medium', 2, 0.01), est('large', 3, 0.05)];

  it('best-under-cap: highest tier that fits the cap', () => {
    expect(selectPoolCandidate(pool, 'best-under-cap', { maxCostPerRequestUsd: 0.02 })?.modelKey).toBe('medium');
    expect(selectPoolCandidate(pool, 'best-under-cap')?.modelKey).toBe('large');
  });

  it('best-under-cap: cheapest when nothing fits', () => {
    expect(selectPoolCandidate(pool, 'best-under-cap', { maxCostPerRequestUsd: 0.0001 })?.modelKey).toBe('small');
  });

  it('cheapest: lowest estimate, skipping ineligible candidates', () => {
    expect(selectPoolCandidate([est('small', 1, 0.001, false), ...pool.slice(1)], 'cheapest')?.modelKey).toBe('medium');
  });

  it('token-profile: stays on the sticky model unless the saving beats the margin', () => {
    const near = [est('a', 1, 0.0095), est('b', 1, 0.01)];
    expect(selectPoolCandidate(near, 'token-profile', { stickyModelKey: 'b', switchMarginPct: 15 })?.modelKey).toBe('b');
    const far = [est('a', 1, 0.005), est('b', 1, 0.01)];
    expect(selectPoolCandidate(far, 'token-profile', { stickyModelKey: 'b', switchMarginPct: 15 })?.modelKey).toBe('a');
  });

  it('returns null when no candidate is eligible', () => {
    expect(selectPoolCandidate([est('x', 1, 1, false)], 'cheapest')).toBeNull();
  });
});

describe('applyCostGuards', () => {
  const choice = { modelKey: 'large', estimatedCostUsd: 0.05 };
  const cheap = { modelKey: 'small', estimatedCostUsd: 0.001 };

  it('keeps the choice when no guard trips', () => {
    expect(applyCostGuards(choice, { maxCostPerRequestUsd: 1 }, {}, cheap)).toEqual({
      modelKey: 'large',
      estimatedCostUsd: 0.05,
    });
  });

  it('downgrades on the per-request cap', () => {
    const outcome = applyCostGuards(choice, { maxCostPerRequestUsd: 0.01 }, {}, cheap);
    expect(outcome.modelKey).toBe('small');
    expect(outcome.guard).toBe('maxCostPerRequestUsd');
  });

  it('downgrades on conversation spend and budget share', () => {
    expect(
      applyCostGuards(choice, { conversationBudgetUsd: 0.5 }, { conversationCostUsd: 0.6 }, cheap).guard,
    ).toBe('conversationBudgetUsd');
    expect(
      applyCostGuards(choice, { budget: { windowHours: 24, limitUsd: 10, downgradeAtPct: 80 } }, { budgetUsedPct: 85 }, cheap)
        .modelKey,
    ).toBe('small');
  });

  it('rejects an exhausted budget when configured to', () => {
    const outcome = applyCostGuards(
      choice,
      { budget: { windowHours: 24, limitUsd: 10, onExceeded: 'reject' } },
      { budgetUsedPct: 100 },
      cheap,
    );
    expect(outcome.reject).toBe(true);
  });

  it('never moves to a model estimated to cost more', () => {
    const outcome = applyCostGuards(
      { modelKey: 'small', estimatedCostUsd: 0.02 },
      { maxCostPerRequestUsd: 0.01 },
      {},
      { modelKey: 'large', estimatedCostUsd: 0.05 },
    );
    expect(outcome.modelKey).toBe('small');
    expect(outcome.reason).toMatch(/no cheaper model/);
  });
});

describe('validateDynamicConfig · pools, guards, rollout', () => {
  const base: IDynamicRoutingConfig = {
    strategy: 'rule-based',
    defaultModelKey: 'small',
    rules: [{ label: 'r', targetModelKey: 'big', conditions: [{ signal: 'messageCount', operator: 'gt', value: 1 }] }],
  };

  it('accepts a legacy config unchanged', () => {
    expect(() => validateDynamicConfig(base)).not.toThrow();
  });

  it('accepts pool targets, guards and shadow mode', () => {
    expect(() =>
      validateDynamicConfig({
        ...base,
        rules: [
          {
            label: 'r',
            target: { pool: [{ modelKey: 'a', tier: 1 }, { modelKey: 'b', tier: 2 }], policy: 'token-profile' },
            conditions: [{ signal: 'ioRatio', operator: 'gt', value: 1 }],
          },
        ],
        defaultTarget: { pool: [{ modelKey: 'small' }], policy: 'cheapest' },
        guards: { maxCostPerRequestUsd: 0.02, budget: { windowHours: 24, limitUsd: 100 } },
        mode: 'shadow',
        canaryPercent: 10,
      }),
    ).not.toThrow();
  });

  it('rejects a rule without any target', () => {
    expect(() =>
      validateDynamicConfig({ ...base, rules: [{ label: 'r', conditions: [{ signal: 'messageCount', operator: 'gt', value: 1 }] }] }),
    ).toThrow(/target model or pool/);
  });

  it('rejects malformed pools and guards', () => {
    expect(() => validateDynamicConfig({ ...base, defaultTarget: { pool: [] } })).toThrow(/at least one candidate/);
    expect(() =>
      validateDynamicConfig({ ...base, defaultTarget: { pool: [{ modelKey: 'a' }], policy: 'fastest' as never } }),
    ).toThrow(/policy/);
    expect(() => validateDynamicConfig({ ...base, guards: { budget: { windowHours: 500, limitUsd: 1 } } })).toThrow(
      /windowHours/,
    );
    expect(() => validateDynamicConfig({ ...base, guards: { maxCostPerRequestUsd: -1 } })).toThrow(/non-negative/);
    expect(() => validateDynamicConfig({ ...base, canaryPercent: 120 })).toThrow(/canaryPercent/);
  });
});

describe('validateDynamicConfig · decision deciders and signals', () => {
  const rule = (signal: string) => ({
    label: 'r',
    targetModelKey: 'big',
    conditions: [{ signal, operator: 'gt', value: 1 }],
  });
  const base = (extra: object = {}) =>
    ({ strategy: 'rule-based', defaultModelKey: 'small', rules: [rule('messageCount')], ...extra }) as unknown as IDynamicRoutingConfig;

  it('rejects the removed estimatedCostUsd signal with a pointer to pools/guards', () => {
    expect(() => validateDynamicConfig(base({ rules: [rule('estimatedCostUsd')] }))).toThrow(/estimatedCostUsd.*removed/);
  });

  it('rejects an unknown signal', () => {
    expect(() => validateDynamicConfig(base({ rules: [rule('nope')] }))).toThrow(/unknown signal "nope"/);
  });

  it('complexityScore needs a complexity config with 2+ levels', () => {
    expect(() => validateDynamicConfig(base({ rules: [rule('complexityScore')] }))).toThrow(/needs a complexity decision model/);
    expect(() =>
      validateDynamicConfig(base({ rules: [rule('complexityScore')], complexity: { modelKey: 'j', levels: ['only'] } })),
    ).toThrow(/between 2 and 255/);
    expect(() =>
      validateDynamicConfig(base({ rules: [rule('complexityScore')], complexity: { modelKey: 'j', levels: ['lo', 'hi'] } })),
    ).not.toThrow();
  });

  it('validates the decider confidence floor and fallback target', () => {
    const decider = (extra: object) =>
      ({
        strategy: 'model-based',
        defaultModelKey: 'small',
        decider: { modelKey: 'j', labels: [{ label: 'a', description: '', targetModelKey: 'big' }], ...extra },
      }) as unknown as IDynamicRoutingConfig;
    expect(() => validateDynamicConfig(decider({ minConfidence: 1.5 }))).toThrow(/between 0 and 1/);
    expect(() => validateDynamicConfig(decider({ minConfidence: 0.7, belowConfidence: { modelKey: 'big' } }))).not.toThrow();
    expect(() => validateDynamicConfig(decider({ minConfidence: 0.7, belowConfidence: { pool: [] } }))).toThrow(/at least one candidate/);
  });
});

describe('pickDecisionLabel', () => {
  const decider = {
    modelKey: 'j',
    labels: [
      { label: 'hard', description: '', targetModelKey: 'big' },
      { label: 'easy', description: '', targetModelKey: 'small' },
    ],
  };
  const choice = (c: string, probabilities: Record<string, number>, extra: object = {}) =>
    ({ type: 'choice', choice: c, probabilities, ...extra }) as never;

  it('resolves the label and reports probability and margin', () => {
    const pick = pickDecisionLabel(choice('hard', { hard: 0.7, easy: 0.3 }), decider);
    expect(pick.label?.label).toBe('hard');
    expect(pick.probability).toBeCloseTo(0.7);
    expect(pick.margin).toBeCloseTo(0.4);
    expect(pick.belowThreshold).toBe(false);
  });

  it('applies minConfidence to confidence when reported, else to probability', () => {
    const floor = { ...decider, minConfidence: 0.8 };
    expect(pickDecisionLabel(choice('hard', { hard: 0.9, easy: 0.1 }, { confidence: 0.5 }), floor).belowThreshold).toBe(true);
    expect(pickDecisionLabel(choice('hard', { hard: 0.9, easy: 0.1 }), floor).belowThreshold).toBe(false);
    expect(pickDecisionLabel(choice('hard', { hard: 0.6, easy: 0.4 }), floor).belowThreshold).toBe(true);
  });

  it('returns no label for an unknown choice or a refusal', () => {
    expect(pickDecisionLabel(choice('weird', { weird: 1 }), decider).label).toBeNull();
    expect(pickDecisionLabel({ type: 'refusal' } as never, decider).label).toBeNull();
    expect(pickDecisionLabel(undefined, decider).label).toBeNull();
  });
});

describe('summarizeRoutedUsage', () => {
  const row = (overrides: Partial<IModelUsageLog> & { routing: IModelUsageLog['routing'] }): IModelUsageLog =>
    ({
      tenantId: 't',
      modelKey: 'small',
      requestId: 'r',
      route: 'chat.completions',
      status: 'success',
      providerRequest: {},
      providerResponse: {},
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      createdAt: new Date('2026-10-01T10:00:00Z'),
      ...overrides,
    }) as IModelUsageLog;

  const routing = (extra: Record<string, unknown> = {}) =>
    ({
      role: 'child',
      routerKey: 'router',
      strategy: 'rule-based',
      decision: 'rule',
      chosenModelKey: 'small',
      matchedRuleLabel: 'cheap',
      reason: 'x',
      ...extra,
    }) as IModelUsageLog['routing'];

  it('sums child cost against baseline and subtracts decider spend', () => {
    const summary = summarizeRoutedUsage(
      [
        row({ pricingSnapshot: { inputTokenPer1M: 0, outputTokenPer1M: 0, totalCost: 0.01 } as never, routing: routing({ baselineCostUsd: 0.05, estimatedCostUsd: 0.012 }) }),
        row({ modelKey: 'big', finishReason: 'length', pricingSnapshot: { totalCost: 0.04 } as never, routing: routing({ decision: 'default', matchedRuleLabel: undefined, baselineCostUsd: 0.04, guard: 'maxCostPerRequestUsd' }) }),
        row({ modelKey: 'decider', pricingSnapshot: { totalCost: 0.002 } as never, routing: routing({ role: 'decider' }) }),
      ],
      { from: new Date('2026-10-01'), to: new Date('2026-10-02') },
    );

    expect(summary.totals.requests).toBe(2);
    expect(summary.totals.costUsd).toBeCloseTo(0.052);
    expect(summary.totals.deciderCostUsd).toBeCloseTo(0.002);
    expect(summary.totals.baselineCostUsd).toBeCloseTo(0.09);
    expect(summary.totals.savingsUsd).toBeCloseTo(0.038);
    expect(summary.totals.lengthStops).toBe(1);
    expect(summary.totals.defaults).toBe(1);
    expect(summary.totals.guardTrips).toBe(1);
    expect(summary.totals.costEstimateErrorPct).toBeCloseTo(20);
    expect(summary.byRoute.map((r) => r.route).sort()).toEqual(['default', 'rule:cheap']);
    expect(summary.byModel[0].modelKey).toBe('big');
    expect(summary.daily).toHaveLength(1);
  });

  it('reports shadow decisions with both estimates', () => {
    const summary = summarizeRoutedUsage(
      [
        row({
          modelKey: 'big',
          pricingSnapshot: { totalCost: 0.05 } as never,
          routing: routing({
            mode: 'shadow',
            estimatedCostUsd: 0.05,
            shadow: { chosenModelKey: 'small', estimatedCostUsd: 0.01, reason: 'cheaper' },
          }),
        }),
      ],
      { from: new Date(), to: new Date() },
    );
    expect(summary.shadow).toEqual([
      expect.objectContaining({ actualModelKey: 'big', proposedModelKey: 'small', requests: 1, estimatedSavingsUsd: 0.04 }),
    ]);
  });

  it('ignores router decision rows', () => {
    const summary = summarizeRoutedUsage(
      [row({ routing: routing({ role: 'router' }) }), row({ routing: undefined })],
      { from: new Date(), to: new Date() },
    );
    expect(summary.totals.requests).toBe(0);
  });

  it('averages decider latency separately from child latency', () => {
    const summary = summarizeRoutedUsage(
      [
        row({ latencyMs: 4000, routing: routing() }),
        row({ latencyMs: 2000, routing: routing() }),
        row({ modelKey: 'decider', latencyMs: 1000, routing: routing({ role: 'decider' }) }),
        row({ modelKey: 'decider', latencyMs: 2000, routing: routing({ role: 'decider' }) }),
        // A decider row without a measured latency counts as a call, not as 0 ms.
        row({ modelKey: 'decider', routing: routing({ role: 'decider' }) }),
      ],
      { from: new Date('2026-10-01'), to: new Date('2026-10-02') },
    );

    expect(summary.totals.deciderCalls).toBe(3);
    expect(summary.totals.avgDeciderLatencyMs).toBeCloseTo(1500);
    expect(summary.totals.avgLatencyMs).toBeCloseTo(3000);
    // 3 decider calls for 2 routed requests: capped at one call per request, so the per-call mean.
    expect(summary.totals.avgDeciderPerRequestMs).toBeCloseTo(1500);
    expect(summary.totals.avgTotalLatencyMs).toBeCloseTo(4500);
  });

  it('does not inflate decider time with decider calls whose request has no routed row', () => {
    const decider = (latencyMs: number) =>
      row({ modelKey: 'decider', latencyMs, routing: routing({ role: 'decider' }) });
    // 3 routed requests but 5 decider calls: two requests failed before reaching the child.
    const summary = summarizeRoutedUsage(
      [
        row({ latencyMs: 6000, routing: routing() }),
        row({ latencyMs: 6000, routing: routing() }),
        row({ latencyMs: 6000, routing: routing() }),
        decider(2000), decider(2000), decider(2000), decider(2000), decider(2000),
      ],
      { from: new Date('2026-10-01'), to: new Date('2026-10-02') },
    );
    expect(summary.totals.avgDeciderLatencyMs).toBeCloseTo(2000);
    expect(summary.totals.avgDeciderPerRequestMs).toBeCloseTo(2000); // not 5 × 2000 ÷ 3
    expect(summary.totals.avgTotalLatencyMs).toBeCloseTo(8000);
  });

  it('scales decider time down when only some requests had a decider call', () => {
    const summary = summarizeRoutedUsage(
      [
        ...[0, 1, 2, 3].map(() => row({ latencyMs: 1000, routing: routing() })),
        row({ modelKey: 'decider', latencyMs: 1000, routing: routing({ role: 'decider' }) }),
        row({ modelKey: 'decider', latencyMs: 1000, routing: routing({ role: 'decider' }) }),
      ],
      { from: new Date('2026-10-01'), to: new Date('2026-10-02') },
    );
    // 2 calls over 4 requests: half the requests carried 1000 ms of decider time.
    expect(summary.totals.avgDeciderPerRequestMs).toBeCloseTo(500);
    expect(summary.totals.avgTotalLatencyMs).toBeCloseTo(1500);
  });

  it('leaves decider latency unset when the router has no decider', () => {
    const summary = summarizeRoutedUsage(
      [row({ latencyMs: 1000, routing: routing() })],
      { from: new Date('2026-10-01'), to: new Date('2026-10-02') },
    );
    expect(summary.totals.deciderCalls).toBe(0);
    expect(summary.totals.avgDeciderLatencyMs).toBeNull();
    // No decider: nothing is added in front of the child call.
    expect(summary.totals.avgDeciderPerRequestMs).toBe(0);
    expect(summary.totals.avgTotalLatencyMs).toBeCloseTo(1000);
  });

  it('has no end-to-end latency without routed requests', () => {
    const summary = summarizeRoutedUsage([], { from: new Date('2026-10-01'), to: new Date('2026-10-02') });
    expect(summary.totals.avgDeciderPerRequestMs).toBeNull();
    expect(summary.totals.avgTotalLatencyMs).toBeNull();
  });
});
