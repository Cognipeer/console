/**
 * API route tests — /api/client/v1/chat/completions
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
  handleChatCompletion: vi.fn(),
  GuardrailBlockError: class GuardrailBlockError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GuardrailBlockError';
    }
  },
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
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
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
  user: { _id: 'user-1', email: 'alice@acme.com', name: 'Alice', role: 'owner' },
};

const MOCK_MODEL = {
  _id: 'model-1',
  key: 'gpt-4o',
  name: 'GPT-4o',
  modelId: 'gpt-4o',
  category: 'llm',
  providerKey: 'openai-provider',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
};

const MOCK_CHAT_RESPONSE = {
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function buildChatRequest(body: Record<string, unknown>, token = 'sk-test-token') {
  return new NextRequest('http://localhost/api/client/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/client/v1/chat/completions', () => {
  /// lazily import after mocks are registered
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const route = await import('@/server/api/routes/client/v1/chat/completions/route');
    POST = route.POST;
  });

  describe('authentication', () => {
    it('returns 401 when ApiTokenAuthError is thrown', async () => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiTokenAuthError('Invalid API token', 401),
      );

      const req = buildChatRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
      const res = await POST(req);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });
  });

  describe('request validation', () => {
    beforeEach(() => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKEN_CONTEXT);
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
    });

    it('returns 400 when model is missing', async () => {
      const req = buildChatRequest({ messages: [{ role: 'user', content: 'Hi' }] });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('returns 500 when handleChatCompletion throws because messages is missing', async () => {
      // The route delegates messages validation to the service, not at the route level.
      // When messages is omitted & the service throws, the route returns 500.
      (handleChatCompletion as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('messages is required'),
      );
      const req = buildChatRequest({ model: 'gpt-4o' });
      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });

  describe('successful non-streaming response', () => {
    beforeEach(() => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKEN_CONTEXT);
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
      (handleChatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
        response: MOCK_CHAT_RESPONSE,
        requestId: 'req-test-123',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    });

    it('returns 200 with OpenAI-compatible response body', async () => {
      const req = buildChatRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const res = await POST(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({
        id: expect.any(String),
        object: 'chat.completion',
        choices: expect.arrayContaining([
          expect.objectContaining({ message: expect.objectContaining({ role: 'assistant' }) }),
        ]),
      });
    });

    it('propagates client request_id in response', async () => {
      (handleChatCompletion as ReturnType<typeof vi.fn>).mockResolvedValue({
        response: { ...MOCK_CHAT_RESPONSE, id: 'my-custom-req-id' },
        requestId: 'my-custom-req-id',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      const req = buildChatRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        request_id: 'my-custom-req-id',
      });
      const res = await POST(req);
      const json = await res.json();
      // The route emits request_id from the service's requestId
      expect(json.request_id).toBe('my-custom-req-id');
    });
  });

  describe('service error propagation', () => {
    it('returns 500 when inference service throws an unexpected error', async () => {
      (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TOKEN_CONTEXT);
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODEL);
      (handleChatCompletion as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Model not found: nonexistent-model'),
      );

      const req = buildChatRequest({
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
    });
  });
});
