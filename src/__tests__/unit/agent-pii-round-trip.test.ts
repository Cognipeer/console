/**
 * An agent with reversible PII protection, through a REAL agent-sdk loop, the
 * REAL gateway core and the REAL OpenAI provider (only the network, the model
 * record and the policy lookup are scripted):
 *
 *   - the provider never receives the TCKN, in any step of the tool loop;
 *   - the tool is called with the REAL value, and its result is tokenized again
 *     before the next step, into the SAME token (session-scoped);
 *   - the answer and the transcript the agent keeps hold the real value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completion, json, openAiRuntime, stubUpstream, type UpstreamCall } from '../helpers/nativeGateway';

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return {
        ...config,
        auth: { ...config.auth, providerEncryptionSecret: 'test-secret' },
        gateway: { ...config.gateway, retryEnabled: false, circuitBreakerEnabled: false },
      };
    },
  };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('v'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({ getCachedGuardrail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/guardrail', () => ({ evaluateGuardrail: vi.fn(), createStreamGate: vi.fn() }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/pii/piiService', async () => {
  const { detect } = await import('@/lib/services/pii/detector');
  return {
    loadPolicyScanner: vi.fn(async () => ({
      policyKey: 'tc-only',
      version: 'tc-only@1',
      scan: async (text: string) => detect(text, { categories: { tc_kimlik: true }, languages: ['global', 'tr'] }),
    })),
  };
});

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { buildGatewayChatModel } from '@/lib/services/agents/gatewayChatModel';
import { clearRoundTripScanCache } from '@/lib/services/pii/roundTrip';

const TC = '12345678950';
const TOKEN = /\[TC_KIMLIK_[a-z]{8}\]/g;
const model = {
  _id: 'm-id', tenantId: 't', projectId: 'p', name: 'm', key: 'm', providerKey: 'prov', providerDriver: 'openai',
  category: 'llm' as const, modelId: 'gpt-4o', settings: {}, pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 },
};
const tokensIn = (call: UpstreamCall) => [...JSON.stringify(call.body.messages).matchAll(TOKEN)].map((m) => m[0]);

beforeEach(async () => {
  vi.clearAllMocks();
  clearRoundTripScanCache();
  (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
  const runtime = await openAiRuntime();
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime });
});
afterEach(() => vi.unstubAllGlobals());

async function runProtectedAgent(sessionId: string, toolArgs: string[]) {
  const { createSmartAgent, createTool } = await import('@cognipeer/agent-sdk');
  const { z } = await import('zod');
  const lookup = createTool({
    name: 'lookup',
    description: 'Find a customer by TCKN',
    schema: z.object({ tckn: z.string() }),
    func: async (args: { tckn: string }) => {
      toolArgs.push(args.tckn);
      return `Customer ${args.tckn}: Ayşe Yılmaz, status active`;
    },
  });
  const chatModel = await buildGatewayChatModel({
    tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', model: model as never,
    agentKey: 'support', sessionId, piiProtection: { policyKey: 'tc-only' },
  });
  const agent = createSmartAgent({ model: chatModel, tools: [lookup], systemPrompt: 'Be brief.' } as never);
  return agent.invoke({ messages: [{ role: 'user', content: `TCKN ${TC} olan müşteriyi bul` }] } as never) as Promise<{
    content?: string;
    messages: Array<Record<string, unknown>>;
  }>;
}

describe('an agent with PII protection', () => {
  it('keeps the TCKN away from the model while the tool, the answer and the transcript get the real value', async () => {
    const upstream = stubUpstream((call, index) => {
      const [token] = tokensIn(call);
      return json(index === 0
        ? completion({ content: null, toolCalls: [{ id: 'c1', name: 'lookup', arguments: JSON.stringify({ tckn: token }) }] })
        : completion({ content: `${token} numaralı müşteri aktif.` }));
    });
    const toolArgs: string[] = [];

    const result = await runProtectedAgent('sess-1', toolArgs);

    expect(upstream.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of upstream.calls) expect(JSON.stringify(call.body)).not.toContain(TC);
    // One value, one token, in every step: the second step's history (user turn, the
    // assistant's tool call, the tool result) all carry the token the first step used.
    const first = tokensIn(upstream.calls[0]);
    const second = tokensIn(upstream.calls[1]);
    expect(new Set(first).size).toBe(1);
    expect(new Set(second)).toEqual(new Set(first));
    expect(second.length).toBeGreaterThanOrEqual(3);

    expect(toolArgs).toEqual([TC]);
    expect(result.content).toBe(`${TC} numaralı müşteri aktif.`);
    expect(JSON.stringify(result.messages)).toContain(TC);
    expect(JSON.stringify(result.messages)).not.toMatch(TOKEN);
  });

  it('scopes tokens to the session', async () => {
    const upstream = stubUpstream(() => json(completion({ content: 'ok' })));
    await runProtectedAgent('sess-a', []);
    await runProtectedAgent('sess-a', []);
    await runProtectedAgent('sess-b', []);
    const [a, b, c] = upstream.calls.map((call) => tokensIn(call)[0]);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});
