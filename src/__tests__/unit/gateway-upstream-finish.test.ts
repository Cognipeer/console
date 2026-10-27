/**
 * The pure pieces of two gateway-core fixes:
 *
 *  - a call the provider ended in its OWN error finish (Gemini MALFORMED_FUNCTION_CALL, Bedrock
 *    malformed_tool_use ...) fails as an upstream error (`UpstreamFinishError`, 502) instead of
 *    reading as a clean `stop`;
 *  - a stream that stopped short of its terminal chunk books its output at the larger of the
 *    provider's floor and the estimate (`floorOutputAtEstimate`).
 */

import { describe, expect, it } from 'vitest';
import { UpstreamRequestError } from '@/lib/providers/contracts/upstreamError';
import {
  isUsageBookedError,
  normalizeInferenceError,
  OutputTokenLimitError,
  UpstreamFinishError,
} from '@/lib/services/models/openaiErrors';
import { isProviderErrorFinish, wireFinishReason } from '@/lib/services/models/gatewayStream';
import { floorOutputAtEstimate } from '@/lib/services/models/gatewayUsage';

describe('UpstreamFinishError', () => {
  it('is an upstream error with a 502 that names the provider\'s raw reason and derives its code from it', () => {
    const error = new UpstreamFinishError('MALFORMED_FUNCTION_CALL');

    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect(error.status).toBe(502);
    expect(error.name).toBe('UpstreamFinishError');
    expect(error.rawFinishReason).toBe('MALFORMED_FUNCTION_CALL');
    expect(error.code).toBe('malformed_function_call');
    expect(error.message).toContain('(MALFORMED_FUNCTION_CALL)');
  });

  it.each([
    ['malformed_tool_use', 'malformed_tool_use'],
    ['malformed_model_output', 'malformed_model_output'],
    ['UNEXPECTED_TOOL_CALL', 'unexpected_tool_call'],
    ['insufficient_system_resource', 'insufficient_system_resource'],
    ['vendor:odd.reason-1', 'vendor_odd_reason_1'],
  ])('derives the code of %s as %s', (raw, code) => {
    expect(new UpstreamFinishError(raw).code).toBe(code);
  });

  it('names nothing when the provider sent no reason, or only the SDK\'s own word for an error finish', () => {
    for (const raw of [undefined, '', '  ', 'error', 'ERROR']) {
      const error = new UpstreamFinishError(raw);
      expect(error.rawFinishReason).toBeUndefined();
      expect(error.code).toBe('provider_error');
      expect(error.message).not.toContain('(');
    }
  });

  it('never echoes an odd stop reason into the message or the code', () => {
    const error = new UpstreamFinishError('MALFORMED <script>alert(1)</script>');

    expect(error.rawFinishReason).toBeUndefined();
    expect(error.code).toBe('provider_error');
    expect(error.message).not.toContain('script');
  });

  it('carries what the core billed for the call and says it is booked', () => {
    const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 };
    const cost = { currency: 'USD', inputCost: 0.001, outputCost: 0.002, cachedCost: 0, cacheWriteCost: 0, totalCost: 0.003 };
    const error = new UpstreamFinishError('MALFORMED_FUNCTION_CALL', { usage, cost, usageBooked: true });

    expect(error.usage).toEqual(usage);
    expect(error.cost).toEqual(cost);
    expect(error.usageBooked).toBe(true);
    expect(new UpstreamFinishError('MALFORMED_FUNCTION_CALL').usageBooked).toBeUndefined();
  });

  it('is a usage-booked error for the HTTP edges only once the core booked it', () => {
    expect(isUsageBookedError(new UpstreamFinishError('x', { usageBooked: true }))).toBe(true);
    expect(isUsageBookedError(new UpstreamFinishError('x'))).toBe(false);
    // The output-limit error keeps its own answer.
    expect(isUsageBookedError(new OutputTokenLimitError(512, { usageBooked: true }))).toBe(true);
    expect(isUsageBookedError(new UpstreamRequestError('x', 502))).toBe(false);
  });
});

