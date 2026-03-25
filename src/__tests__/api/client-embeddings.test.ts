import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: vi.fn(),
}));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn().mockReturnValue({ currency: 'USD', totalCost: 0.0001 }),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkBudget: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { POST } from '@/server/api/routes/client/v1/embeddings/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { checkPerRequestLimits, checkRateLimit, checkBudget } from '@/lib/quota/quotaGuard';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  token: 'tok_abc',
  tokenRecord: { _id: 'token-id-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
};

function makeReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/client/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_BODY = {
  model: 'text-embedding-3-small',
  input: 'Hello world',
};

const FAKE_EMBEDDING_RESULT = {
  response: {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 3, total_tokens: 3 },
  },
  latencyMs: 50,
  requestId: 'emb-req-1',
};

describe('POST /api/client/v1/embeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
    (checkPerRequestLimits as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it('returns 401 when auth fails with ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid API token', 401),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.type).toBe('invalid_request_error');
  });

  it('returns 401 on unexpected auth error', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('network error'),
    );

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost/api/client/v1/embeddings', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.type).toBe('invalid_request_error');
  });

  it('returns 400 when model is missing', async () => {
    const res = await POST(makeReq({ input: 'hello' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.message).toContain('model');
  });

  it('returns 400 when model is not a string', async () => {
    const res = await POST(makeReq({ model: 123, input: 'hello' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when input is a number (not string or array)', async () => {
    const res = await POST(makeReq({ model: 'text-embedding-3-small', input: 42 }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.message).toMatch(/input/i);
  });

  it('returns 400 when input array contains non-strings', async () => {
    const res = await POST(makeReq({ model: 'text-embedding-3-small', input: [1, 'valid'] }));
    expect(res.status).toBe(400);
  });

  it('returns 429 when per-request limit is exceeded', async () => {
    (checkPerRequestLimits as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Input token limit exceeded',
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.message).toBe('Input token limit exceeded');
  });

  it('returns 429 when rate limit is exceeded', async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Rate limit hit',
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.message).toBe('Rate limit hit');
  });

  it('returns 429 when budget exceeded', async () => {
    (checkBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Budget limit reached',
    });

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.message).toBe('Budget limit reached');
  });

  it('returns 200 with embedding response on success', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_EMBEDDING_RESULT);

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.object).toBe('list');
    expect(json.data).toHaveLength(1);
    expect(json.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('includes request_id in response', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_EMBEDDING_RESULT);

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(json.request_id).toBe('emb-req-1');
  });

  it('handles array input correctly', async () => {
    const multiResult = {
      ...FAKE_EMBEDDING_RESULT,
      response: {
        ...FAKE_EMBEDDING_RESULT.response,
        data: [
          { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
          { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
        ],
      },
    };
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue(multiResult);

    const res = await POST(makeReq({ model: 'text-embedding-3-small', input: ['foo', 'bar'] }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(2);
  });

  it('calls handleEmbeddingRequest with correct params', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue(FAKE_EMBEDDING_RESULT);

    await POST(makeReq({ ...VALID_BODY, request_id: 'cust-req-1' }));

    expect(handleEmbeddingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantDbName: 'tenant_acme',
        modelKey: 'text-embedding-3-small',
        projectId: 'proj-1',
      }),
    );
  });

  it('returns 500 on inference service error', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Model unavailable'),
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.message).toBe('Model unavailable');
  });
});
