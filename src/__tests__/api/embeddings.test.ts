/**
 * API route tests — /api/client/v1/embeddings
 *
 * Tests the HTTP surface without touching real external services.
 * All dependencies (auth, inference, quota) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/services/apiTokenAuth', () => ({
  requireApiToken: vi.fn(),
  ApiTokenAuthError: class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  },
}));

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: vi.fn(),
}));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn().mockReturnValue(0),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/quota/quotaGuard', () => {
  const pass = { allowed: true, effectiveLimits: { quotas: {}, perRequest: {} } };
  return {
    checkBudget: vi.fn().mockResolvedValue(pass),
    checkPerRequestLimits: vi.fn().mockResolvedValue(pass),
    checkRateLimit: vi.fn().mockResolvedValue(pass),
  };
});

import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_TOKEN_CONTEXT = {
  token: 'sk-test-token',
  tokenRecord: { _id: 'tok-1', tenantId: 'tenant-1', userId: 'user-1', projectId: 'proj-1', token: 'sk-test-token', name: 'Test' },
  tenant: { _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'FREE', companyName: 'Acme' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: null,
};

const MOCK_EMBEDDING_MODEL = {
  _id: 'model-emb-1',
  key: 'text-embedding-3-small',
  name: 'text-embedding-3-small',
  modelId: 'text-embedding-3-small',
  category: 'embedding',
  providerKey: 'openai-provider',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
};

const MOCK_EMBEDDING_RESPONSE = {
  object: 'list',
  data: [
    {
      object: 'embedding',
      index: 0,
      embedding: Array.from({ length: 1536 }, (_, i) => i * 0.001),
    },
  ],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 5, total_tokens: 5 },
};

function buildEmbeddingRequest(
  body: Record<string, unknown>,
  token = 'sk-test-token',
) {
  return new NextRequest('http://localhost/api/client/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/client/v1/embeddings', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const route = await import('@/server/api/routes/client/v1/embeddings/route');
    POST = route.POST;
  });

  describe('authentication', () => {
    it('returns 401 when authorization header is missing', async () => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiTokenAuthError('Missing authorization', 401),
      );

      const req = buildEmbeddingRequest({ model: 'text-embedding-3-small', input: 'Hello' });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });
  });

  describe('request validation', () => {
    beforeEach(() => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKEN_CONTEXT);
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_EMBEDDING_MODEL);
    });

    it('returns 400 when model is missing', async () => {
      const req = buildEmbeddingRequest({ input: 'Hello world' });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('returns 400 when input has invalid type (object instead of string)', async () => {
      // The route only validates input type if it is present with a wrong format,
      // not if it is missing (missing input is passed through to the service).
      const req = buildEmbeddingRequest({ model: 'text-embedding-3-small', input: 123 });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe('successful response', () => {
    beforeEach(() => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKEN_CONTEXT);
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_EMBEDDING_MODEL);
      (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        response: MOCK_EMBEDDING_RESPONSE,
        requestId: 'emb-req-test-123',
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
      });
    });

    it('returns 200 with OpenAI-compatible response', async () => {
      const req = buildEmbeddingRequest({
        model: 'text-embedding-3-small',
        input: 'Hello world',
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({
        object: 'list',
        data: expect.arrayContaining([
          expect.objectContaining({
            object: 'embedding',
            embedding: expect.any(Array),
          }),
        ]),
      });
    });

    it('accepts array input', async () => {
      const req = buildEmbeddingRequest({
        model: 'text-embedding-3-small',
        input: ['sentence one', 'sentence two'],
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
    });

    it('embedding vector contains numbers', async () => {
      const req = buildEmbeddingRequest({
        model: 'text-embedding-3-small',
        input: 'test input',
      });
      const res = await POST(req);
      const json = await res.json();
      const embedding: number[] = json.data[0].embedding;
      expect(Array.isArray(embedding)).toBe(true);
      embedding.forEach((v) => expect(typeof v).toBe('number'));
    });
  });

  describe('service error propagation', () => {
    it('returns 500 when embedding service throws an unexpected error', async () => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKEN_CONTEXT);
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Model not found: nonexistent-embedding-model'),
      );

      const req = buildEmbeddingRequest({
        model: 'nonexistent-embedding-model',
        input: 'test',
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });
});
