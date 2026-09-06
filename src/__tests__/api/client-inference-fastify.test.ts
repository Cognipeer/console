import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }

  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/services/models/inferenceService', () => {
  class GuardrailBlockError extends Error {
    guardrailKey = '';
    action = '';
    findings: unknown[] = [];
  }

  return {
    GuardrailBlockError,
    handleChatCompletion: vi.fn(),
    handleEmbeddingRequest: vi.fn(),
  };
});

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: vi.fn().mockReturnValue({ currency: 'USD', totalCost: 0 }),
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
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { settleUsageBudget } from '@/lib/quota/quotaGuard';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
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

describe('Fastify client inference errors', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({
      runWithTenant: <T>(_tenantDbName: string, operation: () => T) => operation(),
    });
    mockFn(getPermissionServiceForPath).mockReturnValue('models');
    mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });
    app = await createFastifyApiTestApp(clientInferenceApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  async function postChat() {
    return app.inject({
      method: 'POST',
      url: '/api/client/v1/chat/completions',
      headers: { authorization: 'Bearer tok_abc' },
      payload: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });
  }

  it('returns a structured 422 for output token exhaustion', async () => {
    mockFn(handleChatCompletion).mockRejectedValue(new OutputTokenLimitError(512));

    const response = await postChat();
    const body = parseJsonBody<{ error: Record<string, unknown> }>(response.body);

    expect(response.statusCode).toBe(422);
    expect(body.error).toMatchObject({
      type: 'output_token_limit_exceeded',
      code: 'output_token_limit_exceeded',
      param: 'max_completion_tokens',
    });
  });

  it('returns a structured 404 for a missing model', async () => {
    mockFn(handleChatCompletion).mockRejectedValue(new Error('Model not found: test-model'));

    const response = await postChat();
    const body = parseJsonBody<{ error: Record<string, unknown> }>(response.body);

    expect(response.statusCode).toBe(404);
    expect(body.error).toMatchObject({
      type: 'not_found_error',
      code: 'model_not_found',
      param: 'model',
    });
  });

  it('keeps unexpected failures as structured 500 errors', async () => {
    mockFn(handleChatCompletion).mockRejectedValue(new Error('Unexpected provider response'));

    const response = await postChat();
    const body = parseJsonBody<{ error: Record<string, unknown> }>(response.body);

    expect(response.statusCode).toBe(500);
    expect(body.error).toMatchObject({
      message: 'Unexpected provider response',
      type: 'server_error',
      code: 'inference_error',
    });
  });

  it('returns a structured 400 for malformed multimodal content', async () => {
    mockFn(handleChatCompletion).mockRejectedValue(
      new Error('`messages[0].content[1].image_url` must be a non-empty string or an object with a non-empty `url` string'),
    );

    const response = await postChat();
    const body = parseJsonBody<{ error: Record<string, unknown> }>(response.body);

    expect(response.statusCode).toBe(400);
    expect(body.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'invalid_request',
    });
    expect(body.error.message).toContain('messages[0].content[1].image_url');
  });
});

describe('Fastify client inference — streaming budget settlement (F-05)', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({
      runWithTenant: <T>(_tenantDbName: string, operation: () => T) => operation(),
    });
    mockFn(getPermissionServiceForPath).mockReturnValue('models');
    mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });
    app = await createFastifyApiTestApp(clientInferenceApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  // Regression for the F-05 finding (2026-09-05 assessment): a streamed
  // chat completion's real usage is only known long after this route has
  // already returned the (still-open) stream to the caller, so the OLD
  // post-hoc `if (result.usage) { ...checkBudget... }` block here never ran
  // for it — the budget counter never debited a single streamed request,
  // no matter how much it cost. `handleChatCompletion` is mocked here (its
  // own streaming/cost logic is covered directly in inference-service.test.ts),
  // so this test stands for the route's wiring alone: does it pass a working
  // `onUsageSettled` through, and does calling it actually reach the budget
  // counter for BOTH stream and non-stream calls.
  it('settles the budget from a streamed completion, not only a non-streaming one', async () => {
    mockFn(handleChatCompletion).mockImplementation(async (params: {
      onUsageSettled?: (cost: { currency: string; totalCost: number }) => void;
    }) => {
      params.onUsageSettled?.({ currency: 'USD', totalCost: 0.42 });
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        requestId: 'stream-req-1',
      };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/client/v1/chat/completions',
      headers: { authorization: 'Bearer tok_abc' },
      payload: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(settleUsageBudget).toHaveBeenCalledTimes(1);
    expect(settleUsageBudget).toHaveBeenCalledWith(
      expect.objectContaining({ resourceKey: 'test-model' }),
      { currency: 'USD', totalCost: 0.42 },
    );
  });

  it('still settles the budget for a non-streaming completion', async () => {
    mockFn(handleChatCompletion).mockImplementation(async (params: {
      onUsageSettled?: (cost: { currency: string; totalCost: number }) => void;
    }) => {
      params.onUsageSettled?.({ currency: 'USD', totalCost: 0.07 });
      return {
        response: { id: 'chatcmpl-1', choices: [] },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: 'req-1',
      };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/client/v1/chat/completions',
      headers: { authorization: 'Bearer tok_abc' },
      payload: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(settleUsageBudget).toHaveBeenCalledWith(
      expect.objectContaining({ resourceKey: 'test-model' }),
      { currency: 'USD', totalCost: 0.07 },
    );
  });

  it('does not settle the budget when the call produced no billable usage', async () => {
    mockFn(handleChatCompletion).mockResolvedValue({
      response: { id: 'chatcmpl-2', choices: [] },
      usage: {},
      requestId: 'req-2',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/client/v1/chat/completions',
      headers: { authorization: 'Bearer tok_abc' },
      payload: {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(settleUsageBudget).not.toHaveBeenCalled();
  });
});