describe('normalizeInferenceError: an upstream error finish', () => {
  it('is a 502 server_error whose code comes from the raw reason, never the usage or the cost', () => {
    const error = new UpstreamFinishError('MALFORMED_FUNCTION_CALL', {
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      usageBooked: true,
    });

    expect(normalizeInferenceError(error)).toEqual({
      status: 502,
      error: {
        message: error.message,
        type: 'server_error',
        code: 'malformed_function_call',
      },
    });
  });

  it('falls back to the provider_error code when the provider named no reason', () => {
    expect(normalizeInferenceError(new UpstreamFinishError())).toMatchObject({
      status: 502,
      error: { type: 'server_error', code: 'provider_error' },
    });
  });

  it('is not caught by the keyword rules that route other upstream faults (a raw reason that reads like one)', () => {
    // `unexpected_tool_call` / `malformed_tool_use` contain words other rules look for; the class decides first.
    for (const raw of ['UNEXPECTED_TOOL_CALL', 'malformed_tool_use', 'rate_limit_like', 'context_length_like']) {
      expect(normalizeInferenceError(new UpstreamFinishError(raw)).status).toBe(502);
    }
  });
});

describe('isProviderErrorFinish', () => {
  it.each([
    // The SDK's own normalization: agent-sdk >= 0.21 maps Gemini's malformed-call reasons to `error`.
    ['MALFORMED_FUNCTION_CALL', 'error', true],
    ['UNEXPECTED_TOOL_CALL', 'error', true],
    ['insufficient_system_resource', 'error', true],
    [undefined, 'error', true],
    // Bedrock reaches the gateway as a plain `stop` until agent-sdk 0.22: the raw reason is judged too.
    ['malformed_model_output', 'stop', true],
    ['malformed_tool_use', 'stop', true],
    ['MALFORMED_TOOL_USE', 'stop', true],
    // Everything else finishes.
    ['STOP', 'stop', false],
    ['end_turn', 'stop', false],
    ['tool_use', 'tool_calls', false],
    ['max_tokens', 'length', false],
    ['guardrail_intervened', 'content_filter', false],
    [undefined, 'stop', false],
    [undefined, undefined, false],
  ] as const)('%s (SDK: %s) is an error finish: %s', (raw, normalized, expected) => {
    expect(isProviderErrorFinish(raw, normalized)).toBe(expected);
  });

  it('leaves the wire mapping of a bare mapping call alone (the core fails such a call before it reaches the wire)', () => {
    expect(wireFinishReason('anthropic', undefined, 'error')).toBe('stop');
    expect(wireFinishReason('vertex', 'MALFORMED_FUNCTION_CALL', 'error')).toBe('stop');
  });
});

describe('floorOutputAtEstimate', () => {
  // Anthropic's message_start: the exact prompt (with a cache read) and an output of about 1.
  const startOfStream = {
    inputTokens: 70,
    outputTokens: 1,
    totalTokens: 71,
    cachedInputTokens: 30,
    cachedWriteTokens: 5,
    reasoningTokens: 0,
    toolCalls: 2,
  };

  it('books the estimate when it is larger, keeping the provider\'s prompt, cache and tool-call counts', () => {
    const { usage, estimated } = floorOutputAtEstimate(startOfStream, 100);

    expect(estimated).toBe(true);
    expect(usage).toEqual({ ...startOfStream, outputTokens: 100, totalTokens: 170 });
  });

  it('keeps the provider\'s usage untouched when its output is already the larger one', () => {
    const provider = { ...startOfStream, outputTokens: 500, totalTokens: 570 };
    const result = floorOutputAtEstimate(provider, 120);

    expect(result.estimated).toBe(false);
    expect(result.usage).toBe(provider);
  });

  it('does not call an equal estimate a win', () => {
    const result = floorOutputAtEstimate(startOfStream, 1);

    expect(result.estimated).toBe(false);
    expect(result.usage).toBe(startOfStream);
  });

  it('keeps the reasoning subset and totals on input plus output when the usage had no total', () => {
    const { usage, estimated } = floorOutputAtEstimate({ inputTokens: 40, outputTokens: 2, reasoningTokens: 1 }, 25);

    expect(estimated).toBe(true);
    expect(usage).toEqual({ inputTokens: 40, outputTokens: 25, totalTokens: 65, reasoningTokens: 1 });
  });

  it('treats a missing output as zero', () => {
    expect(floorOutputAtEstimate({ inputTokens: 10 }, 4)).toEqual({
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      estimated: true,
    });
    expect(floorOutputAtEstimate({ inputTokens: 10 }, 0).estimated).toBe(false);
  });
});
