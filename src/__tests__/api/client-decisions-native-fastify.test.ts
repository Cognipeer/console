import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Native decisions end to end through the Fastify plugin and the REAL driver
// contracts; only the network (safeFetch) and the DB-facing services are mocked.
// No live vendor call is made by this file.

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/models/inferenceService', () => {
  class GuardrailBlockError extends Error {
    guardrailKey = 'pii-guard';
    action = 'block';
    findings: unknown[] = [];
  }
  return { GuardrailBlockError, enforceModelGuardrailChain: vi.fn() };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn((pricing: { inputTokenPer1M?: number; outputTokenPer1M?: number }, usage: { inputTokens?: number; outputTokens?: number }) => {
    const inputCost = ((pricing.inputTokenPer1M ?? 0) * (usage.inputTokens ?? 0)) / 1_000_000;
    const outputCost = ((pricing.outputTokenPer1M ?? 0) * (usage.outputTokens ?? 0)) / 1_000_000;
    return { currency: 'USD', inputCost, outputCost, cachedCost: 0, totalCost: inputCost + outputCost };
  }),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkBudget: vi.fn().mockResolvedValue({ allowed: true }),
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  settleUsageBudget: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: vi.fn() }));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { authorizeServiceRequest, getPermissionServiceForPath } from '@/lib/security/rbac';
import { enforceModelGuardrailChain, GuardrailBlockError } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { settleUsageBudget, checkRateLimit } from '@/lib/quota/quotaGuard';
import { safeFetch } from '@/lib/security/outboundFetch';
import {
  AlibabaModelStudioProviderContract,
  OpenAiModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import { clientDecisionsApiPlugin } from '@/server/api/plugins/client-decisions';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
};

const fn = (value: unknown) => value as ReturnType<typeof vi.fn>;
const fetchMock = fn(safeFetch);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function model(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'm1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'luna', name: 'Luna',
    providerKey: 'openai-main', providerDriver: 'openai', category: 'decision', modelId: 'gpt-6-luna',
    settings: { decision: { mode: 'native' } },
    // Native pricing: $0.10 per 1M input tokens, nothing on output.
    pricing: { currency: 'USD', inputTokenPer1M: 0.1, outputTokenPer1M: 0 },
    inputGuardrailKey: 'pii-guard',
    ...overrides,
  };
}

const OPENAI_OK = {
  model: 'gpt-6-luna',
  answers: [
    { type: 'choice', name: 'department', choice: 'billing', confidence: 0.93, probabilities: [{ value: 'billing', probability: 0.93 }, { value: 'technical', probability: 0.07 }] },
    { type: 'predicate', name: 'urgent', probability: 0.2 },
  ],
  usage: { input_tokens: 1000, output_tokens: 0, total_tokens: 1000 },
};

const BODY = {
  model: 'luna',
  input: 'Charged twice, call me on 555-0100',
  questions: {
    department: { type: 'choice', instructions: 'Which team?', choices: { billing: 'money', technical: 'bugs' } },
    urgent: { type: 'boolean', instructions: 'Urgent?' },
  },
};

