/**
 * `/client/v1/messages` route parity with the chat route.
 *
 * The translation itself is covered in unit tests; this pins the route-level
 * contract: the correlation id reaches the client the same two ways the chat
 * route offers it, a translation error is a Messages-dialect 400, and a
 * draining instance answers in the Messages envelope too.
 */
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
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn().mockReturnValue('models'),
  authorizeServiceRequest: vi.fn().mockReturnValue({ allowed: true }),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/models/inferenceService', () => {
  class GuardrailBlockError extends Error {
    guardrailKey = '';
    action = '';
    findings: unknown[] = [];
  }
  return { GuardrailBlockError, handleChatCompletion: vi.fn(), handleEmbeddingRequest: vi.fn() };
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
}));

import { isShuttingDown } from '@/lib/core/lifecycle';
import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
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

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('POST /api/client/v1/messages', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFn(isShuttingDown).mockReturnValue(false);
    mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
    mockFn(getDatabase).mockResolvedValue({
      runWithTenant: <T>(_db: string, operation: () => T) => operation(),
    });
    app = await createFastifyApiTestApp(clientInferenceApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/client/v1/messages',
    headers: { authorization: 'Bearer tok_abc' },
    payload,
  });

  const VALID = { model: 'test-model', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] };

  it('echoes the request id in the body and the request-id header on a buffered reply', async () => {
    mockFn(handleChatCompletion).mockResolvedValue({
      requestId: 'req-123',
      response: {
        id: 'chatcmpl-1',
        model: 'test-model',
        choices: [{ finish_reason: 'stop', message: { content: 'Hi there' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
      usage: { inputTokens: 3, outputTokens: 2 },
    });

    const res = await post(VALID);
    expect(res.statusCode).toBe(200);
    expect(res.headers['request-id']).toBe('req-123');
    const body = parseJsonBody<{ type: string; request_id: string; content: unknown[] }>(res.body);
    expect(body.type).toBe('message');
    expect(body.request_id).toBe('req-123');
    expect(body.content).toEqual([{ type: 'text', text: 'Hi there' }]);
    // The translated body asked upstream for nothing more than the chat route would.
    expect(mockFn(handleChatCompletion).mock.calls[0][0].body.stream_options).toBeUndefined();
  });

  it('answers a translation error as a Messages-dialect 400', async () => {
    const res = await post({ ...VALID, messages: [{ role: 'system', content: 'x' }] });
    expect(res.statusCode).toBe(400);
    const body = parseJsonBody<{ type: string; error: { type: string; message: string } }>(res.body);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/role/);
    expect(handleChatCompletion).not.toHaveBeenCalled();
  });

  it('answers in the Messages envelope while shutting down', async () => {
    mockFn(isShuttingDown).mockReturnValue(true);
    const res = await post(VALID);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    const body = parseJsonBody<{ type: string; error: { type: string } }>(res.body);
    expect(body).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'Service is shutting down' } });
  });
});
