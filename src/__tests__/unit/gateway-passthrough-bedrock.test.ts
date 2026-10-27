/**
 * Unit tests - caller passthrough on a Bedrock model
 *
 * A caller's extra fields are model-specific data: on Bedrock they land only in
 * `additionalModelRequestFields`, never at the Converse top level, which stays the operator's.
 */
import { describe, it, expect } from 'vitest';
import { buildPassthroughBody } from '@/lib/services/models/gatewayRequest';

const operator = {
  allowUnknownPassthrough: true,
  extraBody: {
    guardrailConfig: { guardrailIdentifier: 'op', guardrailVersion: '1' },
    serviceTier: { type: 'priority' },
    additionalModelRequestFields: { top_k: 5, keep: 'op' },
  },
};

describe('buildPassthroughBody on bedrock', () => {
  it('keeps the operator top-level fields and puts caller fields under additionalModelRequestFields', () => {
    const out = buildPassthroughBody(
      operator,
      {
        messages: [],
        guardrailConfig: { guardrailIdentifier: 'caller' },
        serviceTier: { type: 'flex' },
        performanceConfig: { latency: 'optimized' },
        top_k: 9,
        extra_body: { requestMetadata: { a: 'b' }, __top: { x: 1 } },
      },
      new Set(),
      'bedrock',
    )!;

    expect(out.guardrailConfig).toEqual(operator.extraBody.guardrailConfig);
    expect(out.serviceTier).toEqual(operator.extraBody.serviceTier);
    expect(out).not.toHaveProperty('performanceConfig');
    expect(out).not.toHaveProperty('requestMetadata');
    expect(out.additionalModelRequestFields).toEqual({
      top_k: 9,
      keep: 'op',
      guardrailConfig: { guardrailIdentifier: 'caller' },
      serviceTier: { type: 'flex' },
      performanceConfig: { latency: 'optimized' },
      requestMetadata: { a: 'b' },
    });
  });

  it('merges a caller additionalModelRequestFields per key and drops request-owned and "__" keys', () => {
    const out = buildPassthroughBody(
      operator,
      {
        messages: [],
        additionalModelRequestFields: { top_k: 1, __top: { y: 1 } },
        inferenceConfig: { maxTokens: 1 },
        toolConfig: {},
        system: [],
      },
      new Set(),
      'bedrock',
    )!;

    expect(out.additionalModelRequestFields).toEqual({ top_k: 1, keep: 'op' });
    expect(out).not.toHaveProperty('inferenceConfig');
    expect(out).not.toHaveProperty('toolConfig');
  });

  it('leaves other drivers unchanged (caller wins at the top level)', () => {
    const out = buildPassthroughBody(
      { allowUnknownPassthrough: true, extraBody: { top_k: 1 } },
      { messages: [], top_k: 7, serviceTier: 'x' },
      new Set(),
      'openai',
    )!;
    expect(out).toEqual({ top_k: 7, serviceTier: 'x' });
  });
});
