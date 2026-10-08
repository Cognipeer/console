import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every factory below is synchronous on purpose: an async vi.mock factory that
// awaits importActual can silently fail to intercept (see the repo's
// reference notes on the vitest importActual trap).

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

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { authorizeServiceRequest, getPermissionServiceForPath } from '@/lib/security/rbac';
import { enforceModelGuardrailChain, GuardrailBlockError } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { checkRateLimit, settleUsageBudget } from '@/lib/quota/quotaGuard';
import { mapSegmentsBounded } from '@/lib/services/models/decisionService';
import { selectDecisionRuntime } from '@/lib/providers/contracts/nativeDecisionRuntime';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
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

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function decisionModel(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'm1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'triage',
    name: 'Triage',
    providerKey: 'openai-main',
    providerDriver: 'openai',
    category: 'decision',
    modelId: 'gpt-4o',
    settings: { decision: { mode: 'structured' } },
    pricing: { currency: 'USD', inputTokenPer1M: 2, outputTokenPer1M: 10 },
    // The deprecated single slot is what `resolveBindings` falls back to.
    inputGuardrailKey: 'pii-guard',
    ...overrides,
  };
}

const CHAT_ANSWER = {
  content: JSON.stringify({
    answers: {
      mood: { happy: 0.7, upset: 0.3 },
      urgent: 0.1,
      severity: { 0: 0.5, 1: 0.5 },
    },
  }),
  usage_metadata: { input_tokens: 1000, output_tokens: 50 },
};

const BODY = {
  model: 'triage',
  input: 'My email is jane@example.com and my parcel is late.',
  questions: {
    mood: { type: 'choice', instructions: 'Call me at 555-0100', choices: { happy: 'glad', upset: 'angry' } },
    urgent: { type: 'boolean', instructions: 'Is it time critical?' },
    severity: { type: 'score', levels: ['minor', 'major'] },
  },
};

