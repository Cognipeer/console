import { beforeEach, describe, expect, it, vi } from 'vitest';

// Synchronous factory on purpose (async importActual factories can silently
// fail to intercept). No test here touches the network.
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: vi.fn() }));

import { safeFetch } from '@/lib/security/outboundFetch';
import {
  createAlibabaNativeDecisionRuntime,
  createOpenAiNativeDecisionRuntime,
  selectDecisionRuntime,
} from '@/lib/providers/contracts/nativeDecisionRuntime';
import { createStructuredDecisionRuntime, DecisionBackendError } from '@/lib/providers/contracts/structuredDecisionRuntime';
import { DecisionRequestError } from '@/lib/providers/contracts/decisionHelpers';
import { UpstreamRequestError, InvalidRequestError } from '@/lib/providers/contracts/upstreamError';
import {
  AlibabaModelStudioProviderContract,
  OpenAiModelProviderContract,
  AzureModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import { normalizeInferenceError } from '@/lib/services/models/openaiErrors';
import type { DecisionRequest } from '@/lib/providers/domains/decision';

const fetchMock = safeFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const REQUEST: DecisionRequest = {
  input: [{ type: 'text', text: 'I was charged twice.' }],
  questions: {
    department: { type: 'choice', instructions: 'Team?', choices: { billing: 'money', technical: 'bugs' } },
    urgent: { type: 'boolean', instructions: 'Urgent?' },
    severity: { type: 'score', instructions: 'How bad?', levels: ['Cosmetic', 'Workaround available', 'Fully blocked'] },
  },
};

const OPENAI_OK = {
  model: 'gpt-6-luna',
  answers: [
    {
      type: 'choice', name: 'department', choice: 'billing', confidence: 0.93,
      probabilities: [{ value: 'billing', probability: 0.93 }, { value: 'technical', probability: 0.07 }],
    },
    { type: 'predicate', name: 'urgent', probability: 0.2 },
    {
      type: 'score', name: 'severity', score: 1.1, confidence: 0.55,
      probabilities: [
        { label: 'Cosmetic', value: 0, probability: 0.1 },
        { label: 'Workaround available', value: 1, probability: 0.7 },
        { label: 'Fully blocked', value: 2, probability: 0.2 },
      ],
    },
  ],
  usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('OpenAI native runtime', () => {
  const runtime = () => createOpenAiNativeDecisionRuntime({ apiKey: 'sk-test', organization: 'org_1', modelId: 'gpt-6-luna' });

  it('POSTs to /v1/decisions with Bearer auth and returns a native result', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_OK));
    const result = await runtime().decide(REQUEST);

    const [url, init, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/decisions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.headers['OpenAI-Organization']).toBe('org_1');
    expect(options.timeoutMs).toBeGreaterThan(0);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe('gpt-6-luna');
    expect(sent.questions.map((q: any) => q.type)).toEqual(['choice', 'predicate', 'score']);

    expect(result.backend).toEqual({ kind: 'native', provider: 'openai' });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 0 });
    expect(result.answers.urgent).toEqual({ type: 'boolean', probability: 0.2 });
    expect(result.answers.department).toMatchObject({ confidence_source: 'native' });
  });

  it('rejects http image URLs before any network call', async () => {
    await expect(runtime().decide({
      input: [{ type: 'image', data_url: 'http://example.com/a.png' }],
      questions: { q: { type: 'boolean' } },
    })).rejects.toBeInstanceOf(DecisionRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 401, 'authentication_error'],
    [403, 403, 'permission_error'],
    [429, 429, 'rate_limit_error'],
    [500, 500, 'server_error'],
    [503, 503, 'server_error'],
  ])('maps an upstream %i to a client %i (%s) and keeps the status on the error', async (upstream, status, type) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'nope' } }), { status: upstream }));
    const error = await runtime().decide(REQUEST).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect(error.status).toBe(upstream);
    const normalized = normalizeInferenceError(error);
    expect(normalized.status).toBe(status);
    expect(normalized.error.type).toBe(type);
  });

  it('raises a non-retryable backend error for a body that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 200 }));
    const error = await runtime().decide(REQUEST).catch((e) => e);
    expect(error).toBeInstanceOf(DecisionBackendError);
    expect(error.status).toBe(422);
  });

  it('raises a backend error for JSON that has the wrong shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ answers: [] }));
    await expect(runtime().decide(REQUEST)).rejects.toBeInstanceOf(DecisionBackendError);
  });

  it('lets a network failure propagate unchanged (so it stays retryable)', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    await expect(runtime().decide(REQUEST)).rejects.toThrow('ECONNRESET');
  });
});

