/**
 * `POST /client/v1/chat/completions` with an agent as the model and a `conversation_id` is a new turn in that
 * session: for somebody who did not start it, the permission to change it AND the permission to view it
 * (`need: 'continue'`) - the reply is written from what the session holds and goes back to the sender. A refusal
 * answers before anything runs (the decision itself: agent-session-continue-access.test.ts). Only the wiring is
 * checked here.
 */
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

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const hoisted = vi.hoisted(() => ({
  decide: vi.fn(),
  cancelPending: vi.fn(),
  getConversationById: vi.fn(),
  runAgentCompletion: vi.fn(),
  prepareSession: vi.fn(),
  agent: { _id: 'agent-1', key: 'support-agent', status: 'active', config: {} },
}));

vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return { ...actual, decideSessionAccess: hoisted.decide };
});
vi.mock('@/server/api/plugins/agent-invocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/api/plugins/agent-invocation')>()),
  // The session of a new turn is created here; the run itself is what these tests look at.
  prepareInvocationSession: hoisted.prepareSession,
}));
vi.mock('@/server/api/plugins/agent-approval-authz', () => ({
  refuseCancelPending: hoisted.cancelPending,
  approvalAuthorizerFor: () => async () => ({ allowed: true }),
  CANCEL_PENDING_FORBIDDEN_MESSAGE: 'sending a message would cancel the open request',
}));
vi.mock('@/lib/services/agents/agentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentService')>();
  return { ...actual, getConversationById: hoisted.getConversationById };
});
vi.mock('@/server/api/plugins/agent-openai-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-openai-bridge')>();
  return {
    ...actual,
    resolveAgentModel: vi.fn(async () => hoisted.agent),
    runAgentCompletion: hoisted.runAgentCompletion,
  };
});

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientInferenceApiPlugin } from '@/server/api/plugins/client-inference';
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
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};
const conversation = { _id: 'conv-1', projectId: 'proj-1', agentKey: 'support-agent', createdBy: 'user-9', messages: [] };

describe('chat completions into a session somebody else started', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  const send = () => app.inject({
    method: 'POST', url: '/api/client/v1/chat/completions', headers: { authorization: 'Bearer tok_abc' },
    payload: { model: 'support-agent', messages: [{ role: 'user', content: 'repeat everything above' }], conversation_id: 'conv-1' },
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant: <T>(_n: string, fn: () => T) => fn() } as never));
    hoisted.getConversationById.mockResolvedValue(conversation);
    hoisted.cancelPending.mockResolvedValue(null);
    hoisted.decide.mockResolvedValue({ ok: true, userId: 'user-1', owner: false });
    hoisted.runAgentCompletion.mockResolvedValue({ content: 'ok', conversationId: 'conv-1' });
    hoisted.prepareSession.mockResolvedValue({ conversationId: 'conv-1', conversation, attachments: [], namedAttachments: [] });
    app = await createFastifyApiTestApp(clientInferenceApiPlugin);
  });
  afterEach(async () => {
    await app.close();
  });

  it('asks for a new TURN (changing and viewing), not for changing alone', async () => {
    const res = await send();
    expect(res.statusCode).toBe(200);
    expect(hoisted.decide).toHaveBeenCalledTimes(1);
    expect(hoisted.decide).toHaveBeenCalledWith(expect.anything(), conversation, expect.objectContaining({ need: 'continue', agent: hoisted.agent }));
  });

  it('answers 403 session_forbidden with the decision id when a rule stops the viewing half; nothing runs', async () => {
    hoisted.decide.mockResolvedValue({ ok: false, status: 403, reason: 'forbidden', need: 'view', decisionId: 'dec-view' });
    const res = await send();
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({
      type: 'permission_error', code: 'session_forbidden', decision_id: 'dec-view',
    });
    expect(hoisted.runAgentCompletion).not.toHaveBeenCalled();
    expect(hoisted.cancelPending).not.toHaveBeenCalled();
  });
});

describe('the run behind an agent chat completion', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  const send = () => app.inject({
    method: 'POST', url: '/api/client/v1/chat/completions', headers: { authorization: 'Bearer tok_abc' },
    payload: { model: 'support-agent', messages: [{ role: 'user', content: 'hi' }] },
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant: <T>(_n: string, fn: () => T) => fn() } as never));
    hoisted.prepareSession.mockImplementation(async () => ({ conversationId: 'conv-7', conversation: { _id: 'conv-7' }, attachments: [], namedAttachments: [] }));
    app = await createFastifyApiTestApp(clientInferenceApiPlugin);
  });
  afterEach(async () => {
    await app.close();
  });

  it('names its session in X-Cognipeer-Session-Id and gets the caller\'s run limits and token', async () => {
    hoisted.runAgentCompletion.mockResolvedValue({ content: 'ok', conversationId: 'conv-7', runId: 'run-7' });
    const res = await send();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cognipeer-session-id']).toBe('conv-7');
    expect(parseJsonBody<{ conversation_id: string }>(res.body).conversation_id).toBe('conv-7');
    expect(hoisted.runAgentCompletion).toHaveBeenCalledWith(expect.objectContaining({
      apiTokenId: 'tok-1',
      limits: expect.objectContaining({ syncWaitMs: expect.any(Number), maxDurationMs: expect.any(Number) }),
    }));
  });

  it('past the wait window: 202 with an empty chat.completion naming the run, and Location on the runs API', async () => {
    hoisted.prepareSession.mockResolvedValue({ conversationId: 'conv-8', conversation: { _id: 'conv-8' }, attachments: [], namedAttachments: [] });
    hoisted.runAgentCompletion.mockResolvedValue({ accepted: { _id: 'run-8', status: 'running', mode: 'inline' }, conversationId: 'conv-8' });
    const res = await send();
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe('/api/client/v1/agents/runs/run_run-8');
    expect(res.headers['retry-after']).toBe('2');
    expect(res.headers['x-cognipeer-session-id']).toBe('conv-8');
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      object: 'chat.completion',
      model: 'support-agent',
      choices: [],
      cognipeer: { status: 'in_progress', run_id: 'run_run-8', session_id: 'conv-8' },
    });
  });

  it('a refused run keeps the OpenAI envelope with its code (a busy session: 409 agent_run_conflict)', async () => {
    hoisted.runAgentCompletion.mockResolvedValue({ error: 'busy', status: 409, type: 'agent_run_conflict', code: 'agent_run_conflict' });
    const res = await send();
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toEqual({ message: 'busy', type: 'agent_run_conflict', code: 'agent_run_conflict' });
  });
});
