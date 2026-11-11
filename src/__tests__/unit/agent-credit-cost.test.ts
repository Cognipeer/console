/**
 * An agent on a model paid with credits (a platform model: no token price) gets its cost limit, its turn cost and
 * so its session budget from the host's credit pricer: each model call at the USD of the credits it is charged.
 * Without a pricer such a turn stays unpriced instead of reading as free; without a host nothing changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadManagedCreditPricer,
  registerManagedCreditsHost,
  resetManagedCreditsHostForTests,
  type ManagedCreditPricer,
  type ManagedCreditsHost,
} from '@/enterprise/managed-credits';
import { __testables } from '@/lib/services/agents/agentService';

const { buildAgentCostEstimator, priceAgentTurn } = __testables;

const ZERO = { inputTokenPer1M: 0, outputTokenPer1M: 0 };
const platform = { key: 'cognipeer.chat', modelId: 'chat-1', providerKey: 'cognipeer', providerDriver: 'cognipeer', pricing: ZERO };
const own = { key: 'own.chat', modelId: 'gpt-x', providerKey: 'openai-own', providerDriver: 'openai', pricing: { inputTokenPer1M: 2, outputTokenPer1M: 0 } };
const config = { runtime: {} } as never;
const limited = { runtime: { limits: { maxCostUsd: 1 } } } as never;

/** 2 credits a call below 1000 input tokens, 5 above; 0.01 USD a credit. */
const pricerFn: ManagedCreditPricer = (query, usage) => {
  if (query.providerKey !== 'cognipeer' || query.kind !== 'chat') return null;
  const credits = (usage.inputTokens ?? 0) > 1000 ? 5 : 2;
  return { credits, usdPerCredit: 0.01, usd: credits * 0.01 };
};

const install = (pricer: ManagedCreditsHost['pricer']) => {
  const pricerSpy = vi.fn(pricer!);
  registerManagedCreditsHost({
    isManagedProvider: (ref) => ref.key === 'cognipeer',
    reserve: async () => { throw new Error('not in these tests'); },
    pricer: pricerSpy,
  });
  return pricerSpy;
};

const turn = (requests: Array<{ modelName: string; prompt: number; completion: number; subagent?: string }>) => ({
  state: {
    usage: {
      perRequest: requests.map((r) => ({
        modelName: r.modelName,
        ...(r.subagent ? { subagent: { name: r.subagent } } : {}),
        usage: { prompt_tokens: r.prompt, completion_tokens: r.completion },
      })),
    },
  },
});
const totals = { inputTokens: 2600, outputTokens: 30, totalTokens: 2630 } as never;

afterEach(() => resetManagedCreditsHostForTests());

describe('agent turn cost on a model paid with credits', () => {
  it('sums each call at its credits\' USD, with no cost limit set', async () => {
    const pricer = install(async () => pricerFn);
    const estimator = await buildAgentCostEstimator(config, platform, [], false, undefined, 'tenant-1');
    expect(pricer).toHaveBeenCalledWith('tenant-1');
    expect(estimator).toBeDefined();
    const cost = await priceAgentTurn({
      plan: null,
      result: turn([{ modelName: 'cognipeer.chat', prompt: 400, completion: 10 }, { modelName: 'cognipeer.chat', prompt: 2200, completion: 20 }]) as never,
      costEstimator: estimator,
      pricing: ZERO,
      model: platform,
      usage: totals,
    });
    expect(cost).toBeCloseTo(0.07, 9);
  });

  it('feeds the cost limit: the estimator the SDK stops on prices a platform call', async () => {
    install(async () => pricerFn);
    const estimator = (await buildAgentCostEstimator(limited, platform, [], false, undefined, 'tenant-1'))!;
    expect(estimator({ modelName: 'chat-1', inputTokens: 1500, outputTokens: 5 })).toBeCloseTo(0.05, 9);
  });

  it('a platform sub-agent is priced in credits next to a parent priced per token', async () => {
    install(async () => pricerFn);
    const warn = vi.fn();
    const estimator = await buildAgentCostEstimator(limited, own, [platform], false, warn, 'tenant-1');
    expect(warn).not.toHaveBeenCalled();
    const cost = await priceAgentTurn({
      plan: null,
      result: turn([
        { modelName: 'own.chat', prompt: 1_000_000, completion: 0 },
        { modelName: 'cognipeer.chat', prompt: 100, completion: 5, subagent: 'helper' },
      ]) as never,
      costEstimator: estimator,
      pricing: own.pricing,
      model: own,
      usage: totals,
    });
    expect(cost).toBeCloseTo(2.02, 9);
  });

  it('without a pricer (no known rate) the turn is unpriced, not free', async () => {
    install(async () => null);
    const estimator = await buildAgentCostEstimator(config, platform, [], false, undefined, 'tenant-1');
    expect(estimator).toBeUndefined();
    const cost = await priceAgentTurn({
      plan: null,
      result: turn([{ modelName: 'cognipeer.chat', prompt: 400, completion: 10 }]) as never,
      costEstimator: estimator,
      pricing: ZERO,
      model: platform,
      usage: totals,
    });
    expect(cost).toBeUndefined();
  });

  it('without a host an own model is priced as before and no pricer is asked for', async () => {
    const estimator = await buildAgentCostEstimator(config, own, [], false, undefined, 'tenant-1');
    expect(estimator).toBeUndefined();
    const cost = await priceAgentTurn({
      plan: null,
      result: turn([]) as never,
      costEstimator: estimator,
      pricing: own.pricing,
      model: own,
      usage: { inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 } as never,
    });
    expect(cost).toBeCloseTo(1, 9);
  });
});

describe('loadManagedCreditPricer', () => {
  it('is null without a host, without a pricer, without a tenant, and when the host throws', async () => {
    expect(await loadManagedCreditPricer('tenant-1')).toBeNull();
    registerManagedCreditsHost({ isManagedProvider: () => true, reserve: async () => { throw new Error('x'); } });
    expect(await loadManagedCreditPricer('tenant-1')).toBeNull();
    install(async () => pricerFn);
    expect(await loadManagedCreditPricer(undefined)).toBeNull();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    install(async () => { throw new Error('ledger down'); });
    expect(await loadManagedCreditPricer('tenant-1')).toBeNull();
    spy.mockRestore();
  });

  it('never throws from a quote, and drops a quote with a bad USD', async () => {
    install(async () => (query, usage) => {
      if (usage.units === 1) throw new Error('boom');
      if (usage.units === 2) return { credits: 1, usdPerCredit: 0.01, usd: Number.NaN };
      if (usage.units === 3) return { credits: 1, usdPerCredit: 0.01, usd: -1 };
      return { credits: 1, usdPerCredit: 0.01, usd: 0.01 };
    });
    const pricer = (await loadManagedCreditPricer('tenant-1'))!;
    const query = { providerKey: 'cognipeer-search', kind: 'search' as const };
    expect(pricer(query, { units: 1 })).toBeNull();
    expect(pricer(query, { units: 2 })).toBeNull();
    expect(pricer(query, { units: 3 })).toBeNull();
    expect(pricer(query, { units: 4 })).toEqual({ credits: 1, usdPerCredit: 0.01, usd: 0.01 });
  });
});
