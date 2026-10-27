/**
 * The cache-write rate nobody entered: a Claude model bills its 5-minute write at 1.25 x the input price
 * (flagged as assumed), every other model at the input rate.
 */
import { describe, expect, it } from 'vitest';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { resolveTokenRates, tokenRateOptionsFor } from '@/lib/services/models/pricingRates';
import type { IModelPricing } from '@/lib/database/provider/types.base';

const BLANK: IModelPricing = { currency: 'USD', inputTokenPer1M: 2, outputTokenPer1M: 10, cachedTokenPer1M: 0.2 };
const USAGE = { inputTokens: 1_000_000, cachedWriteTokens: 400_000 };

describe('assumed cache-write price', () => {
  it.each([
    ['anthropic', 'claude-sonnet-4-5'],
    ['bedrock', 'us.anthropic.claude-sonnet-4-5-v1:0'],
    ['vertex', 'claude-sonnet-4-5@20250929'],
  ])('%s Claude, blank write price: 1.25 x input, flagged', (providerDriver, modelId) => {
    const cost = calculateCost(BLANK, USAGE, { providerDriver, modelId });
    expect(cost.cacheWriteCost).toBeCloseTo(1.0); // 400k @ $2.50
    expect(cost.inputCost).toBeCloseTo(1.2); // 600k @ $2
    expect(cost.assumedRates).toEqual(['cacheWrite']);
  });

  it('an entered write price is used and not flagged', () => {
    const cost = calculateCost({ ...BLANK, cacheWriteTokenPer1M: 3 }, USAGE, { providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(cost.cacheWriteCost).toBeCloseTo(1.2);
    expect(cost.assumedRates).toBeUndefined();
  });

  it('a blank write price on a GPT model bills at the input rate, flagged', () => {
    const cost = calculateCost(BLANK, USAGE, { providerDriver: 'openai', modelId: 'gpt-5' });
    expect(cost.cacheWriteCost).toBeCloseTo(0.8);
    expect(cost.assumedRates).toEqual(['cacheWrite']);
  });

  it('Nova, Llama and a call without model context keep the input-rate rule', () => {
    expect(calculateCost(BLANK, USAGE, { providerDriver: 'bedrock', modelId: 'amazon.nova-pro-v1:0' }).cacheWriteCost).toBeCloseTo(0.8);
    expect(calculateCost(BLANK, USAGE, { providerDriver: 'bedrock', modelId: 'meta.llama3-1-70b-instruct-v1:0' }).cacheWriteCost).toBeCloseTo(0.8);
    expect(calculateCost(BLANK, USAGE).cacheWriteCost).toBeCloseTo(0.8);
  });

  it('a free Claude model assumes nothing', () => {
    const cost = calculateCost({ currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0 }, USAGE, { providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(cost.totalCost).toBe(0);
    expect(cost.assumedRates).toBeUndefined();
  });

  it('resolveTokenRates: the multiplier only applies when asked for', () => {
    expect(resolveTokenRates(BLANK, tokenRateOptionsFor('anthropic', 'claude-sonnet-4-5')).cacheWrite).toBeCloseTo(2.5);
    expect(resolveTokenRates(BLANK, tokenRateOptionsFor('anthropic', 'claude-sonnet-4-5')).cacheWriteAssumed).toBe(true);
    expect(resolveTokenRates(BLANK).cacheWrite).toBe(2);
  });
});
