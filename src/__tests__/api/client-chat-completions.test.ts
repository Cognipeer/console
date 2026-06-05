import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---- mocks ----
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireApiToken: vi.fn(),
    ApiTokenAuthError,
  };
});

vi.mock('@/lib/services/models/inferenceService', () => {
  class GuardrailBlockError extends Error {
    guardrailKey: string;
    action: string;
    findings: unknown[];
    constructor(message: string, guardrailKey: string, action: string, findings: unknown[]) {
      super(message);
      this.guardrailKey = guardrailKey;
      this.action = action;
      this.findings = findings;
    }
  }
  return {
    handleChatCompletion: vi.fn(),
    GuardrailBlockError,
  };
});

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn().mockReturnValue({ currency: 'USD', totalCost: 0.001 }),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkBudget: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { POST } from '@/server/api/routes/client/v1/chat/completions/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import * as inferenceServiceMod from '@/lib/services/models/inferenceService';
// GuardrailBlockError is not in the real module types but IS in the mock
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { GuardrailBlockError } = inferenceServiceMod as any;
import { checkPerRequestLimits, checkRateLimit, checkBudget } from '@/lib/quota/quotaGuard';
import { getModelByKey } from '@/lib/services/models/modelService';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  token: 'tok_abc',
  tokenRecord: { _id: 'token-id-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
};

function makeReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/client/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_BODY = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
};

describe('POST /api/client/v1/chat/completions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
    (checkPerRequestLimits as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    // Fire-and-forget budget update calls getModelByKey - must return a promise
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it('returns 401 when auth fails with ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid API token', 401),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.message).toBe('Invalid API token');
  });

  it('returns 401 when auth fails with unexpected error', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/chat/completions', {
      method: 'POST',
      body: 'not json {{',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.type).toBe('invalid_request_error');
  });

  it('returns 400 when model field is missing', async () => {
    const res = await POST(makeReq({ messages: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.message).toContain('model');
  });

  it('returns 400 when model is not a string', async () => {
    const res = await POST(makeReq({ model: 42, messages: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
  });

  it('returns 429 when per-request limit is exceeded', async () => {
    (checkPerRequestLimits as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Token limit exceeded',
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.message).toBe('Token limit exceeded');
  });

  it('returns 429 when rate limit is exceeded', async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Too many requests',
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.message).toBe('Too many requests');
  });

  it('returns 429 when budget is exceeded', async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Monthly budget limit reached',
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.message).toBe('Monthly budget limit reached');
  });

  it('returns 500 when quota check itself throws', async () => {
    (checkPerRequestLimits as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('quota service down'),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.type).toBe('server_error');
  });

  it('returns 200 with response for successful non-streaming completion', async () => {
    const fakeResult = {
      response: { id: 'chatcmpl-1', choices: [{ message: { content: 'Hello!' } }] },
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      latencyMs: 100,
      requestId: 'req-abc',
      cacheHit: false,
    };
    (handleChatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(fakeResult);

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id).toBe('chatcmpl-1');
    expect(json.request_id).toBe('req-abc');
  });

  it('injects request_id into non-streaming response', async () => {
    (handleChatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { id: 'chatcmpl-2' },
      usage: {},
      latencyMs: 50,
      requestId: 'my-request-id',
      cacheHit: false,
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(json.request_id).toBe('my-request-id');
  });

  it('returns streaming response with SSE headers', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"id":"chunk-1"}\n\n'));
        c.close();
      },
    });
    (handleChatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      stream,
      requestId: 'stream-req-1',
    });

    const res = await POST(makeReq({ ...VALID_BODY, stream: true }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(res.headers.get('X-Request-Id')).toBe('stream-req-1');
  });

  it('returns 400 on GuardrailBlockError with guardrail details', async () => {
    (handleChatCompletion as ReturnType<typeof vi.fn>).mockRejectedValue(
      new GuardrailBlockError('Content blocked by guardrail', 'pii-guard', 'block', [{ type: 'pii' }]),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.type).toBe('guardrail_block');
    expect(json.error.guardrail_key).toBe('pii-guard');
    expect(json.error.action).toBe('block');
    expect(json.error.findings).toHaveLength(1);
  });

  it('returns 500 on inference service error', async () => {
    (handleChatCompletion as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Model not available'),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.message).toBe('Model not available');
    expect(json.error.type).toBe('server_error');
  });

  it('calls handleChatCompletion with correct parameters', async () => {
    (handleChatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { id: 'r1' },
      usage: {},
      latencyMs: 10,
      requestId: 'req-1',
    });

    await POST(makeReq({ ...VALID_BODY, stream: false }));

    expect(handleChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantDbName: 'tenant_acme',
        tenantId: 'tenant-1',
        modelKey: 'gpt-4o',
        projectId: 'proj-1',
        stream: false,
      }),
    );
  });
});
