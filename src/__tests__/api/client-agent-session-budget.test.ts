/**
 * The client API's session budget: `GET` reports it, `PATCH
 * /client/v1/agents/sessions/:conversationId` adds / raises / removes it and
 * (by default) continues a paused session as a background run, and a Responses
 * call can start a session with one — and is refused (402) when it is used up.
 * The budget logic itself is covered end to end in
 * `integration/agent-session-budget.test.ts`.
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

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

const hoisted = vi.hoisted(() => ({
  getConversationById: vi.fn(),
  getAgentByKey: vi.fn(),
  createConversation: vi.fn(),
  runSyncAgentTurn: vi.fn(),
  limits: vi.fn(),
  updateBudget: vi.fn(),
  queueContinue: vi.fn(),
  blocking: vi.fn(),
  db: { listAgentPendingActions: vi.fn() },
}));

vi.mock('@/lib/services/agents', () => ({
  getConversationById: hoisted.getConversationById,
  getAgentByKey: hoisted.getAgentByKey,
  createAgentRecord: vi.fn(),
  createConversation: hoisted.createConversation,
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
  invalidRequestErrorBody: (message: string, code: string) => ({ error: { type: 'invalid_request_error', message, code } }),
  runWithTenantDb: (_name: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
  backgroundDisabledErrorBody: () => ({ error: { type: 'invalid_request_error', code: 'background_disabled' } }),
  isBackgroundModeRequested: (header: string | null | undefined, body: Record<string, unknown> | undefined) =>
    header === 'true' || body?.background === true,
  resolveAgentExecutionLimits: hoisted.limits,
  queueAgentRunContinue: hoisted.queueContinue,
  serializeAgentRun: (run: { _id: string; status: string }) => ({ id: `run_${run._id}`, object: 'agent.run', status: run.status }),
  MAX_IDEMPOTENCY_KEY_LENGTH: 255,
  agentDefaultCallback: () => ({}),
  lookupIdempotentAgentRun: vi.fn(),
  validateCallbackRequest: vi.fn(),
}));

vi.mock('@/lib/services/agents/sessionBudgetService', () => ({ updateSessionBudget: hoisted.updateBudget }));
vi.mock('@/lib/services/agents/agentActionResolution', () => ({
  resolveAgentPendingAction: vi.fn(),
  pendingActionsBlockingMessage: hoisted.blocking,
}));
vi.mock('@/lib/services/agents/agentService', () => ({
  AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
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
const headers = { authorization: 'Bearer tok_abc' };
const SESSION_URL = '/api/client/v1/agents/sessions/conv-1';

const conversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', messages: [], createdBy: 'user-1',
  ...overrides,
});
const runWithTenant = vi.fn(<T>(_n: string, fn: () => T | Promise<T>) => fn());

describe('client: session budget', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({ runWithTenant });
    (getPermissionServiceForPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (authorizeServiceRequest as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true });
    hoisted.getConversationById.mockResolvedValue(conversation());
    hoisted.getAgentByKey.mockResolvedValue({ key: 'support-agent', status: 'active', config: { modelKey: 'm' } });
    hoisted.limits.mockResolvedValue({ syncTimeoutMs: 60_000, backgroundEnabled: true, defaultMode: 'sync' });
    hoisted.blocking.mockResolvedValue(null);
    hoisted.db.listAgentPendingActions.mockResolvedValue([]);
    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(clientAgentSessionsApiPlugin);
      await instance.register(clientAgentsApiPlugin);
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET reports the budget and what the session has spent (null / 0 without one)', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({
      budget: { maxCostUsd: 2.5, onReach: 'pause' }, spentUsd: 1.25, runtimeStatus: 'budget_paused', stopReason: 'budget_reached',
    }));
    let res = await app.inject({ method: 'GET', url: SESSION_URL, headers });
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      runtime_status: 'budget_paused', stop_reason: 'budget_reached',
      budget: { max_cost_usd: 2.5, on_reach: 'pause' }, spent_usd: 1.25,
    });

    hoisted.getConversationById.mockResolvedValue(conversation());
    res = await app.inject({ method: 'GET', url: SESSION_URL, headers });
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ budget: null, spent_usd: 0 });
  });

  it('PATCH raises the budget of a paused session and continues it as a background run (202)', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' }));
    hoisted.updateBudget.mockResolvedValue({ kind: 'ok', wasBudgetPaused: true, conversation: conversation({ budget: { maxCostUsd: 5, onReach: 'pause' } }) });
    hoisted.queueContinue.mockResolvedValue({ kind: 'queued', run: { _id: 'run-9', status: 'queued' } });

    const res = await app.inject({
      method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { max_cost_usd: 5, on_reach: 'pause' } },
    });

    expect(res.statusCode).toBe(202);
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ id: 'run_run-9', status: 'queued' });
    expect(hoisted.updateBudget).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1', projectId: 'proj-1', budget: { max_cost_usd: 5, on_reach: 'pause' },
    }));
    expect(hoisted.queueContinue).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1', agentKey: 'support-agent', userId: 'user-1', apiTokenId: 'tok-1',
    }));
  });

  it('PATCH with resume:false only changes the budget (200, the session resource)', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({ runtimeStatus: 'budget_paused' }));
    hoisted.updateBudget.mockResolvedValue({
      kind: 'ok', wasBudgetPaused: true,
      conversation: conversation({ runtimeStatus: 'budget_paused', budget: { maxCostUsd: 5, onReach: 'stop' }, spentUsd: 1 }),
    });

    const res = await app.inject({
      method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { maxCostUsd: 5, onReach: 'stop' }, resume: false },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.queueContinue).not.toHaveBeenCalled();
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      object: 'agent.session', budget: { max_cost_usd: 5, on_reach: 'stop' }, spent_usd: 1,
    });
  });

  it('PATCH on a session that is not paused does not start a run, and null removes the budget', async () => {
    hoisted.updateBudget.mockResolvedValue({ kind: 'ok', wasBudgetPaused: false, conversation: conversation() });
    const res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: null } });
    expect(res.statusCode).toBe(200);
    expect(hoisted.updateBudget).toHaveBeenCalledWith(expect.objectContaining({ budget: null }));
    expect(hoisted.queueContinue).not.toHaveBeenCalled();
  });

  it('PATCH answers 400 for a missing or invalid budget, and refuses to resume when background runs are off', async () => {
    let res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: {} });
    expect(res.statusCode).toBe(400);

    hoisted.updateBudget.mockResolvedValue({ kind: 'invalid', message: 'budget.maxCostUsd must be greater than what the session has already spent ($2).' });
    res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { maxCostUsd: 1 } } });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_budget');

    hoisted.getConversationById.mockResolvedValue(conversation({ runtimeStatus: 'budget_paused' }));
    hoisted.limits.mockResolvedValue({ syncTimeoutMs: 60_000, backgroundEnabled: false, defaultMode: 'sync' });
    hoisted.updateBudget.mockClear();
    res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { maxCostUsd: 9 } } });
    expect(res.statusCode).toBe(400);
    expect(hoisted.updateBudget).not.toHaveBeenCalled(); // nothing was changed
  });

  it('PATCH answers 409 when another run holds the session', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({ runtimeStatus: 'budget_paused' }));
    hoisted.updateBudget.mockResolvedValue({ kind: 'ok', wasBudgetPaused: true, conversation: conversation() });
    hoisted.queueContinue.mockResolvedValue({ kind: 'conflict' });
    const res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { maxCostUsd: 9 } } });
    expect(res.statusCode).toBe(409);
  });

  it('a Responses call that starts a session passes its budget on; a bad one is a 400', async () => {
    hoisted.createConversation.mockResolvedValue({ _id: 'conv-new' });
    hoisted.runSyncAgentTurn.mockResolvedValue({ kind: 'ok', response: { id: 'resp_conv-new', status: 'completed' } });

    let res = await app.inject({
      method: 'POST', url: '/api/client/v1/agents/responses', headers,
      payload: { model: 'support-agent', input: 'hi', budget: { max_cost_usd: 3, on_reach: 'stop' } },
    });
    expect(res.statusCode).toBe(200);
    expect(hoisted.createConversation).toHaveBeenCalledWith(
      'tenant_acme', 'tenant-1', 'proj-1', 'user-1', 'support-agent', undefined, { source: 'api' },
      { maxCostUsd: 3, onReach: 'stop' },
    );

    res = await app.inject({
      method: 'POST', url: '/api/client/v1/agents/responses', headers,
      payload: { model: 'support-agent', input: 'hi', budget: { max_cost_usd: -1 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a Responses call without a budget leaves the agent default to apply (budget argument undefined)', async () => {
    hoisted.createConversation.mockResolvedValue({ _id: 'conv-new' });
    hoisted.runSyncAgentTurn.mockResolvedValue({ kind: 'ok', response: { id: 'resp_conv-new', status: 'completed' } });
    await app.inject({ method: 'POST', url: '/api/client/v1/agents/responses', headers, payload: { model: 'support-agent', input: 'hi' } });
    expect(hoisted.createConversation.mock.calls[0][7]).toBeUndefined();
  });

  it('a Responses call to a session whose budget is used up is a 402 with the amounts, and no run is started', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({
      budget: { maxCostUsd: 1, onReach: 'pause' }, spentUsd: 1.02, runtimeStatus: 'budget_paused',
    }));
    const res = await app.inject({
      method: 'POST', url: '/api/client/v1/agents/responses', headers,
      payload: { model: 'support-agent', input: 'more', previous_response_id: 'resp_conv-1' },
    });
    expect(res.statusCode).toBe(402);
    expect(parseJsonBody<{ error: Record<string, unknown> }>(res.body).error).toMatchObject({
      type: 'budget_reached', spentUsd: 1.02, maxCostUsd: 1,
    });
    expect(hoisted.runSyncAgentTurn).not.toHaveBeenCalled();
  });
  describe('an agent whose admin set a session budget binds its API clients', () => {
    const bound = (extra: Record<string, unknown> = {}) => ({
      key: 'support-agent', status: 'active',
      config: { modelKey: 'm', execution: { sessionBudget: { maxCostUsd: 2, onReach: 'pause', ...extra } } },
    });

    it('PATCH cannot remove the budget or raise it past the default (403), but can lower it', async () => {
      hoisted.getAgentByKey.mockResolvedValue(bound());
      hoisted.getConversationById.mockResolvedValue(conversation({ budget: { maxCostUsd: 2, onReach: 'pause' } }));
      hoisted.updateBudget.mockResolvedValue({ kind: 'ok', wasBudgetPaused: false, conversation: conversation() });

      let res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: null } });
      expect(res.statusCode).toBe(403);
      res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { max_cost_usd: 50 } } });
      expect(res.statusCode).toBe(403);
      expect(hoisted.updateBudget).not.toHaveBeenCalled();

      res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { max_cost_usd: 1 } } });
      expect(res.statusCode).toBe(200);
      expect(hoisted.updateBudget).toHaveBeenCalledTimes(1);
    });

    it('allowClientOverride lets the client raise or remove it', async () => {
      hoisted.getAgentByKey.mockResolvedValue(bound({ allowClientOverride: true }));
      hoisted.updateBudget.mockResolvedValue({ kind: 'ok', wasBudgetPaused: false, conversation: conversation() });
      const res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: null } });
      expect(res.statusCode).toBe(200);
    });

    it('a Responses call cannot start a session with a bigger (or no) budget either', async () => {
      hoisted.getAgentByKey.mockResolvedValue(bound());
      for (const budget of [null, { max_cost_usd: 99 }]) {
        const res = await app.inject({
          method: 'POST', url: '/api/client/v1/agents/responses', headers,
          payload: { model: 'support-agent', input: 'hi', budget },
        });
        expect(res.statusCode).toBe(403);
      }
      expect(hoisted.createConversation).not.toHaveBeenCalled();
    });
  });
});
