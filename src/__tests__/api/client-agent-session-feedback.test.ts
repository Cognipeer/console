import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }

  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const hoisted = vi.hoisted(() => {
  class FeedbackError extends Error {
    status: number;
    code: string;

    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { getConversationById: vi.fn(), recordMessageFeedback: vi.fn(), FeedbackError };
});

vi.mock('@/lib/services/agents', () => ({ getConversationById: hoisted.getConversationById }));
// Who may touch a session is decided (and tested) in agent-session-access; here it only finds the conversation in the token's project.
vi.mock('@/server/api/plugins/agent-session-access', () => ({
  loadSessionForPrincipal: async (_request: unknown, conversationId: string, options: { projectId?: string }) => {
    const found = await hoisted.getConversationById('tenant_acme', conversationId);
    return found && found.projectId === options.projectId
      ? { ok: true, conversation: found, userId: 'user-1', owner: found.createdBy === 'user-1' }
      : { ok: false, status: 404, reason: 'not_found' };
  },
  sendClientSessionRefusal: (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, _request: unknown, refusal: { status: number; reason: string }) =>
    reply.code(refusal.status).send({ error: { type: 'not_found_error', message: 'Session not found', code: 'session_not_found' } }),
  sendAuthorizationUnavailable: () => undefined,
  sendClientListUnavailable: () => undefined,
  sessionListScope: async () => ({ all: true }),
  sessionStreamStillAllowed: async () => true,
  decideSessionAccess: async () => ({ ok: true, userId: 'user-1', owner: true }),
}));
vi.mock('@/lib/services/agents/agentFeedback', () => ({
  recordMessageFeedback: hoisted.recordMessageFeedback,
  FeedbackError: hoisted.FeedbackError,
}));
vi.mock('@/lib/services/agents/agentRunService', () => ({
  apiErrorBody: (type: string, message: string, code = type) => ({ error: { type, message, code } }),
  runWithTenantDb: (_name: string, fn: (db: unknown) => unknown) => fn({}),
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1', email: 'ada@example.com' },
};

const runWithTenant = vi.fn(<T>(_tenantDbName: string, fn: () => T | Promise<T>) => fn());
const conversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', messages: [], createdBy: 'user-1', ...overrides,
});
const URL = '/api/client/v1/agents/sessions/conv-1/messages/msg_abc/feedback';
const headers = { authorization: 'Bearer tok_abc', 'content-type': 'application/json' };
const stored = (over: Record<string, unknown> = {}) => ({
  rating: 'down', reasons: ['inaccurate'], comment: 'Wrong date', createdAt: new Date('2026-10-12T10:00:00Z'), updatedAt: new Date('2026-10-12T10:00:00Z'), ...over,
});

describe('PUT/DELETE /client/v1/agents/sessions/:id/messages/:messageId/feedback', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
    hoisted.getConversationById.mockResolvedValue(conversation());
    app = await createFastifyApiTestApp(clientAgentSessionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('records the rating of the person the session belongs to, from the API channel, comments allowed', async () => {
    hoisted.recordMessageFeedback.mockResolvedValue({ feedback: stored(), withdrawn: false, created: true, messageId: 'msg_abc', messageIndex: 1 });
    const res = await app.inject({ method: 'PUT', url: URL, headers, payload: { rating: 'down', reasons: ['inaccurate'], comment: 'Wrong date' } });

    expect(res.statusCode).toBe(201);
    expect(parseJsonBody(res.body)).toEqual({
      object: 'agent.message.feedback', session_id: 'conv-1', message_id: 'msg_abc',
      rating: 'down', reasons: ['inaccurate'], comment: 'Wrong date',
      created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z',
    });
    expect(hoisted.recordMessageFeedback).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', conversationId: 'conv-1',
      message: { id: 'msg_abc' }, userId: 'user-1', email: 'ada@example.com', channel: 'api',
      rating: 'down', reasons: ['inaccurate'], comment: 'Wrong date',
    }));
    // a surface that turned comments off says so; the API does not
    expect(hoisted.recordMessageFeedback.mock.calls[0]![0].commentsAllowed).not.toBe(false);
  });

  it('rating again replaces the rating (200, not 201)', async () => {
    hoisted.recordMessageFeedback.mockResolvedValue({ feedback: stored({ rating: 'up', reasons: [], comment: undefined }), withdrawn: false, created: false, messageId: 'msg_abc', messageIndex: 1 });
    const res = await app.inject({ method: 'PUT', url: URL, headers, payload: { rating: 'up' } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ rating: 'up', comment: null });
  });

  it('refuses a rating that is not "up" or "down" before anything is stored', async () => {
    for (const payload of [{}, { rating: 'meh' }, { rating: null }]) {
      const res = await app.inject({ method: 'PUT', url: URL, headers, payload });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_rating');
    }
    expect(hoisted.recordMessageFeedback).not.toHaveBeenCalled();
  });

  it('only the person who started the session may rate its answers', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({ createdBy: 'someone-else' }));
    const res = await app.inject({ method: 'PUT', url: URL, headers, payload: { rating: 'up' } });
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('not_session_owner');
    expect(hoisted.recordMessageFeedback).not.toHaveBeenCalled();
  });

  it('answers 404 for a session of another project', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({ projectId: 'proj-2' }));
    const res = await app.inject({ method: 'PUT', url: URL, headers, payload: { rating: 'up' } });
    expect(res.statusCode).toBe(404);
    expect(hoisted.recordMessageFeedback).not.toHaveBeenCalled();
  });

  it('passes the service\'s refusals through with their status and code', async () => {
    hoisted.recordMessageFeedback.mockRejectedValueOnce(new hoisted.FeedbackError(404, 'message_not_found', 'That message is not in this session.'));
    const missing = await app.inject({ method: 'PUT', url: URL, headers, payload: { rating: 'up' } });
    expect(missing.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { type: string; code: string } }>(missing.body).error).toMatchObject({ type: 'not_found_error', code: 'message_not_found' });

    hoisted.recordMessageFeedback.mockRejectedValueOnce(new hoisted.FeedbackError(400, 'not_an_answer', 'Only an answer can be rated.'));
    const notAnswer = await app.inject({ method: 'PUT', url: URL, headers, payload: { rating: 'up' } });
    expect(notAnswer.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(notAnswer.body).error.code).toBe('not_an_answer');
  });

  it('DELETE withdraws the rating', async () => {
    hoisted.recordMessageFeedback.mockResolvedValue({ feedback: null, withdrawn: true, created: false, messageId: 'msg_abc', messageIndex: 1 });
    const res = await app.inject({ method: 'DELETE', url: URL, headers: { authorization: headers.authorization } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody(res.body)).toEqual({ object: 'agent.message.feedback', session_id: 'conv-1', message_id: 'msg_abc', deleted: true });
    expect(hoisted.recordMessageFeedback).toHaveBeenCalledWith(expect.objectContaining({ rating: null, channel: 'api', userId: 'user-1' }));
  });
});
