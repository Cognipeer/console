/**
 * Bedrock extra-body routing (only the operator's model-level body reaches the Converse top level) and
 * Vertex Gemini thinking fitted under a caller's output cap.
 */
import { describe, expect, it } from 'vitest';
import { BedrockModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import { modelDefaultReasoning, resolveNativeCall } from '@/lib/providers/contracts/nativeClients';
import { computeOutputTokenLimit, fitThinkingToLimit } from '@/lib/services/models/outputLimits';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function bedrockBody(requestDefaults: Record<string, unknown>, extra?: Record<string, unknown>) {
  const runtime = await (BedrockModelProviderContract.createRuntime as unknown as (ctx: unknown) => Promise<ModelProviderRuntime>)({
    tenantId: 't', projectId: 'p', providerKey: 'prov', logger, metadata: {},
    credentials: { accessKeyId: 'AKIA1', secretAccessKey: 'secret' }, settings: { region: 'eu-central-1' },
  });
  let body: Record<string, any> = {};
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  const client = await runtime.createNativeChatClient!(
    { modelId: 'amazon.nova-pro-v1:0', category: 'llm', modelSettings: { requestDefaults } } as never, { fetch });
  await client.complete({ messages: [{ role: 'user', content: 'hi' }], ...(extra ? { extra } : {}) });
  return body;
}

describe('bedrock extra body routing', () => {
  it('the operator guardrailConfig reaches the Converse top level', async () => {
    const body = await bedrockBody({ guardrailConfig: { guardrailIdentifier: 'g1', guardrailVersion: '1' }, top_k: 5 });
    expect(body.guardrailConfig).toEqual({ guardrailIdentifier: 'g1', guardrailVersion: '1' });
    expect(body.additionalModelRequestFields).toMatchObject({ top_k: 5 });
  });

  it('a caller __top is ignored', async () => {
    const body = await bedrockBody({}, { __top: { guardrailConfig: { guardrailIdentifier: 'evil' }, serviceTier: { type: 'x' } } });
    expect(body.guardrailConfig).toBeUndefined();
    expect(body.serviceTier).toBeUndefined();
    expect(JSON.stringify(body.additionalModelRequestFields ?? {})).not.toContain('evil');
  });

  it('a caller guardrailConfig lands inert in additionalModelRequestFields and never replaces the operator\'s', async () => {
    const body = await bedrockBody(
      { guardrailConfig: { guardrailIdentifier: 'ops', guardrailVersion: '1' }, top_k: 5 },
      { guardrailConfig: { guardrailIdentifier: 'caller' }, performanceConfig: { latency: 'optimized' }, top_p_extra: 1 },
    );
    expect(body.guardrailConfig).toEqual({ guardrailIdentifier: 'ops', guardrailVersion: '1' });
    expect(body.performanceConfig).toBeUndefined();
    expect(body.additionalModelRequestFields).toMatchObject({
      top_k: 5, guardrailConfig: { guardrailIdentifier: 'caller' }, performanceConfig: { latency: 'optimized' }, top_p_extra: 1,
    });
  });

  it('additionalModelRequestFields of operator and caller are deep merged (caller wins per key)', async () => {
    const body = await bedrockBody(
      { additionalModelRequestFields: { a: 1, b: 1 } },
      { additionalModelRequestFields: { b: 2, c: 3 } },
    );
    expect(body.additionalModelRequestFields).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  it('operator __top is dropped too', async () => {
    const body = await bedrockBody({ __top: { guardrailConfig: { guardrailIdentifier: 'x' } } });
    expect(body.guardrailConfig).toBeUndefined();
  });
});

describe('vertex Gemini thinking under a caller cap', () => {
  it('a caller cap is never raised and the budget is fitted under it', () => {
    const limit = computeOutputTokenLimit({ driver: 'vertex', modelId: 'gemini-2.5-pro', override: 3000, reasoning: { budgetTokens: 5000 } });
    expect(limit).toBe(3000);
    expect(fitThinkingToLimit({ budgetTokens: 5000 }, { driver: 'vertex', modelId: 'gemini-2.5-pro', limit })).toEqual({ budgetTokens: 952 });
  });

  it('under the model minimum: Pro sends 128, Flash turns thinking off', () => {
    expect(fitThinkingToLimit({ budgetTokens: 5000 }, { driver: 'vertex', modelId: 'gemini-2.5-pro', limit: 1000 })).toEqual({ budgetTokens: 128 });
    expect(fitThinkingToLimit({ budgetTokens: 5000 }, { driver: 'vertex', modelId: 'gemini-2.5-flash', limit: 1000 }))
      .toMatchObject({ effort: 'none' });
  });

  it('a budget that fits, none and dynamic are left alone', () => {
    const fit = (r: any, limit = 9000) => fitThinkingToLimit(r, { driver: 'vertex', modelId: 'gemini-2.5-pro', limit });
    expect(fit({ budgetTokens: 4000 })).toEqual({ budgetTokens: 4000 });
    expect(fit({ effort: 'none' })).toEqual({ effort: 'none' });
  });

  it('the model\'s own limit is still raised above the budget (not a caller cap)', () => {
    expect(computeOutputTokenLimit({ driver: 'vertex', modelId: 'gemini-2.5-pro', configured: 1000, reasoning: { budgetTokens: 4000 } })).toBe(6048);
  });

  it('native path = gateway: same limit, fitted reasoning', () => {
    const call = resolveNativeCall({ driver: 'vertex', modelId: 'gemini-2.5-pro', overrides: {}, requestMaxTokens: 3000, reasoning: { budgetTokens: 5000 } });
    expect(call.maxTokens).toBe(3000);
    expect(call.reasoning).toEqual({ budgetTokens: 952 });
  });
});

describe('modelDefaultReasoning export', () => {
  it('is exported and keeps reasoning off non-Claude Bedrock', () => {
    expect(modelDefaultReasoning('bedrock', 'amazon.nova-pro-v1:0', {}, { effort: 'low' })).toBeUndefined();
    expect(modelDefaultReasoning('openai', 'gpt-5.2', {}, { effort: 'low' })).toEqual({ effort: 'low' });
  });
});
