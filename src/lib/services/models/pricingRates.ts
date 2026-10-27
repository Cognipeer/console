/**
 * The per-token rates a model's pricing record bills at.
 *
 * One rule for every cost computation (the gateway's `calculateCost`, the dynamic
 * routing estimate, the agent cost estimator, the AI App Gateway): a cache price is
 * ENTERED only when it is a positive number. A blank, `0` or `null` cache price is
 * "nobody entered it", not "free" — the model form used to save a blank cached price
 * as `0`, so the two cannot be told apart in stored records. A cache price that was
 * not entered bills at the input rate: no discount is assumed that nobody priced,
 * and a cache read is never booked as free. The one exception is the cache WRITE of a
 * Claude model (Anthropic, Bedrock Claude, Claude on Vertex): its 5-minute write is
 * billed above the input price on every one of them, so a write price nobody entered
 * is assumed at 1.25 x the input price instead of the input rate. Either way the rate
 * is flagged as assumed.
 *
 * Pure on purpose (no database, no server imports) so a client component can ask
 * the same question the bill does.
 */

import type { IModelPricing } from '@/lib/database/provider/types.base';
import { promptCachingSupport } from './promptCaching';

/** What Anthropic bills a 5-minute cache write at, as a multiple of the input price. */
export const CLAUDE_CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenRates {
  /** Per 1M prompt tokens that were neither read from nor written to a cache. */
  input: number;
  /** Per 1M generated tokens (visible and reasoning). */
  output: number;
  /** Per 1M cache-read tokens: the entered cache-read price, else the input rate. */
  cacheRead: number;
  /** Per 1M cache-write tokens: the entered cache-write price, else the input rate (1.25 x for a Claude model). */
  cacheWrite: number;
  /** The cache-read rate is the input rate because no cache-read price was entered. */
  cacheReadAssumed: boolean;
  /** The cache-write rate was assumed (input rate, or 1.25 x it for a Claude model) because no cache-write price was entered. */
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

export interface TokenRateOptions {
  /** The model is a Claude model: a cache-write price nobody entered is assumed at 1.25 x the input price. */
  claudeCacheWrite?: boolean;
}

/** The rate options of a driver + model id (a Claude model on Anthropic, Bedrock or Vertex). */
export function tokenRateOptionsFor(driver: string | undefined, modelId: string | undefined): TokenRateOptions {
  return { claudeCacheWrite: promptCachingSupport(driver, modelId).family === 'claude' };
}

export function resolveTokenRates(pricing: Partial<CachePricing>, options?: TokenRateOptions): TokenRates {
  const input = pricing.inputTokenPer1M ?? 0;
  const output = pricing.outputTokenPer1M ?? 0;
  const cacheRead = entered(pricing.cachedTokenPer1M);
  const cacheWrite = entered(pricing.cacheWriteTokenPer1M);
  return {
    input,
    output,
    cacheRead: cacheRead ?? input,
    cacheWrite: cacheWrite ?? (options?.claudeCacheWrite ? input * CLAUDE_CACHE_WRITE_MULTIPLIER : input),
    cacheReadAssumed: cacheRead === undefined,
    cacheWriteAssumed: cacheWrite === undefined,
  };
}
