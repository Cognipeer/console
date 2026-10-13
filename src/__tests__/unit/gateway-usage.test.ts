/**
 * Token usage at the gateway boundary: one rule for every provider family
 * (prompt includes the cached part, completion includes the reasoning, both are
 * subsets that never add on top), and the OpenAI `usage` object that rule feeds.
 */

import { describe, expect, it } from 'vitest';
import { estimateTokensFromText, fromWireUsage, toGatewayUsage, toWireUsage } from '@/lib/services/models/gatewayUsage';
import { wireFinishReason } from '@/lib/services/models/gatewayStream';
import { calculateCost } from '@/lib/services/models/usageLogger';

const native = (over: Record<string, number> = {}) => ({
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0,
  ...over,
});

describe('toGatewayUsage', () => {
  it('OpenAI family: the provider already counts the prompt with its cached part and the completion with its reasoning', () => {
    for (const driver of ['openai', 'azure', 'together', 'openai-compatible']) {
      expect(toGatewayUsage(driver, native({ inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 60, reasoningTokens: 12 })))
        .toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 60, reasoningTokens: 12 });
    }
  });

  it('derives the total when the provider sent none', () => {
    expect(toGatewayUsage('openai', native({ inputTokens: 5, outputTokens: 7 }))).toMatchObject({ totalTokens: 12 });
  });

  it('Anthropic / Bedrock: the uncached prompt is topped up with the cache reads and writes', () => {
    for (const driver of ['anthropic', 'bedrock']) {
      expect(toGatewayUsage(driver, native({ inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedInputTokens: 500, cachedWriteTokens: 30 })))
        .toEqual({ inputTokens: 550, outputTokens: 5, totalTokens: 555, cachedInputTokens: 500 });
    }
  });

  it('Vertex Gemini: thinking tokens are billed as output, so they are in the completion and stay the reasoning subset', () => {
    expect(toGatewayUsage('vertex', native({ inputTokens: 30, outputTokens: 10, totalTokens: 90, cachedInputTokens: 5, reasoningTokens: 50 })))
      .toEqual({ inputTokens: 30, outputTokens: 60, totalTokens: 90, cachedInputTokens: 5, reasoningTokens: 50 });
  });

  it('omits the cached and reasoning keys when they are zero, and survives a missing usage', () => {
    const usage = toGatewayUsage('openai', native({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }));
    expect(usage).not.toHaveProperty('cachedInputTokens');
    expect(usage).not.toHaveProperty('reasoningTokens');
    expect(toGatewayUsage('openai', undefined)).toEqual({});
  });

  it('reasoning never reaches the cost: a cached prompt is billed once, the reasoning not at all on top', () => {
    const pricing = { inputTokenPer1M: 10, outputTokenPer1M: 30, cachedTokenPer1M: 1 };
    const withReasoning = calculateCost(pricing, toGatewayUsage('openai', native({ inputTokens: 1000, outputTokens: 400, totalTokens: 1400, cachedInputTokens: 600, reasoningTokens: 300 })));
    const without = calculateCost(pricing, toGatewayUsage('openai', native({ inputTokens: 1000, outputTokens: 400, totalTokens: 1400, cachedInputTokens: 600 })));
    expect(withReasoning).toEqual(without);
    // 400 uncached x $10/1M + 400 output x $30/1M + 600 cached x $1/1M
    expect(withReasoning.totalCost).toBeCloseTo(0.004 + 0.012 + 0.0006, 8);
  });

  it('an Anthropic cache read is billed at the cached rate, not as fresh input', () => {
    const pricing = { inputTokenPer1M: 3, outputTokenPer1M: 15, cachedTokenPer1M: 0.3 };
    const cost = calculateCost(pricing, toGatewayUsage('anthropic', native({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 10_000 })));
    expect(cost.inputCost).toBeCloseTo(100 * 3 / 1e6, 10);
    expect(cost.cachedCost).toBeCloseTo(10_000 * 0.3 / 1e6, 10);
  });
});

describe('the OpenAI usage object', () => {
  it('shows reasoning as a subset of completion tokens and the cached part of the prompt', () => {
    expect(toWireUsage({ inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 60, reasoningTokens: 12 })).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      cached_tokens: 60,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 60 },
      completion_tokens_details: { reasoning_tokens: 12 },
    });
  });

  it('round-trips through the stored form', () => {
    const usage = { inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 60, reasoningTokens: 12 };
    expect(fromWireUsage(toWireUsage(usage))).toEqual(usage);
    expect(fromWireUsage(undefined)).toEqual({});
  });

  it('estimates output at chars/4, the quota pre-flight rule', () => {
    expect(estimateTokensFromText('')).toBe(0);
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('abcde')).toBe(2);
  });
});

describe('wireFinishReason', () => {
  it.each([
    // OpenAI-schema upstreams: their own word, including the ones only some servers invent.
    ['openai', 'stop', 'stop', 'stop'],
    ['openai', 'length', 'length', 'length'],
    ['openai', 'tool_calls', 'tool_calls', 'tool_calls'],
    ['openai', 'function_call', 'stop', 'function_call'],
    ['azure', 'content_filter', 'content_filter', 'content_filter'],
    ['openai-compatible', 'eos_token', 'stop', 'eos_token'],
    ['together', 'eos', 'stop', 'eos'],
    // Providers with their own vocabulary: OpenAI's.
    ['anthropic', 'end_turn', 'stop', 'stop'],
    ['anthropic', 'tool_use', 'tool_calls', 'tool_calls'],
    ['anthropic', 'max_tokens', 'length', 'length'],
    ['anthropic', 'stop_sequence', 'stop', 'stop'],
    ['anthropic', 'refusal', 'stop', 'content_filter'],
    ['bedrock', 'guardrail_intervened', 'stop', 'content_filter'],
    ['bedrock', 'content_filtered', 'content_filter', 'content_filter'],
    ['bedrock', 'tool_use', 'tool_calls', 'tool_calls'],
    ['vertex', 'STOP', 'stop', 'stop'],
    ['vertex', 'MAX_TOKENS', 'length', 'length'],
    ['vertex', 'SAFETY', 'stop', 'content_filter'],
    // Nothing from the upstream.
    ['openai', undefined, 'stop', 'stop'],
    ['anthropic', undefined, 'tool_calls', 'tool_calls'],
    ['anthropic', undefined, 'error', 'stop'],
  ] as const)('%s %s (SDK: %s) is %s on the wire', (driver, raw, sdk, wire) => {
    expect(wireFinishReason(driver, raw, sdk)).toBe(wire);
  });
});