describe('POST /client/v1/decisions (native)', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    fn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    fn(getDatabase).mockResolvedValue({ runWithTenant: <T>(_db: string, op: () => T) => op() });
    fn(getPermissionServiceForPath).mockReturnValue('models');
    fn(authorizeServiceRequest).mockReturnValue({ allowed: true });
    fn(getModelByKey).mockResolvedValue(model());
    fn(enforceModelGuardrailChain).mockResolvedValue({ redactedText: undefined, results: [] });

    const openai = await OpenAiModelProviderContract.createRuntime({ credentials: { apiKey: 'sk-test' }, settings: {} } as never);
    fn(buildModelRuntime).mockResolvedValue({ runtime: openai, record: {} });
    fetchMock.mockResolvedValue(json(OPENAI_OK));

    app = await createFastifyApiTestApp(clientDecisionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/client/v1/decisions',
      headers: { authorization: 'Bearer tok_abc' },
      payload: payload as Record<string, unknown>,
    });

  it('serves a native decision: backend native, confidence native, input tokens only', async () => {
    const response = await post(BODY);
    expect(response.statusCode).toBe(200);
    const body = parseJsonBody<any>(response.body);
    expect(body.backend).toEqual({ kind: 'native', provider: 'openai' });
    expect(body.usage).toEqual({ input_tokens: 1000, output_tokens: 0 });
    expect(body.answers.department).toMatchObject({ type: 'choice', choice: 'billing', confidence: 0.93, confidence_source: 'native' });
    expect(body.answers.urgent).toEqual({ type: 'boolean', probability: 0.2 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/decisions');
  });

  it('prices from the model\'s own pricing: input only', async () => {
    await post(BODY);
    // 1000 * $0.10 / 1M
    expect(settleUsageBudget).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'decision' }),
      expect.objectContaining({ totalCost: expect.closeTo(0.0001, 8), outputCost: 0 }),
    );
    await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalled());
    expect(fn(logModelUsage).mock.calls[0][2]).toMatchObject({
      route: 'decisions', status: 'success', usage: { inputTokens: 1000, outputTokens: 0, totalTokens: 1000 },
    });
    expect(checkRateLimit).not.toHaveBeenCalledWith(expect.anything(), { tokens: expect.any(Number) });
  });

  it('runs the guardrails (input AND instructions AND descriptions) before the vendor call, and sends redacted text', async () => {
    fn(enforceModelGuardrailChain).mockImplementation(async ({ text }: { text: string }) => ({
      redactedText: text.replace('555-0100', '[PHONE]'),
      results: [],
    }));
    await post(BODY);

    const checked = fn(enforceModelGuardrailChain).mock.calls.map(([args]) => args.text);
    expect(checked).toEqual(['Charged twice, call me on 555-0100', 'Which team?', 'money', 'bugs', 'Urgent?']);
    expect(Math.max(...fn(enforceModelGuardrailChain).mock.invocationCallOrder))
      .toBeLessThan(Math.min(...fetchMock.mock.invocationCallOrder));
    const sent = String(fetchMock.mock.calls[0][1].body);
    expect(sent).toContain('[PHONE]');
    expect(sent).not.toContain('555-0100');
  });

  it('never calls the vendor when a guardrail blocks, and writes no error row', async () => {
    fn(enforceModelGuardrailChain).mockRejectedValue(new GuardrailBlockError('blocked', 'pii-guard', 'block', []));
    const response = await post(BODY);
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logModelUsage).not.toHaveBeenCalled();
  });

  it('401 from the vendor is a 401 for the caller, is not retried, and logs an error row', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'bad key' } }, 401));
    const response = await post(BODY);
    expect(response.statusCode).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme', expect.anything(), expect.objectContaining({ status: 'error', route: 'decisions' }),
    ));
  });

  it('429 and 5xx are retried as before; a later success returns 200', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json(OPENAI_OK));
    const response = await post(BODY);
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a malformed vendor body is a 502 that is NOT retried, and logs an error row', async () => {
    fetchMock.mockResolvedValue(json({ answers: 'nope' }));
    const response = await post(BODY);
    expect(response.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme', expect.anything(), expect.objectContaining({ status: 'error' }),
    ));
  });

  it('http image URLs never reach the vendor: 400 and no retries', async () => {
    fn(getModelByKey).mockResolvedValue(model({ settings: { decision: { mode: 'native', supports: { image: true } } } }));
    const response = await post({ ...BODY, input: [{ type: 'image', data_url: 'https://example.com/a.png' }] });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('Alibaba model', () => {
    beforeEach(async () => {
      const alibaba = await AlibabaModelStudioProviderContract.createRuntime({
        credentials: { apiKey: 'sk-ali' }, settings: { workspaceId: 'ws-1', region: 'beijing' },
      } as never);
      fn(buildModelRuntime).mockResolvedValue({ runtime: alibaba, record: {} });
      fn(getModelByKey).mockResolvedValue(model({
        providerDriver: 'alibaba-modelstudio', modelId: 'decision-model-preview',
        pricing: { currency: 'USD', inputTokenPer1M: 0.5, outputTokenPer1M: 0 },
      }));
      fetchMock.mockResolvedValue(json({
        model: 'decision-model-preview', request_id: 'r1',
        answers: {
          department: { type: 'choice', choice: 'technical', confidence: 0.8, probabilities: { billing: 0.2, technical: 0.8 } },
          urgent: { type: 'noul', noul: 0.4 },
        },
        usage: { input_tokens: 90 }, latency_ms: 40,
      }));
    });

    it('serves System One answers on the same console shape', async () => {
      const response = await post(BODY);
      expect(response.statusCode).toBe(200);
      const body = parseJsonBody<any>(response.body);
      expect(body.backend).toEqual({ kind: 'native', provider: 'alibaba-modelstudio' });
      expect(body.usage).toEqual({ input_tokens: 90, output_tokens: 0 });
      expect(body.answers.urgent).toEqual({ type: 'boolean', probability: 0.4 });
      expect(fetchMock.mock.calls[0][0]).toBe('https://ws-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone');
    });

    it('rejects images with a 400 even when the model declares image support', async () => {
      fn(getModelByKey).mockResolvedValue(model({
        providerDriver: 'alibaba-modelstudio', modelId: 'decision-model-preview',
        settings: { decision: { mode: 'native', supports: { image: true } } },
      }));
      const response = await post({ ...BODY, input: [{ type: 'image', data_url: 'data:image/png;base64,AAAA' }] });
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.message).toMatch(/text input only/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a structured-mode model on this driver is a clear 400', async () => {
      fn(getModelByKey).mockResolvedValue(model({
        providerDriver: 'alibaba-modelstudio', settings: { decision: { mode: 'structured' } },
      }));
      const response = await post(BODY);
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.message).toMatch(/Structured decision is not supported for provider alibaba-modelstudio/);
    });
  });
});
