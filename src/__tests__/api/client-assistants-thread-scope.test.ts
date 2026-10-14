/**
 * Regression test for F-03 (finance-institution assessment, 2026-09-05):
 * `loadThreadOr404` resolved a thread purely by tenant + threadId — the
 * caller's project was never checked, so a token scoped to project A could
 * fetch project B's thread (agent conversation) just by knowing or guessing
 * its id. `findAgentConversationById` has no projectId parameter at all, so
 * the check has to happen in `loadThreadOr404` itself after the load.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/services/agents', () => ({
  createAgentRecord: vi.fn(),
  createConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  listAgents: vi.fn(),
  updateAgentRecord: vi.fn(),
}));

vi.mock('@/server/api/plugins/guardrail-bindings', () => ({
  resolveConfigGuardrailBindings: vi.fn().mockResolvedValue([]),
}));

// Running a thread sends a message; under cancel_pending that cancels the session's open request, which takes the
// engine's `agent.approve` (api/agent-session-authz.test.ts). Only the wiring is checked here.
const cancelPending = vi.hoisted(() => vi.fn());
const endingOpen = vi.hoisted(() => vi.fn());
const cancelTurn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/agents/turnCancellation', () => ({ cancelConversationTurn: cancelTurn }));
vi.mock('@/server/api/plugins/agent-approval-authz', () => ({
  refuseCancelPending: cancelPending,
  authorizeEndingOpenRequests: endingOpen,
  CANCEL_PENDING_FORBIDDEN_MESSAGE: 'sending a message would cancel the open request',
}));
const exclusive = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/agents/agentRunService', () => ({ executeAgentChatExclusive: exclusive }));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { getAgentByKey, getConversationById } from '@/lib/services/agents';
import { clientAssistantsApiPlugin } from '@/server/api/plugins/client-assistants';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const AUTH_CTX_PROJECT_A = {
  token: 'tok_a',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-a',
  user: { _id: 'user-1', role: 'user', tenantId: 'tenant-1' },
};

const CONVERSATION_IN_PROJECT_B = {
  _id: 'conv-1',
  tenantId: 'tenant-1',
  projectId: 'proj-b',
  agentKey: 'support-bot',
  title: 'A project-B thread',
  messages: [],
  createdBy: 'other-user',
};

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

async function buildApp() {
  return createFastifyApiTestApp(clientAssistantsApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelPending.mockResolvedValue(null);
  endingOpen.mockResolvedValue({ allowed: true });
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX_PROJECT_A);
  mockFn(getDatabase).mockResolvedValue(createMockDb({ runWithTenant } as never));
});

describe('client Assistants API — thread ownership across projects', () => {
  it('404s when a project-A token requests a thread that belongs to project B', async () => {
    mockFn(getConversationById).mockResolvedValue(CONVERSATION_IN_PROJECT_B);
    mockFn(getAgentByKey).mockResolvedValue({ key: 'support-bot', status: 'active' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/threads/thread_conv-1',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(404);
    // The cross-project record must never reach the response body.
    expect(res.body).not.toContain('project-B');
  });

  it('200s and resolves the agent project-scoped when the thread belongs to the caller\'s own project', async () => {
    const ownConversation = { ...CONVERSATION_IN_PROJECT_B, projectId: 'proj-a', title: 'My own thread' };
    mockFn(getConversationById).mockResolvedValue(ownConversation);
    mockFn(getAgentByKey).mockResolvedValue({ key: 'support-bot', status: 'active' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/threads/thread_conv-1',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(200);
    // The agent lookup backing loadThreadOr404 must be scoped to the
    // conversation's own project, not left unscoped.
    expect(getAgentByKey).toHaveBeenCalledWith('tenant_acme', 'support-bot', 'proj-a');
  });
});

describe('client Assistants API — running a thread that waits on an open request', () => {
  const waiting = {
    ...CONVERSATION_IN_PROJECT_B,
    projectId: 'proj-a',
    runtimeStatus: 'requires_action',
    metadata: { assistantsApi: { pendingMessages: [{ id: 'p1', role: 'user', content: 'never mind', created_at: 1 }] } },
  };
  const run = async () => {
    mockFn(getConversationById).mockResolvedValue(waiting);
    mockFn(getAgentByKey).mockResolvedValue({ _id: 'agent-1', key: 'support-bot', status: 'active', config: { humanInTheLoop: { onUserMessageWhilePending: 'cancel_pending' } } });
    const app = await buildApp();
    return app.inject({ method: 'POST', url: '/api/client/v1/threads/thread_conv-1/runs', headers: { authorization: 'Bearer tok' }, payload: {} });
  };

  it('is 403 (with the decision id) for a token the engine does not let answer it, and nothing runs', async () => {
    cancelPending.mockResolvedValue({ decisionId: 'dec-6' });
    const res = await run();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('would cancel'), decision_id: 'dec-6' });
    expect(exclusive).not.toHaveBeenCalled();
    expect(cancelPending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantDbName: 'tenant_acme', conversation: waiting, agent: expect.objectContaining({ key: 'support-bot' }) }),
    );
  });

  it('runs for a token that may answer', async () => {
    exclusive.mockResolvedValue({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(exclusive).toHaveBeenCalledTimes(1);
  });
});

describe('client Assistants API - cancelling a run', () => {
  const own = {
    ...CONVERSATION_IN_PROJECT_B,
    projectId: 'proj-a',
    createdBy: 'user-1',
    metadata: { assistantsApi: { runs: [{ id: 'run_done', status: 'completed', created_at: 1, assistant_id: 'asst_support-bot' }] } },
  };
  const cancel = async (runId: string) => {
    mockFn(getConversationById).mockResolvedValue(own);
    mockFn(getAgentByKey).mockResolvedValue({ _id: 'agent-1', key: 'support-bot', status: 'active' });
    const app = await buildApp();
    return app.inject({ method: 'POST', url: `/api/client/v1/threads/thread_conv-1/runs/${runId}/cancel`, headers: { authorization: 'Bearer tok' } });
  };

  it('a recorded run is terminal: 400, and nothing is stopped', async () => {
    const res = await cancel('run_done');
    expect(res.statusCode).toBe(400);
    expect(cancelTurn).not.toHaveBeenCalled();
  });

  it('stops the running turn of the thread through the shared cancel and answers cancelling', async () => {
    cancelTurn.mockResolvedValue({ cancelled: true, runIds: ['r1'], cancelledActions: false });
    const res = await cancel('run_live');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 'run_live', object: 'thread.run', thread_id: 'thread_conv-1', status: 'cancelling' });
    expect(cancelTurn).toHaveBeenCalledWith(expect.objectContaining({
      tenantDbName: 'tenant_acme', conversationId: 'conv-1', agentKey: 'support-bot', cancelActions: true,
    }));
  });

  it('keeps open approvals when the caller may not answer them, but still stops the turn', async () => {
    endingOpen.mockResolvedValue({ allowed: false });
    cancelTurn.mockResolvedValue({ cancelled: true, runIds: ['r1'], cancelledActions: false });
    const res = await cancel('run_live');
    expect(res.statusCode).toBe(200);
    expect(cancelTurn).toHaveBeenCalledWith(expect.objectContaining({ cancelActions: false }));
  });

  it('404s when no turn is running and the run is unknown', async () => {
    cancelTurn.mockResolvedValue({ cancelled: false, runIds: [], cancelledActions: false });
    const res = await cancel('run_nope');
    expect(res.statusCode).toBe(404);
  });

  it('records a run whose turn was stopped as cancelled, keeping the partial answer', async () => {
    mockFn(getConversationById).mockResolvedValue({
      ...own,
      metadata: { assistantsApi: { pendingMessages: [{ id: 'p1', role: 'user', content: 'go', created_at: 1 }] } },
    });
    mockFn(getAgentByKey).mockResolvedValue({ _id: 'agent-1', key: 'support-bot', status: 'active' });
    exclusive.mockResolvedValue({ status: 'incomplete', stop_reason: 'cancelled', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/client/v1/threads/thread_conv-1/runs', headers: { authorization: 'Bearer tok' }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'cancelled', cancelled_at: expect.any(Number) });
  });
});
