/**
 * normalizeTraceEventUsage: the one place an external trace event's native token
 * counts are folded into the console's inclusive basis.
 */
import { describe, expect, it } from 'vitest';
import { normalizeTraceEventUsage } from '@/lib/services/tracing/traceUsage';

describe('normalizeTraceEventUsage', () => {
  it('anthropic basis: input += cache read + write, total recomputed', () => {
    const out = normalizeTraceEventUsage({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 400,
      cacheWriteTokens: 200,
      totalTokens: 150,
      usageBasis: { inputExcludesCache: true },
    });
    expect(out).toMatchObject({
      inputTokens: 700,
      outputTokens: 50,
      cachedInputTokens: 400,
      cachedWriteTokens: 200,
      totalTokens: 750,
      adjusted: true,
      inputDelta: 600,
      outputDelta: 0,
    });
  });

  it('vertex basis: output += reasoning', () => {
    const out = normalizeTraceEventUsage({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 30,
      usageBasis: { outputExcludesReasoning: true },
    });
    expect(out).toMatchObject({ inputTokens: 100, outputTokens: 80, reasoningTokens: 30, totalTokens: 180, adjusted: true, outputDelta: 30 });
  });

  it('no basis: passes everything through and does not inflate the total', () => {
    const out = normalizeTraceEventUsage({
      inputTokens: 1000,
      outputTokens: 50,
      cachedInputTokens: 400,
      cacheWriteTokens: 100,
      totalTokens: 1050,
    });
    expect(out).toMatchObject({ inputTokens: 1000, outputTokens: 50, totalTokens: 1050, adjusted: false, inputDelta: 0 });
    expect(out.cachedWriteTokens).toBe(100);
  });

  it('false flags are a no-op', () => {
    const out = normalizeTraceEventUsage({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 4,
      usageBasis: { inputExcludesCache: false, outputExcludesReasoning: false },
    });
    expect(out).toMatchObject({ inputTokens: 10, outputTokens: 5, adjusted: false });
  });

  it('stores cachedWriteTokens only when > 0 and leaves absent fields undefined', () => {
    const out = normalizeTraceEventUsage({ cacheWriteTokens: 0 });
    expect(out.cachedWriteTokens).toBeUndefined();
    expect(out.inputTokens).toBeUndefined();
    expect(out.outputTokens).toBeUndefined();
    expect(out.cachedInputTokens).toBeUndefined();
    expect(out.totalTokens).toBeUndefined();
    expect(out.adjusted).toBe(false);
  });

  it('does not invent an input count when the basis says to fold but input is absent', () => {
    const out = normalizeTraceEventUsage({ cachedInputTokens: 50, usageBasis: { inputExcludesCache: true } });
    expect(out.inputTokens).toBeUndefined();
    expect(out.adjusted).toBe(false);
  });

  it('ignores negative, NaN and non-numeric values', () => {
    const out = normalizeTraceEventUsage({
      inputTokens: -5,
      outputTokens: Number.NaN,
      cachedInputTokens: 'abc',
      cacheWriteTokens: -1,
      usageBasis: { inputExcludesCache: true },
    });
    expect(out.inputTokens).toBeUndefined();
    expect(out.outputTokens).toBeUndefined();
    expect(out.cachedInputTokens).toBeUndefined();
    expect(out.cachedWriteTokens).toBeUndefined();
  });

  it('accepts numeric strings and ignores a malformed basis', () => {
    const out = normalizeTraceEventUsage({ inputTokens: '10', outputTokens: 5, usageBasis: 'yes' });
    expect(out).toMatchObject({ inputTokens: 10, outputTokens: 5, adjusted: false });
  });
});
