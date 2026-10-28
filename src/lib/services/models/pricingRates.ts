/**
 * The per-token rates a model's pricing record bills at.
 *
 * One rule for every cost computation (the gateway's `calculateCost`, the dynamic
 * routing estimate, the agent cost estimator, the AI App Gateway): a cache price is
 * ENTERED only when it is a positive number. A blank, `0` or `null` cache price is
 * "nobody entered it", not "free" — the model form used to save a blank cached price
 * as `0`, so the two cannot be told apart in stored records. A cache price that was
 * not entered bills at the input rate: no discount is assumed that nobody priced,
 * and a cache read is never booked as free.
 *
 * Pure on purpose (no database, no server imports) so a client component can ask
 * the same question the bill does.
 */

import type { IModelPricing } from '@/lib/database/provider/types.base';

export interface TokenRates {
  /** Per 1M prompt tokens that were neither read from nor written to a cache. */
  input: number;
  /** Per 1M generated tokens (visible and reasoning). */
  output: number;
  /** Per 1M cache-read tokens: the entered cache-read price, else the input rate. */
  cacheRead: number;
  /** Per 1M cache-write tokens: the entered cache-write price, else the input rate. */
  cacheWrite: number;
  /** The cache-read rate is the input rate because no cache-read price was entered. */
  cacheReadAssumed: boolean;
  /** The cache-write rate is the input rate because no cache-write price was entered. */
  cacheWriteAssumed: boolean;
}

type CachePricing = Pick<IModelPricing, 'inputTokenPer1M' | 'outputTokenPer1M' | 'cachedTokenPer1M' | 'cacheWriteTokenPer1M'>;

/** A price as entered: a positive finite number, else undefined. */
function entered(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** True when the pricing record has a cache-read price of its own. */
export function hasCacheReadPrice(pricing: Partial<CachePricing> | null | undefined): boolean {
  return entered(pricing?.cachedTokenPer1M) !== undefined;
}

/** True when the pricing record has a cache-write price of its own. */
export function hasCacheWritePrice(pricing: Partial<CachePricing> | null | undefined): boolean {
  return entered(pricing?.cacheWriteTokenPer1M) !== undefined;
}

export function resolveTokenRates(pricing: Partial<CachePricing>): TokenRates {
  const input = pricing.inputTokenPer1M ?? 0;
  const output = pricing.outputTokenPer1M ?? 0;
  const cacheRead = entered(pricing.cachedTokenPer1M);
  const cacheWrite = entered(pricing.cacheWriteTokenPer1M);
  return {
    input,
    output,
    cacheRead: cacheRead ?? input,
    cacheWrite: cacheWrite ?? input,
    cacheReadAssumed: cacheRead === undefined,
    cacheWriteAssumed: cacheWrite === undefined,
  };
}
