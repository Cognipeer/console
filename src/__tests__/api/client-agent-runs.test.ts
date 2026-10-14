import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }

  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

const hoisted = vi.hoisted(() => ({
  getAgentRunStatus: vi.fn(),
  requestAgentRunCancellation: vi.fn(),
  getConversationById: vi.fn(),
  ending: vi.fn(),
  access: vi.fn(),
  cancelTurn: vi.fn(),
}));

// What a Stop does to the running turn has its own tests (unit/agent-sdk-cancellation.test.ts); only the wiring is checked here.
vi.mock('@/lib/services/agents/turnCancellation', () => ({ cancelConversationTurn: hoisted.cancelTurn }));

vi.mock('@/lib/services/agents', () => ({
  getAgentRunStatus: hoisted.getAgentRunStatus,
  requestAgentRunCancellation: hoisted.requestAgentRunCancellation,
  getConversationById: hoisted.getConversationById,
}));

// Ending the open request of a paused run takes the engine's `agent.approve`; its own tests are
// api/agent-session-authz.test.ts. Only the wiring is checked here.
vi.mock('@/server/api/plugins/agent-approval-authz', () => ({ authorizeEndingOpenRequests: hoisted.ending }));

// Whose session a run belongs to is the session access module's question (api/agent-session-authz.test.ts has its own tests);
// only the wiring is checked here: the run's session, the need (view to read, manage to cancel), and the refusal's shape.
vi.mock('@/server/api/plugins/agent-session-access', () => ({
  // The linked-path helper in miniature: read the run's conversation, ignore one of another project, else ask the access question.
  refuseSessionLinked: async (request: unknown, conversationId: string, need: string, options: { actor: { projectId: string } }) => {
    const conversation = await hoisted.getConversationById('tenant_acme', conversationId) as { projectId: string } | null;
    if (!conversation || conversation.projectId !== options.actor.projectId) return null;
    const decision = await hoisted.access(request, conversation, { need, ...options });
    return decision.ok ? null : decision;
  },
  sendClientSessionRefusal: (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, _request: unknown, refusal: { status: number; reason: string; decisionId?: string }) => (
    reply.code(refusal.status).send({ error: { code: refusal.reason, ...(refusal.decisionId ? { decision_id: refusal.decisionId } : {}) } })
  ),
  sendAuthorizationUnavailable: (reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => reply.code(503).send({ error: { code: 'authorization_unavailable' } }),
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';
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

const runWithTenant = vi.fn(<T>(_tenantDbName: string, fn: () => T | Promise<T>) => fn());

describe('client agent runs routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
    hoisted.ending.mockResolvedValue({ allowed: true });
    hoisted.access.mockResolvedValue({ ok: true, owner: true, userId: 'user-1' });
    hoisted.getConversationById.mockReset();
    hoisted.getConversationById.mockResolvedValue(null);
    hoisted.getAgentRunStatus.mockReset();
    app = await createFastifyApiTestApp(clientAgentRunsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/client/v1/agents/runs/:runId returns serialized status', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({
      _id: 'run-1',
      mode: 'background',
      agentKey: 'support-agent',
      conversationId: 'conv-1',
      status: 'running',
      result: null,
      errorReason: null,
      errorMessage: null,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      startedAt: new Date('2024-01-01T00:00:01Z'),
      completedAt: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/agents/runs/run-1',
      headers: { authorization: '******' },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
    const body = parseJsonBody<{ id: string; object: string; status: string }>(res.body);
    expect(body.id).toBe('run_run-1');
    expect(body.object).toBe('agent.run');
    expect(body.status).toBe('running');
  });

  it('GET reads a run as the session it belongs to: a session somebody else started takes agent.session_view_others', async () => {
    const run = { _id: 'run-1', mode: 'background', agentKey: 'support-agent', conversationId: 'conv-1', userId: 'user-9', status: 'succeeded', createdAt: new Date(), startedAt: null, completedAt: null, result: null, errorReason: null, errorMessage: null };
    const conversation = { _id: 'conv-1', projectId: 'proj-1', agentKey: 'support-agent', createdBy: 'user-9' };
    hoisted.getAgentRunStatus.mockResolvedValue(run);
    hoisted.getConversationById.mockResolvedValue(conversation);
    hoisted.access.mockResolvedValue({ ok: false, status: 403, reason: 'forbidden', need: 'view', decisionId: 'dec-3' });

    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/runs/run-1', headers: { authorization: '******' } });

    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ error: { code: string; decision_id: string } }>(res.body).error).toMatchObject({ code: 'forbidden', decision_id: 'dec-3' });
    // the question: the caller's rights to THIS session, the queuer of the run counting as its owner too
    expect(hoisted.access).toHaveBeenCalledWith(expect.anything(), conversation, expect.objectContaining({ need: 'view', alsoOwnedBy: ['user-9'] }));
  });

  it('GET returns a structured 404 for a sync reservation row (an internal lock, not a caller-owned run)', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({
      _id: 'run-1',
      mode: 'sync',
      agentKey: 'support-agent',
      conversationId: 'conv-1',
      status: 'running',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/agents/runs/run_run-1',
      headers: { authorization: '******' },
    });

    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('agent_run_not_found');
  });

  it('POST /api/client/v1/agents/runs/:runId/cancel requests cancellation in tenant/project scope', async () => {
    hoisted.requestAgentRunCancellation.mockResolvedValue({
      kind: 'accepted',
      run: {
        _id: 'run-1',
        agentKey: 'support-agent',
        conversationId: 'conv-1',
        status: 'running',
        result: null,
        errorReason: null,
        errorMessage: null,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        startedAt: new Date('2024-01-01T00:00:01Z'),
        completedAt: null,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/agents/runs/run-1/cancel',
      headers: { authorization: '******' },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.requestAgentRunCancellation).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
  });

  describe('cancelling a run that is paused on an approval answers the open request with "no"', () => {
    const paused = { _id: 'run-1', mode: 'background', agentKey: 'support-agent', conversationId: 'conv-1', status: 'requires_action' };
    const conversation = { _id: 'conv-1', projectId: 'proj-1', agentKey: 'support-agent', createdBy: 'user-9', runtimeStatus: 'requires_action' };
    const cancel = () => app.inject({ method: 'POST', url: '/api/client/v1/agents/runs/run-1/cancel', headers: { authorization: '******' } });

    it('is 403 (action_forbidden, with the decision id) for a token the engine does not let answer; the run is left alone', async () => {
      hoisted.getAgentRunStatus.mockResolvedValue(paused);
      hoisted.getConversationById.mockResolvedValue(conversation);
      hoisted.ending.mockResolvedValue({ allowed: false, decisionId: 'dec-7' });

      const res = await cancel();

      expect(res.statusCode).toBe(403);
      expect(parseJsonBody<{ error: { code: string; decision_id: string } }>(res.body).error).toMatchObject({ code: 'action_forbidden', decision_id: 'dec-7' });
      expect(hoisted.requestAgentRunCancellation).not.toHaveBeenCalled();
      expect(hoisted.ending).toHaveBeenCalledWith(expect.anything(), { tenantDbName: 'tenant_acme', conversation });
    });

    it('cancels for a token that may answer', async () => {
      hoisted.getAgentRunStatus.mockResolvedValue(paused);
      hoisted.getConversationById.mockResolvedValue(conversation);
      hoisted.requestAgentRunCancellation.mockResolvedValue({
        kind: 'accepted',
        run: { ...paused, status: 'canceled', createdAt: new Date(), startedAt: null, completedAt: null, result: null, errorReason: null, errorMessage: null },
      });
      const res = await cancel();
      expect(res.statusCode).toBe(200);
      expect(hoisted.requestAgentRunCancellation).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-1');
    });

    it('cancelling is acting on the session: a refusal there stops the cancel before anything else is asked', async () => {
      hoisted.getAgentRunStatus.mockResolvedValue({ ...paused, status: 'running' });
      hoisted.getConversationById.mockResolvedValue(conversation);
      hoisted.access.mockResolvedValue({ ok: false, status: 403, reason: 'forbidden', need: 'manage', decisionId: 'dec-4' });
      const res = await cancel();
      expect(res.statusCode).toBe(403);
      expect(hoisted.access).toHaveBeenCalledWith(expect.anything(), conversation, expect.objectContaining({ need: 'manage' }));
      expect(hoisted.requestAgentRunCancellation).not.toHaveBeenCalled();
      expect(hoisted.ending).not.toHaveBeenCalled();
    });

    it('is 503 when the engine could not decide who may end the request: never a cancel, never a 403', async () => {
      hoisted.getAgentRunStatus.mockResolvedValue(paused);
      hoisted.getConversationById.mockResolvedValue(conversation);
      hoisted.ending.mockResolvedValue({ allowed: false, unavailable: true, decisionId: 'dec-5' });
      const res = await cancel();
      expect(res.statusCode).toBe(503);
      expect(hoisted.requestAgentRunCancellation).not.toHaveBeenCalled();
    });

    it('asks nothing for a run that is not paused, or for a session of another project', async () => {
      hoisted.requestAgentRunCancellation.mockResolvedValue({ kind: 'not_found' });
      hoisted.getAgentRunStatus.mockResolvedValue({ ...paused, status: 'running' });
      await cancel();
      hoisted.getAgentRunStatus.mockResolvedValue(paused);
      hoisted.getConversationById.mockResolvedValue({ ...conversation, projectId: 'proj-2' });
      await cancel();
      expect(hoisted.ending).not.toHaveBeenCalled();
    });
  });

  describe('stopping the turn running now, by the id the client already has', () => {
    const conversation = { _id: 'conv-1', projectId: 'proj-1', agentKey: 'support-agent', createdBy: 'user-1' };
    const post = (url: string) => app.inject({ method: 'POST', url, headers: { authorization: '******' } });

    beforeEach(() => {
      hoisted.getConversationById.mockResolvedValue(conversation);
      hoisted.cancelTurn.mockReset();
      hoisted.cancelTurn.mockResolvedValue({ cancelled: true, runIds: ['run-1'], cancelledActions: false });
    });

    it('POST /api/client/v1/agents/conversations/:conversationId/cancel stops the turn in tenant/project scope', async () => {
      const res = await post('/api/client/v1/agents/conversations/conv-1/cancel');
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody(res.body)).toEqual({ conversation_id: 'conv-1', cancelled: true, run_ids: ['run-1'] });
      expect(hoisted.access).toHaveBeenCalledWith(expect.anything(), conversation, expect.objectContaining({ need: 'manage' }));
      expect(hoisted.cancelTurn).toHaveBeenCalledWith({
        tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', conversationId: 'conv-1', cancelActions: true,
      });
    });

    it('nothing running is a 200 with cancelled: false, not an error', async () => {
      hoisted.cancelTurn.mockResolvedValue({ cancelled: false, runIds: [], cancelledActions: false });
      const res = await post('/api/client/v1/agents/conversations/conv-1/cancel');
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody(res.body)).toEqual({ conversation_id: 'conv-1', cancelled: false, run_ids: [] });
    });

    it('is 404 for a session of another project, and stops nothing', async () => {
      hoisted.getConversationById.mockResolvedValue({ ...conversation, projectId: 'proj-2' });
      const res = await post('/api/client/v1/agents/conversations/conv-1/cancel');
      expect(res.statusCode).toBe(404);
      expect(hoisted.cancelTurn).not.toHaveBeenCalled();
    });

    it('a session the token may not manage is refused before anything stops', async () => {
      hoisted.access.mockResolvedValue({ ok: false, status: 403, reason: 'forbidden', need: 'manage', decisionId: 'dec-9' });
      const res = await post('/api/client/v1/agents/conversations/conv-1/cancel');
      expect(res.statusCode).toBe(403);
      expect(parseJsonBody(res.body)).toEqual({ error: { code: 'forbidden', decision_id: 'dec-9' } });
      expect(hoisted.cancelTurn).not.toHaveBeenCalled();
    });

    it('without the right to answer an open approval the turn still stops and the approval stays', async () => {
      hoisted.ending.mockResolvedValue({ allowed: false });
      const res = await post('/api/client/v1/agents/conversations/conv-1/cancel');
      expect(res.statusCode).toBe(200);
      expect(hoisted.cancelTurn).toHaveBeenCalledWith(expect.objectContaining({ cancelActions: false }));
    });

    it('is 503 when the engine could not decide: nothing stops', async () => {
      hoisted.ending.mockResolvedValue({ allowed: false, unavailable: true, decisionId: 'dec-10' });
      const res = await post('/api/client/v1/agents/conversations/conv-1/cancel');
      expect(res.statusCode).toBe(503);
      expect(hoisted.cancelTurn).not.toHaveBeenCalled();
    });

    it.each([
      '/api/client/v1/responses/:responseId/cancel',
      '/api/client/v1/agents/responses/:responseId/cancel',
    ])('POST %s takes the resp_<conversationId> that /responses returned', async (route) => {
      const res = await post(route.replace(':responseId', 'resp_conv-1'));
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody(res.body)).toEqual({ id: 'resp_conv-1', conversation_id: 'conv-1', cancelled: true, run_ids: ['run-1'] });
      expect(hoisted.cancelTurn).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', projectId: 'proj-1' }));
    });

    it('POST /api/client/v1/responses/:responseId/cancel takes a background run id (run_<runId>) through its session', async () => {
      hoisted.getAgentRunStatus.mockResolvedValue({ _id: 'run-7', conversationId: 'conv-1', status: 'running' });
      const res = await post('/api/client/v1/responses/run_run-7/cancel');
      expect(res.statusCode).toBe(200);
      expect(hoisted.getAgentRunStatus).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'run-7');
      expect(parseJsonBody(res.body)).toMatchObject({ id: 'run_run-7', conversation_id: 'conv-1' });
    });

    it('an id that is neither resp_ nor run_, or a run that is not there, is 404', async () => {
      expect((await post('/api/client/v1/agents/responses/xyz/cancel')).statusCode).toBe(404);
      hoisted.getAgentRunStatus.mockResolvedValue(null);
      expect((await post('/api/client/v1/responses/run_missing/cancel')).statusCode).toBe(404);
      expect(hoisted.cancelTurn).not.toHaveBeenCalled();
    });
  });
});
