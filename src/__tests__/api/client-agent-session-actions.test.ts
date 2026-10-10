/**
 * `POST /client/v1/agents/sessions/:conversationId/actions/:actionId` — the
 * client API's way to answer a pending approval / question — and the 409 a
 * Responses call gets for a session that is waiting on one. The resolution
 * service is covered end to end in `integration/agent-human-in-the-loop.test.ts`.
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

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  // The gate reads the caller (and the engine its policies) through the tenant scope.
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const hoisted = vi.hoisted(() => ({
  getConversationById: vi.fn(),
  getAgentByKey: vi.fn(),
  resolve: vi.fn(),
  blocking: vi.fn(),
  limits: vi.fn(),
  runSyncAgentTurn: vi.fn(),
}));

vi.mock('@/lib/services/agents', () => ({
  getConversationById: hoisted.getConversationById,
  getAgentByKey: hoisted.getAgentByKey,
  createAgentRecord: vi.fn(),
  createConversation: vi.fn(),
  deleteAgentRecord: vi.fn(),
  listAgents: vi.fn(),
  updateAgentRecord: vi.fn(),
  runSyncAgentTurn: hoisted.runSyncAgentTurn,
  createBackgroundAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  isBackgroundModeRequested: (header: string | null | undefined, body: Record<string, unknown> | undefined) =>
    header === 'true' || body?.background === true,
  agentRunConflictErrorBody: () => ({ error: 'conflict' }),
  agentSyncTimeoutErrorBody: () => ({ error: 'timeout' }),
  idempotencyKeyRequiresBackgroundErrorBody: () => ({ error: 'idem' }),
  idempotencyKeyConflictErrorBody: () => ({ error: 'idem' }),
  agentRunConcurrencyLimitErrorBody: () => ({ error: 'cap' }),
}));

vi.mock('@/lib/services/agents/agentRunService', () => ({
  apiErrorBody: (type: string, message: string, code = type, extra?: Record<string, unknown>) => ({ error: { type, message, code, ...extra } }),
  runWithTenantDb: vi.fn(),
  backgroundDisabledErrorBody: () => ({ error: { type: 'invalid_request_error', code: 'background_disabled' } }),
  isBackgroundModeRequested: (header: string | null | undefined, body: Record<string, unknown> | undefined) =>
    header === 'true' || body?.background === true,
  resolveAgentExecutionLimits: hoisted.limits,
  serializeAgentRun: (run: { _id: string; status: string }) => ({ id: `run_${run._id}`, object: 'agent.run', status: run.status }),
  MAX_IDEMPOTENCY_KEY_LENGTH: 255,
  agentDefaultCallback: () => ({}),
  lookupIdempotentAgentRun: vi.fn(),
  validateCallbackRequest: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentActionResolution', () => ({
  resolveAgentPendingAction: hoisted.resolve,
  pendingActionsBlockingMessage: hoisted.blocking,
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
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
  user: { _id: 'user-1', role: 'admin', email: 'a@b.c', tenantId: 'tenant-1' },
};
const conversation = { _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', messages: [], createdBy: 'user-1' };
const headers = { authorization: 'Bearer tok_abc' };
const URL = '/api/client/v1/agents/sessions/conv-1/actions/act_1';

const runWithTenant = vi.fn(<T>(_n: string, fn: () => T | Promise<T>) => fn());

describe('client: answering a pending action', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
    hoisted.getConversationById.mockResolvedValue(conversation);
    hoisted.getAgentByKey.mockResolvedValue({ key: 'support-agent', status: 'active', config: { modelKey: 'm' } });
    hoisted.limits.mockResolvedValue({ syncTimeoutMs: 60_000, backgroundEnabled: true, defaultMode: 'sync' });
    hoisted.blocking.mockResolvedValue(null);
    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(clientAgentSessionsApiPlugin);
      await instance.register(clientAgentsApiPlugin);
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('continues the turn inline and answers in the Responses shape (without the transcript)', async () => {
    hoisted.resolve.mockResolvedValue({
      kind: 'resumed', stopReason: 'end_turn', result: {},
      response: { id: 'resp_conv-1', object: 'response', status: 'completed', output: [], _conversation_messages: [{ role: 'user' }] },
    });
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { decision: 'allow', comment: 'ok' } });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<Record<string, unknown>>(res.body);
    expect(body).toMatchObject({ object: 'response', status: 'completed' });
    expect(body._conversation_messages).toBeUndefined();
    expect(hoisted.resolve).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', conversationId: 'conv-1', actionId: 'act_1',
      mode: 'sync', body: { decision: 'allow', comment: 'ok' },
      actor: expect.objectContaining({ userId: 'user-1', isAdmin: true, channel: 'api', apiTokenId: 'tok-1' }),
      // The same ceiling as a synchronous /responses call.
      cancellationCell: expect.objectContaining({ cancelled: false, deadlineAt: expect.any(Number) }),
    }));
  });

  it('background: true queues the continuation and answers 202 with the run', async () => {
    hoisted.resolve.mockResolvedValue({ kind: 'queued', run: { _id: 'r1', status: 'queued' } });
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { decision: 'allow', background: true } });
    expect(res.statusCode).toBe(202);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ id: 'run_r1', object: 'agent.run', status: 'queued' });
    expect(hoisted.resolve.mock.calls[0][0].mode).toBe('background');
    expect(hoisted.resolve.mock.calls[0][0].cancellationCell).toBeUndefined();
  });

  it('background is refused when the agent switched background execution off', async () => {
    hoisted.limits.mockResolvedValue({ syncTimeoutMs: 60_000, backgroundEnabled: false, defaultMode: 'sync' });
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { decision: 'allow', background: true } });
    expect(res.statusCode).toBe(400);
    expect(hoisted.resolve).not.toHaveBeenCalled();
  });

  it('while other requests of the pause are open, answers requires_action with them', async () => {
    hoisted.resolve.mockResolvedValue({ kind: 'pending', pendingActions: [{ id: 'act_2', kind: 'user_question', status: 'pending', requestedAt: 'x' }] });
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { decision: 'allow' } });
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      object: 'response', status: 'requires_action', stop_reason: 'requires_action',
      required_action: { type: 'agent_actions', actions: [{ id: 'act_2' }] },
    });
  });

  it.each([
    [{ kind: 'not_found' }, 404, 'action_not_found'],
    [{ kind: 'not_pending', status: 'resolved' }, 409, 'action_not_pending'],
    [{ kind: 'expired' }, 410, 'action_expired'],
    [{ kind: 'forbidden', message: 'no' }, 403, 'action_forbidden'],
    [{ kind: 'invalid', message: 'bad' }, 400, 'invalid_resolution'],
    [{ kind: 'busy' }, 409, 'agent_run_conflict'],
  ])('answers %j with %i in the client envelope', async (outcome, status, code) => {
    hoisted.resolve.mockResolvedValue(outcome);
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { decision: 'allow' } });
    expect(res.statusCode).toBe(status);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe(code);
  });

  it('404s a session in another project without calling the service', async () => {
    hoisted.getConversationById.mockResolvedValue({ ...conversation, projectId: 'proj-2' });
    const res = await app.inject({ method: 'POST', url: URL, headers, payload: { decision: 'allow' } });
    expect(res.statusCode).toBe(404);
    expect(hoisted.resolve).not.toHaveBeenCalled();
  });

  it('a Responses call for a session that waits on a request is 409 pending_action', async () => {
    hoisted.blocking.mockResolvedValue(['act_1']);
    const res = await app.inject({
      method: 'POST', url: '/api/client/v1/agents/responses', headers,
      payload: { model: 'support-agent', input: 'hello?', previous_response_id: 'resp_conv-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({
      type: 'pending_action', pendingActionIds: ['act_1'],
    });
    expect(hoisted.runSyncAgentTurn).not.toHaveBeenCalled();
  });
});
