/**
 * Token usage at the gateway boundary.
 *
 * The agent-sdk reports usage in one shape per provider family, and the families
 * disagree on what a number COUNTS. The gateway's own arithmetic (`calculateCost`,
 * the usage rollups, the OpenAI `usage` object) has one rule: `inputTokens` is the
 * whole prompt INCLUDING the cached part, `outputTokens` is the whole completion
 * INCLUDING reasoning, and cached / reasoning are SUBSETS that are recorded for
 * attribution and never added on top. This module is the one place the provider
 * shapes are turned into that rule.
 *
 *  - OpenAI family (openai, azure, together, openai-compatible): already the rule.
 *  - Anthropic / Bedrock Converse: `input_tokens` is only the UNCACHED part and the
 *    cache reads / writes come separately. Both are folded into the prompt count
 *    (a cache write is billed at least at the input rate; there is no price slot
 *    for it), and the cache read stays the cached subset.
 *  - Vertex Gemini: `candidatesTokenCount` leaves the thinking tokens out, but they
 *    are billed as output, so they are added to the completion count and stay the
 *    reasoning subset.
 */

import type { TokenUsage as NativeUsage } from '@cognipeer/agent-sdk';
import type { TokenUsage } from './usageLogger';

const UNCACHED_PROMPT_DRIVERS: ReadonlySet<string> = new Set(['anthropic', 'bedrock']);

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The gateway usage of a native provider usage. Cached / reasoning keys exist only when they are positive. */
export function toGatewayUsage(driver: string | undefined, usage: Partial<NativeUsage> | undefined): TokenUsage {
  if (!usage) return {};
  const reasoning = count(usage.reasoningTokens);
  const cachedRead = count(usage.cachedInputTokens);
  const cachedWrite = count(usage.cachedWriteTokens);

  let input = count(usage.inputTokens);
  let output = count(usage.outputTokens);
  let total = count(usage.totalTokens);

  if (driver && UNCACHED_PROMPT_DRIVERS.has(driver)) {
    input += cachedRead + cachedWrite;
    total = input + output;
  } else if (driver === 'vertex') {
    output += reasoning;
    total = input + output;
  } else if (total === 0) {
    total = input + output;
  }

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cachedRead > 0 ? { cachedInputTokens: cachedRead } : {}),
    // Subset of outputTokens: never folded into totalTokens or the cost.
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** The OpenAI `usage` object of a gateway usage. */
export function toWireUsage(usage: TokenUsage): Record<string, unknown> {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: usage.cachedInputTokens ?? 0,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(usage.cachedInputTokens ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } } : {}),
    ...(usage.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  };
}

/** The gateway usage of an OpenAI `usage` object (cache hits, wire fixtures). */
export function fromWireUsage(wire: unknown): TokenUsage {
  if (!wire || typeof wire !== 'object') return {};
  const u = wire as Record<string, unknown>;
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completion = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const input = count(u.prompt_tokens);
  const output = count(u.completion_tokens);
  const cached = count(u.cached_tokens) || count(details.cached_tokens);
  const reasoning = count(completion.reasoning_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: count(u.total_tokens) || input + output,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** chars/4: the same estimator the quota pre-flight uses. */
export function estimateTokensFromText(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}