describe('Alibaba native runtime', () => {
  const runtime = () => createAlibabaNativeDecisionRuntime({
    apiKey: 'sk-ali', workspaceId: 'ws-1', region: 'singapore', modelId: 'decision-model-preview',
  });

  const ALIBABA_OK = {
    model: 'decision-model-preview',
    request_id: 'req-1',
    answers: {
      department: { type: 'choice', choice: 'billing', confidence: 0.88, probabilities: { billing: 0.94, technical: 0.06 } },
      urgent: { type: 'noul', noul: 0.99 },
      severity: { type: 'score', score: 1.1, confidence: 0.91, legend: { 0: 'Cosmetic', 1: 'Workaround available', 2: 'Fully blocked' }, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 } },
    },
    usage: { input_tokens: 125 },
    latency_ms: 52.9,
  };

  it('POSTs to the workspace host with Bearer auth and the System One body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(ALIBABA_OK));
    const result = await runtime().decide(REQUEST);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer sk-ali');
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe('decision-model-preview');
    expect(sent.questions.urgent.type).toBe('noul');

    expect(result.backend).toEqual({ kind: 'native', provider: 'alibaba-modelstudio' });
    expect(result.usage).toEqual({ inputTokens: 125, outputTokens: 0 });
    expect(result.upstream).toEqual({ request_id: 'req-1', latency_ms: 52.9 });
  });

  it('rejects images without calling the vendor', async () => {
    await expect(runtime().decide({
      input: [{ type: 'image', data_url: 'data:image/png;base64,AAAA' }],
      questions: { q: { type: 'boolean' } },
    })).rejects.toBeInstanceOf(DecisionRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 429, 503])('keeps an upstream %i as an UpstreamRequestError', async (status) => {
    fetchMock.mockResolvedValue(new Response('{"message":"x"}', { status }));
    const error = await runtime().decide(REQUEST).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect(normalizeInferenceError(error).status).toBe(status);
  });

  it('raises a backend error for a malformed body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ answers: { department: { type: 'choice' } } }));
    await expect(runtime().decide(REQUEST)).rejects.toBeInstanceOf(DecisionBackendError);
  });

  it('refuses to build a runtime from an invalid workspace id or region', () => {
    for (const [workspaceId, region] of [['evil.com/x', 'singapore'], ['ws', 'mars'], ['', 'beijing']]) {
      expect(() => createAlibabaNativeDecisionRuntime({ apiKey: 'k', workspaceId, region, modelId: 'm' })).toThrow();
    }
  });
});

describe('Alibaba provider contract', () => {
  it('declares workspaceId + region settings and a closed region list', () => {
    const fields = AlibabaModelStudioProviderContract.form.sections.flatMap((s) => s.fields);
    expect(fields.map((f) => [f.name, f.scope ?? 'credentials'])).toEqual([
      ['apiKey', 'credentials'], ['workspaceId', 'settings'], ['region', 'settings'],
    ]);
    expect(fields.find((f) => f.name === 'region')?.options?.map((o) => o.value)).toEqual(['singapore', 'beijing']);
    expect(AlibabaModelStudioProviderContract.capabilities?.['model.categories']).toEqual(['decision']);
    expect(AlibabaModelStudioProviderContract.capabilities?.['decision.supports.image']).toBe(false);
  });

  it('validates region and workspace id when the runtime is created', async () => {
    const make = async (settings: Record<string, unknown>) =>
      AlibabaModelStudioProviderContract.createRuntime({ credentials: { apiKey: 'k' }, settings } as never);
    await expect(make({ workspaceId: 'ws', region: 'us-east' })).rejects.toThrow(/region/);
    await expect(make({ workspaceId: 'a.b', region: 'beijing' })).rejects.toThrow(/workspace id/);
    await expect(make({ region: 'beijing' })).rejects.toThrow(/workspace id/);
    await expect(make({ workspaceId: 'ws', region: 'beijing' })).resolves.toBeDefined();
  });

  it('serves native only: structured mode is a clear 400', async () => {
    const runtime = await AlibabaModelStudioProviderContract.createRuntime({
      credentials: { apiKey: 'k' }, settings: { workspaceId: 'ws', region: 'singapore' },
    } as never);
    const config = { modelId: 'decision-model-preview', category: 'decision' as const };
    expect(() => runtime.createDecisionRuntime!({ ...config, modelSettings: { decision: { mode: 'structured' } } }))
      .toThrowError(InvalidRequestError);
    expect(() => runtime.createDecisionRuntime!({ ...config, modelSettings: { decision: { mode: 'native' } } })).not.toThrow();
  });
});