describe('POST /client/v1/decisions', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let invoke: ReturnType<typeof vi.fn>;
  let chatRuntime: ModelProviderRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({
      runWithTenant: <T>(_db: string, operation: () => T) => operation(),
    });
    mockFn(getPermissionServiceForPath).mockReturnValue('models');
    mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });

    mockFn(getModelByKey).mockResolvedValue(decisionModel());
    // By default the guardrail passes the text through untouched.
    mockFn(enforceModelGuardrailChain).mockResolvedValue({ redactedText: undefined, results: [] });

    invoke = vi.fn().mockResolvedValue(CHAT_ANSWER);
    chatRuntime = { createChatModel: vi.fn().mockReturnValue({ invoke }) };
    chatRuntime.createDecisionRuntime = (config) => selectDecisionRuntime({ runtime: chatRuntime, config, provider: 'openai' });
    mockFn(buildModelRuntime).mockResolvedValue({ runtime: chatRuntime, record: {} });

    app = await createFastifyApiTestApp(clientDecisionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  function post(payload: unknown) {
    return app.inject({
      method: 'POST',
      url: '/api/client/v1/decisions',
      headers: { authorization: 'Bearer tok_abc' },
      payload: payload as Record<string, unknown>,
    });
  }

  it('serves a decision from a mocked chat model and returns the contract shape', async () => {
    const response = await post(BODY);
    expect(response.statusCode).toBe(200);
    const body = parseJsonBody<any>(response.body);

    expect(body.id).toMatch(/^dec_/);
    expect(body.model).toBe('triage');
    expect(body.backend).toEqual({ kind: 'structured', provider: 'openai' });
    expect(body.usage).toEqual({ input_tokens: 1000, output_tokens: 50 });
    expect(typeof body.latency_ms).toBe('number');
    expect(body.rationale).toBeUndefined();

    expect(body.answers.mood).toMatchObject({ type: 'choice', choice: 'happy', confidence_source: 'self_reported' });
    expect(body.answers.mood.confidence).toBeCloseTo(0.7);
    expect(body.answers.urgent).toEqual({ type: 'boolean', probability: 0.1 });
    expect(body.answers.severity).toMatchObject({ type: 'score', legend: { 0: 'minor', 1: 'major' } });
    expect(body.answers.severity.score).toBeCloseTo(0.5);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1].response_format.json_schema.strict).toBe(true);
  });

  it('records input and output tokens against the model price and settles the budget', async () => {
    await post(BODY);
    // 1000 in * $2/1M + 50 out * $10/1M
    expect(settleUsageBudget).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'decision', resourceKey: 'triage' }),
      expect.objectContaining({ totalCost: expect.closeTo(0.0025, 6) }),
    );
    // fireAndForget runs the logger on a microtask.
    await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalled());
    const [, , payload] = mockFn(logModelUsage).mock.calls[0];
    expect(payload).toMatchObject({
      route: 'decisions',
      status: 'success',
      usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 },
    });
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), { tokens: 50 });
  });

  it('adds the rationale when include_rationale produced one', async () => {
    invoke.mockResolvedValue({
      ...CHAT_ANSWER,
      content: JSON.stringify({ rationale: 'late parcel, calm tone', ...JSON.parse(CHAT_ANSWER.content as string) }),
    });
    const response = await post({ ...BODY, options: { include_rationale: true } });
    expect(parseJsonBody<any>(response.body).rationale).toBe('late parcel, calm tone');
  });

  describe('guardrails run BEFORE the backend', () => {
    it('checks the input and every question instruction, in order, before the chat model is called', async () => {
      await post(BODY);

      const checked = mockFn(enforceModelGuardrailChain).mock.calls.map(([args]) => args.text);
      expect(checked).toEqual([
        'My email is jane@example.com and my parcel is late.',
        'Call me at 555-0100',
        'glad',
        'angry',
        'Is it time critical?',
        'minor',
        'major',
      ]);
      for (const [args] of mockFn(enforceModelGuardrailChain).mock.calls) {
        expect(args).toMatchObject({ guardrailKeys: ['pii-guard'], phase: 'input', projectId: 'proj-1' });
      }

      // The ordering assertion: every guardrail call precedes the backend call.
      const lastGuardrail = Math.max(...mockFn(enforceModelGuardrailChain).mock.invocationCallOrder);
      const firstBackend = Math.min(...invoke.mock.invocationCallOrder);
      expect(lastGuardrail).toBeLessThan(firstBackend);
    });

    it('sends only the redacted text to the backend', async () => {
      mockFn(enforceModelGuardrailChain).mockImplementation(async ({ text }: { text: string }) => ({
        redactedText: text.replace('jane@example.com', '[EMAIL]').replace('555-0100', '[PHONE]'),
        results: [],
      }));

      await post(BODY);

      const sent = JSON.stringify(invoke.mock.calls[0][0]);
      expect(sent).toContain('[EMAIL]');
      expect(sent).toContain('[PHONE]');
      expect(sent).not.toContain('jane@example.com');
      expect(sent).not.toContain('555-0100');
      // The schema descriptions carry the instructions too — also redacted.
      expect(JSON.stringify(invoke.mock.calls[0][1])).not.toContain('555-0100');
    });

    it('does not call the backend at all when a guardrail blocks', async () => {
      mockFn(enforceModelGuardrailChain).mockRejectedValue(new GuardrailBlockError('Input blocked by guardrail "pii-guard"', 'pii-guard', 'block', []));

      const response = await post(BODY);

      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error).toMatchObject({
        type: 'guardrail_block',
        guardrail_key: 'pii-guard',
      });
      expect(buildModelRuntime).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    });

    it('FAILS if the hook is skipped: a model with a bound guardrail must trigger it', async () => {
      await post(BODY);
      expect(enforceModelGuardrailChain).toHaveBeenCalled();
      expect(invoke).toHaveBeenCalled();
    });

    it('runs no guardrail when the model has none bound', async () => {
      mockFn(getModelByKey).mockResolvedValue(decisionModel({ inputGuardrailKey: undefined }));
      const response = await post(BODY);
      expect(response.statusCode).toBe(200);
      expect(enforceModelGuardrailChain).not.toHaveBeenCalled();
    });
  });

  describe('validation (400, naming the failing question)', () => {
    it('rejects an unknown question type', async () => {
      const response = await post({ ...BODY, questions: { ok: { type: 'boolean' }, weird: { type: 'rank' } } });
      expect(response.statusCode).toBe(400);
      const error = parseJsonBody<any>(response.body).error;
      expect(error.type).toBe('invalid_request_error');
      expect(error.question_id).toBe('weird');
      expect(error.message).toContain('"weird"');
      expect(invoke).not.toHaveBeenCalled();
      expect(enforceModelGuardrailChain).not.toHaveBeenCalled();
    });

    it('rejects a score question with one level', async () => {
      const response = await post({ ...BODY, questions: { s: { type: 'score', levels: ['x'] } } });
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.question_id).toBe('s');
    });

    it('rejects more than 64 questions', async () => {
      const questions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, { type: 'boolean' }]));
      expect((await post({ ...BODY, questions })).statusCode).toBe(400);
    });

    it('rejects stream: true', async () => {
      expect((await post({ ...BODY, stream: true })).statusCode).toBe(400);
    });

    it('rejects malformed JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/client/v1/decisions',
        headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('model checks', () => {
    it('rejects a model that is not a decision model', async () => {
      mockFn(getModelByKey).mockResolvedValue(decisionModel({ category: 'llm' }));
      const response = await post(BODY);
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.message).toMatch(/not configured for decisions/);
      expect(invoke).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown model', async () => {
      mockFn(getModelByKey).mockResolvedValue(null);
      expect((await post(BODY)).statusCode).toBe(404);
    });

    it('answers 400 for native mode on a provider without a native adapter', async () => {
      mockFn(getModelByKey).mockResolvedValue(decisionModel({ settings: { decision: { mode: 'native' } } }));
      const response = await post(BODY);
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.message).toBe('Native decision is not supported for provider openai');
      expect(invoke).not.toHaveBeenCalled();
    });

    it('answers 400 for an unknown decision mode', async () => {
      mockFn(getModelByKey).mockResolvedValue(decisionModel({ settings: { decision: { mode: 'magic' } } }));
      const response = await post(BODY);
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.message).toMatch(/Unknown decision mode/);
    });

    it('rejects images unless the model declares support, then accepts them', async () => {
      const withImage = { ...BODY, input: [{ type: 'text', text: 'see' }, { type: 'image', data_url: 'data:image/png;base64,AAAA' }] };
      const refused = await post(withImage);
      expect(refused.statusCode).toBe(400);
      expect(parseJsonBody<any>(refused.body).error.message).toMatch(/image support/);
      expect(invoke).not.toHaveBeenCalled();

      mockFn(getModelByKey).mockResolvedValue(decisionModel({ settings: { decision: { mode: 'structured', supports: { image: true } } } }));
      const accepted = await post(withImage);
      expect(accepted.statusCode).toBe(200);
      expect(JSON.stringify(invoke.mock.calls[0][0])).toContain('image_url');
    });

    it('an explicit supports.image:false beats isMultimodal', async () => {
      mockFn(getModelByKey).mockResolvedValue(decisionModel({ isMultimodal: true, settings: { decision: { supports: { image: false } } } }));
      const response = await post({ ...BODY, input: [{ type: 'image', data_url: 'data:image/png;base64,AAAA' }] });
      expect(response.statusCode).toBe(400);
    });

    it('answers a clear 400 for a provider family without a decision strategy', async () => {
      mockFn(getModelByKey).mockResolvedValue(decisionModel({ providerDriver: 'anthropic' }));
      mockFn(buildModelRuntime).mockResolvedValue({ runtime: { createChatModel: vi.fn() }, record: {} });
      const response = await post(BODY);
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.message).toBe(
        'Structured decision not yet supported for provider anthropic',
      );
    });
  });

  it('returns 502 on unparseable output WITHOUT retrying, and logs an error row', async () => {
    invoke.mockResolvedValue({ content: 'definitely not json' });
    const response = await post(BODY);
    expect(response.statusCode).toBe(502);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme', expect.anything(), expect.objectContaining({ status: 'error', route: 'decisions' }),
    ));
  });

  it('still retries a transient upstream error (503) and then succeeds', async () => {
    invoke
      .mockRejectedValueOnce(Object.assign(new Error('upstream unavailable'), { status: 503 }))
      .mockResolvedValue(CHAT_ANSWER);
    const response = await post(BODY);
    expect(response.statusCode).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('logs an error row for an upstream failure that exhausts retries', async () => {
    invoke.mockRejectedValue(Object.assign(new Error('upstream down'), { status: 503 }));
    const response = await post(BODY);
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(invoke).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme', expect.anything(), expect.objectContaining({ status: 'error' }),
    ));
  });

  it('does not write an error row for a guardrail block', async () => {
    mockFn(enforceModelGuardrailChain).mockRejectedValue(new GuardrailBlockError('blocked', 'pii-guard', 'block', []));
    await post(BODY);
    expect(logModelUsage).not.toHaveBeenCalled();
  });

  describe('guardrail coverage of choice descriptions and level labels', () => {
    it('blocks (before the backend) when a choice description trips the guardrail', async () => {
      mockFn(enforceModelGuardrailChain).mockImplementation(async ({ text }: { text: string }) => {
        if (text === 'angry') throw new GuardrailBlockError('blocked: angry', 'pii-guard', 'block', []);
        return { redactedText: undefined, results: [] };
      });
      const response = await post(BODY);
      expect(response.statusCode).toBe(400);
      expect(parseJsonBody<any>(response.body).error.type).toBe('guardrail_block');
      expect(invoke).not.toHaveBeenCalled();
    });

    it('blocks when a score level label trips the guardrail', async () => {
      mockFn(enforceModelGuardrailChain).mockImplementation(async ({ text }: { text: string }) => {
        if (text === 'major') throw new GuardrailBlockError('blocked: major', 'pii-guard', 'block', []);
        return { redactedText: undefined, results: [] };
      });
      expect((await post(BODY)).statusCode).toBe(400);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("throws the EARLIEST segment's block when several block", async () => {
      mockFn(enforceModelGuardrailChain).mockImplementation(async ({ text }: { text: string }) => {
        if (text === 'major') throw new GuardrailBlockError('late block', 'g2', 'block', []);
        if (text === 'glad') {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new GuardrailBlockError('early block', 'g1', 'block', []);
        }
        return { redactedText: undefined, results: [] };
      });
      const response = await post(BODY);
      expect(parseJsonBody<any>(response.body).error.message).toBe('early block');
    });

    it('sends redacted choice descriptions and level labels, leaving the keys alone', async () => {
      mockFn(enforceModelGuardrailChain).mockImplementation(async ({ text }: { text: string }) => ({
        redactedText: text === 'glad' ? '[R1]' : text === 'minor' ? '[R2]' : undefined,
        results: [],
      }));
      await post(BODY);
      const sent = JSON.stringify(invoke.mock.calls[0]);
      expect(sent).toContain('[R1]');
      expect(sent).toContain('[R2]');
      expect(sent).not.toContain('glad');
      expect(sent).toContain('happy');
    });

    it('skips blank segments', async () => {
      await post({ ...BODY, questions: { q: { type: 'choice', instructions: '   ', choices: { a: '', b: 'text' } } } });
      expect(mockFn(enforceModelGuardrailChain).mock.calls.map(([args]) => args.text)).toEqual([
        BODY.input,
        'text',
      ]);
    });
  });

  describe('mapSegmentsBounded', () => {
    it('never runs more than 4 at once and applies every result', async () => {
      let inFlight = 0;
      let peak = 0;
      const applied: string[] = [];
      const segments = Array.from({ length: 12 }, (_, i) => ({
        text: `t${i}`,
        apply: (next: string) => { applied[i] = next; },
      }));
      await mapSegmentsBounded(segments, async (text) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return text.toUpperCase();
      });
      expect(peak).toBe(4);
      expect(applied).toEqual(segments.map((s) => s.text.toUpperCase()));
    });

    it('stops starting new segments after a failure', async () => {
      const seen: string[] = [];
      const segments = Array.from({ length: 20 }, (_, i) => ({ text: `t${i}`, apply: () => {} }));
      await expect(mapSegmentsBounded(segments, async (text) => {
        seen.push(text);
        if (text === 't1') throw new Error('boom');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return text;
      })).rejects.toThrow('boom');
      expect(seen.length).toBeLessThan(20);
    });
  });

  it('returns 429 and never calls the model when a quota denies the request', async () => {
    const { checkBudget } = await import('@/lib/quota/quotaGuard');
    mockFn(checkBudget).mockResolvedValueOnce({ allowed: false, reason: 'Budget exceeded' });
    const response = await post(BODY);
    expect(response.statusCode).toBe(429);
    expect(invoke).not.toHaveBeenCalled();
    expect(enforceModelGuardrailChain).not.toHaveBeenCalled();
  });
});
