/**
 * Reversible PII protection through the REAL gateway core and the REAL OpenAI
 * provider; only the network, the model record and the policy lookup are
 * scripted. What is pinned: the provider never receives a value the policy
 * finds, the usage rows hold tokens only, and the caller gets the values back
 * in the answer, in tool-call arguments and in a stream that splits a token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall } from '@/lib/services/models/inferenceService';
import type { GatewayChatRequest, ModelStreamEvent } from '@/lib/services/models/gatewayTypes';
import { chunk, completion, flush, json, openAiRuntime, sse, stubUpstream, type UpstreamCall } from '../helpers/nativeGateway';

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
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({ getCachedGuardrail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  }),
  createStreamGate: vi.fn(),
}));
vi.mock('@/lib/services/pii/piiService', async () => {
  const { detect } = await import('@/lib/services/pii/detector');
  return {
    loadPolicyScanner: vi.fn(async ({ policyKey }: { policyKey: string }) => (policyKey === 'off'
      ? null
      : {
        policyKey,
        version: `${policyKey}@1`,
        scan: async (text: string) => detect(text, { categories: { tc_kimlik: true }, languages: ['global', 'tr'] }),
      })),
  };
});

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { clearRoundTripScanCache } from '@/lib/services/pii/roundTrip';

const TC_A = '12345678950';
const TC_B = '98765432150';
const TOKEN = /\[TC_KIMLIK_[a-z]{8}\]/g;

const model = (overrides: object = {}) => ({
  _id: 'm1', tenantId: 'tenant-1', projectId: 'proj-1', name: 'M', key: 'm', providerKey: 'prov',
  providerDriver: 'openai', category: 'llm' as const, modelId: 'gpt-4o', settings: {},
  pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 },
  piiProtection: { policyKey: 'tc-only' },
  ...overrides,
});
const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'm' };
const ask = (text: string): GatewayChatRequest => ({ messages: [{ role: 'user', content: text }] });

const tokensSent = (call: UpstreamCall) => [...JSON.stringify(call.body.messages).matchAll(TOKEN)].map((m) => m[0]);
const rows = () => (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);

async function collect(stream: AsyncGenerator<ModelStreamEvent, void, void>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearRoundTripScanCache();
  (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model());
  const runtime = await openAiRuntime();
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime });
});
afterEach(() => vi.unstubAllGlobals());

describe('a protected model, non-streamed', () => {
  it('sends tokens to the provider and gives the caller the values back', async () => {
    const upstream = stubUpstream((call) => {
      const [token] = tokensSent(call);
      return json(completion({ content: `Kayıt ${token} doğrulandı.` }));
    });

    const outcome = await executeModelCall({
      ...BASE,
      request: ask(`TCKN ${TC_A} olan müşteriyi doğrula`),
      wire: { messages: [{ role: 'user', content: `TCKN ${TC_A} olan müşteriyi doğrula` }] },
    });
    await flush();

    const sent = JSON.stringify(upstream.calls[0].body);
    expect(sent).not.toContain(TC_A);
    expect(tokensSent(upstream.calls[0])).toHaveLength(1);
    expect(outcome.result!.response.content).toBe(`Kayıt ${TC_A} doğrulandı.`);
    expect((outcome.wire!.choices as Array<{ message: { content: string } }>)[0].message.content).toBe(`Kayıt ${TC_A} doğrulandı.`);
    // The usage row (request and response) holds tokens only.
    const row = JSON.stringify(rows()[0]);
    expect(row).not.toContain(TC_A);
    expect(row).toMatch(TOKEN);
  });

  it('tokenizes the whole history and restores tool-call arguments as valid JSON', async () => {
    const upstream = stubUpstream((call) => {
      // The user's customer (message 1), not the system prompt's number.
      const [token] = JSON.stringify(call.body.messages[1]).match(TOKEN) ?? [];
      return json(completion({ content: null, toolCalls: [{ id: 'c2', name: 'lookup', arguments: `{"tckn":"${token}"}` }] }));
    });

    const outcome = await executeModelCall({
      ...BASE,
      request: {
        messages: [
          { role: 'system', content: `Yetkili kullanıcı TCKN ${TC_B}` },
          { role: 'user', content: `Müşteri ${TC_A}` },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lookup', arguments: `{"tckn":"${TC_A}"}` }] },
          { role: 'tool', toolCallId: 'c1', content: `{"tckn":"${TC_A}","status":"active"}` },
          { role: 'user', content: 'Tekrar sorgula' },
        ],
        tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object', properties: { tckn: { type: 'string' } } } }],
      },
    });

    const body = JSON.stringify(upstream.calls[0].body);
    expect(body).not.toContain(TC_A);
    expect(body).not.toContain(TC_B);
    // One value, one token, wherever it appears.
    const tokens = tokensSent(upstream.calls[0]);
    expect(new Set(tokens).size).toBe(2);
    expect(JSON.parse(outcome.result!.response.toolCalls[0].arguments)).toEqual({ tckn: TC_A });
  });

  it('refuses a part it cannot scan instead of sending it', async () => {
    const upstream = stubUpstream(() => json(completion()));
    await expect(executeModelCall({
      ...BASE,
      request: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }] },
    })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('"image" part') });
    expect(upstream.calls).toHaveLength(0);
  });
});

describe('a protected model, streamed', () => {
  it('restores a token the provider splits across chunks, in the deltas and in the done event', async () => {
    stubUpstream((call) => {
      const [token] = tokensSent(call);
      return sse([
        chunk.text('Kayıt '),
        chunk.text(token.slice(0, 6)),
        chunk.text(token.slice(6, 15)),
        chunk.text(`${token.slice(15)} tamam`),
        chunk.tool(0, { id: 'c1', name: 'lookup', arguments: `{"tckn":"${token.slice(0, 9)}` }),
        chunk.tool(0, { arguments: `${token.slice(9)}"}` }),
        chunk.finish('tool_calls'),
      ]);
    });

    const outcome = await executeModelCall({ ...BASE, request: ask(`TCKN ${TC_A}`), stream: true });
    const events = await collect(outcome.stream!);

    const deltas = events.filter((e): e is Extract<ModelStreamEvent, { type: 'delta' }> => e.type === 'delta');
    const text = deltas.map((d) => d.content ?? '').join('');
    const args = deltas.flatMap((d) => d.toolCalls ?? []).map((c) => c.arguments ?? '').join('');
    expect(text).toBe(`Kayıt ${TC_A} tamam`);
    expect(JSON.parse(args)).toEqual({ tckn: TC_A });
    for (const d of deltas) expect(d.content ?? '').not.toMatch(/TC_KIMLIK/);
    const done = events.at(-1) as Extract<ModelStreamEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.response.content).toBe(`Kayıt ${TC_A} tamam`);
    expect(JSON.parse(done.response.toolCalls[0].arguments)).toEqual({ tckn: TC_A });
  });
});

describe('which calls are protected', () => {
  it('a caller (an agent) protects a model that has no protection of its own, with tokens scoped to it', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ piiProtection: undefined }));
    const upstream = stubUpstream(() => json(completion()));
    const call = (scope: string) => executeModelCall({
      ...BASE,
      request: ask(`TCKN ${TC_A}`),
      context: { piiProtection: { policyKey: 'tc-only', scope } },
    });

    await call('session:1');
    await call('session:1');
    await call('session:2');

    const [a, b, c] = upstream.calls.map((sent) => tokensSent(sent)[0]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('an unprotected model, or a disabled policy, sends the text as it is', async () => {
    const upstream = stubUpstream(() => json(completion()));
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ piiProtection: undefined }));
    await executeModelCall({ ...BASE, request: ask(`TCKN ${TC_A}`) });
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model({ piiProtection: { policyKey: 'off' } }));
    await executeModelCall({ ...BASE, request: ask(`TCKN ${TC_A}`) });
    for (const sent of upstream.calls) expect(JSON.stringify(sent.body)).toContain(TC_A);
  });
});