describe('mode selection', () => {
  it('OpenAI: native uses the vendor endpoint, structured uses the chat emulator', async () => {
    const runtime = await OpenAiModelProviderContract.createRuntime({ credentials: { apiKey: 'sk' }, settings: {} } as never);
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_OK));
    const nativeRuntime = await runtime.createDecisionRuntime!({
      modelId: 'gpt-6-luna', category: 'decision', modelSettings: { decision: { mode: 'native' } },
    });
    const native = await nativeRuntime.decide(REQUEST);
    expect(native.backend.kind).toBe('native');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // structured never touches safeFetch (it goes through the chat model)
    const structured = runtime.createDecisionRuntime!({
      modelId: 'gpt-4o', category: 'decision', modelSettings: { decision: { mode: 'structured' } },
    });
    expect(structured).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a provider without a native adapter keeps a 400 for native mode', async () => {
    const azure = await AzureModelProviderContract.createRuntime({
      credentials: { apiKey: 'k' },
      settings: { instanceName: 'r', deploymentName: 'd', apiVersion: '2024-10-21' },
    } as never);
    expect(() => azure.createDecisionRuntime!({
      modelId: 'd', category: 'decision', modelSettings: { decision: { mode: 'native' } },
    })).toThrowError(/Native decision is not supported for provider azure/);
  });

  it('defaults to structured when no mode is set, and rejects an unknown one', () => {
    const runtime = { createChatModel: vi.fn() };
    const config = { modelId: 'm', category: 'decision' as const };
    expect(selectDecisionRuntime({ runtime, config, provider: 'openai' })).toBeDefined();
    expect(() => selectDecisionRuntime({
      runtime, provider: 'openai', config: { ...config, modelSettings: { decision: { mode: 'x' } } },
    })).toThrowError(/Unknown decision mode/);
  });
});

describe('native vs structured response-shape parity', () => {
  const strip = (answers: Record<string, any>) =>
    Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
      const { confidence: _c, confidence_source: _s, ...rest } = answer;
      return [id, rest];
    }));

  it('serves the same console shape apart from backend and confidence_source', async () => {
    // Native (OpenAI fixture).
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_OK));
    const native = await createOpenAiNativeDecisionRuntime({ apiKey: 'k', modelId: 'gpt-6-luna' }).decide(REQUEST);

    // Structured, with a fake chat model reporting the very same numbers.
    const invoke = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        answers: {
          department: { billing: 0.93, technical: 0.07 },
          urgent: 0.2,
          severity: { 0: 0.1, 1: 0.7, 2: 0.2 },
        },
      }),
      usage_metadata: { input_tokens: 42, output_tokens: 30 },
    });
    const structured = await createStructuredDecisionRuntime(
      { createChatModel: () => ({ invoke }) },
      { modelId: 'gpt-4o', category: 'decision' },
      'openai',
    ).decide(REQUEST);

    // Same answer keys, in the same order, with the same per-type field names.
    expect(Object.keys(native.answers)).toEqual(Object.keys(structured.answers));
    for (const id of Object.keys(native.answers)) {
      expect(Object.keys(native.answers[id]).sort()).toEqual(Object.keys(structured.answers[id]).sort());
    }
    // Identical values once the confidence fields are set aside.
    const nativeStripped = strip(native.answers);
    const structuredStripped = strip(structured.answers);
    expect((nativeStripped.severity as any).score).toBeCloseTo((structuredStripped.severity as any).score);
    for (const id of Object.keys(nativeStripped)) {
      if (id === 'severity') {
        const { score: _a, ...n } = nativeStripped[id] as any;
        const { score: _b, ...s } = structuredStripped[id] as any;
        expect(n).toEqual(s);
      } else {
        expect(nativeStripped[id]).toEqual(structuredStripped[id]);
      }
    }

    // What differs is exactly backend and confidence provenance.
    expect(native.backend.kind).toBe('native');
    expect(structured.backend.kind).toBe('structured');
    expect((native.answers.department as any).confidence_source).toBe('native');
    expect((structured.answers.department as any).confidence_source).toBe('self_reported');
    // Boolean has no confidence on either backend.
    expect('confidence_source' in native.answers.urgent).toBe(false);
    expect('confidence_source' in structured.answers.urgent).toBe(false);
  });
});
