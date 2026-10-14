/**
 * Contract details of the client Responses route that the other route tests do
 * not pin: a request that continues a session ignores its `budget`, a refused
 * turn is logged as a refusal (not an error with a stack), and the 409 for a
 * busy conversation has one `type` on every route that can answer it.
 *
 * Like `agent-run-routes.test.ts`, the pure helpers of `agentRunService` are
 * real; what touches the database or the queue is replaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  runSyncAgentTurn: vi.fn(),
  createBackgroundAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  resolveAgentExecutionLimits: vi.fn(),
  resolveAction: vi.fn(),
  blocking: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: hoisted.getDatabase,
  // The gate reads the caller (and the engine its policies) through the tenant scope.
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await hoisted.getDatabase()),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => hoisted.log,
  logger: hoisted.log,
  SENSITIVE_KEY_PATTERN: /^(password|secret|token)$/i,
}));

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiTokenFromHeader };
});

vi.mock('@/lib/services/agents/agentService', () => ({
  AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
  createAgentRecord: vi.fn(),
  updateAgentRecord: vi.fn(),
  deleteAgentRecord: vi.fn(),
  getAgentById: vi.fn(),
  getAgentByKey: hoisted.getAgentByKey,
  listAgents: vi.fn(),
  countAgents: vi.fn(),
  publishAgent: vi.fn(),
  getAgentVersion: vi.fn(),
  listAgentVersions: vi.fn(),
  resolveAgentConfig: vi.fn(),
  createConversation: hoisted.createConversation,
  getConversationById: hoisted.getConversationById,
  listConversations: vi.fn(),
  deleteConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  executePlaygroundChat: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentActionResolution', () => ({
  resolveAgentPendingAction: hoisted.resolveAction,
  pendingActionsBlockingMessage: hoisted.blocking,
}));

vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
  return {
    ...actual,
    runSyncAgentTurn: hoisted.runSyncAgentTurn,
    createBackgroundAgentRun: hoisted.createBackgroundAgentRun,
    getAgentRunStatus: hoisted.getAgentRunStatus,
    resolveAgentExecutionLimits: hoisted.resolveAgentExecutionLimits,
  };
});

import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createMockDb } from '../helpers/db.mock';
import { clientAgentsApiPlugin } from '@/server/api/plugins/client-agents';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
import { AgentBudgetReachedError, AgentPendingActionError } from '@/lib/services/agents/agentErrors';

const headers = { authorization: 'Bearer tok_abc', 'content-type': 'application/json' };

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'ENTERPRISE' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1' },
};

// An agent whose admin set a session budget and did not let API clients change it.
const BOUND_AGENT = {
  _id: 'agent-1', tenantId: 'tenant-1', projectId: 'proj-1', key: 'support-agent', name: 'Support', status: 'active',
  config: { modelKey: 'gpt-4o', execution: { sessionBudget: { maxCostUsd: 2, onReach: 'pause' } } },
};
const EXISTING_SESSION = { _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', messages: [], createdBy: 'user-1' };

const LIMITS = { syncTimeoutMs: 60_000, backgroundEnabled: true, backgroundMaxDurationMs: 1_800_000, defaultMode: 'sync' as const };
const responses = (payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url: '/api/client/v1/agents/responses',
  headers: { ...headers, ...extraHeaders },
  payload,
});

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.getDatabase.mockResolvedValue(createMockDb());
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.getAgentByKey.mockResolvedValue(BOUND_AGENT);
  hoisted.getConversationById.mockResolvedValue(EXISTING_SESSION);
  hoisted.createConversation.mockResolvedValue({ _id: 'conv-new' });
  hoisted.getAgentRunStatus.mockResolvedValue(null);
  hoisted.resolveAgentExecutionLimits.mockResolvedValue(LIMITS);
  hoisted.blocking.mockResolvedValue(null);
  hoisted.runSyncAgentTurn.mockResolvedValue({ kind: 'ok', response: { id: 'resp_conv-1', status: 'completed' } });
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientAgentSessionsApiPlugin);
    await instance.register(clientAgentsApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});

describe('budget on a Responses request', () => {
  it('is ignored when the request continues a session: not applied, not validated', async () => {
    for (const budget of [{ max_cost_usd: 9 }, null, { max_cost_usd: -1 }, 'lots']) {
      const res = await app.inject(responses({ model: 'support-agent', input: 'more', previous_response_id: 'resp_conv-1', budget }));
      expect(res.statusCode, JSON.stringify(budget)).toBe(200);
    }
    expect(hoisted.runSyncAgentTurn).toHaveBeenCalledTimes(4);
    expect(hoisted.createConversation).not.toHaveBeenCalled();
  });

  it('is ignored on a continuation by run id as well', async () => {
    hoisted.getAgentRunStatus.mockResolvedValue({ conversationId: 'conv-1' });
    const res = await app.inject(responses({ model: 'support-agent', input: 'more', previous_response_id: 'run_abc', budget: { max_cost_usd: 99 } }));
    expect(res.statusCode).toBe(200);
  });

  it('is still validated, and bound to the agent, when the request starts a session', async () => {
    let res = await app.inject(responses({ model: 'support-agent', input: 'hi', budget: { max_cost_usd: -1 } }));
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_budget');

    res = await app.inject(responses({ model: 'support-agent', input: 'hi', budget: { max_cost_usd: 9 } }));
    expect(res.statusCode).toBe(403);
    expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('budget_override_forbidden');

    res = await app.inject(responses({ model: 'support-agent', input: 'hi', budget: { max_cost_usd: 1 } }));
    expect(res.statusCode).toBe(200);
    expect(hoisted.createConversation.mock.calls[0]![7]).toEqual({ maxCostUsd: 1, onReach: 'pause' });
  });
});

describe('a refused turn is logged as a refusal', () => {
  it('a spent session budget (402) is info, with no stack and no error entry', async () => {
    hoisted.runSyncAgentTurn.mockRejectedValue(new AgentBudgetReachedError(1.02, 1));
    const res = await app.inject(responses({ model: 'support-agent', input: 'more', previous_response_id: 'resp_conv-1' }));
    expect(res.statusCode).toBe(402);
    expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('budget_reached');
    expect(hoisted.log.error).not.toHaveBeenCalled();
    expect(hoisted.log.info).toHaveBeenCalledTimes(1);
    const [message, detail] = hoisted.log.info.mock.calls[0]!;
    expect(message).toBe('Client agent responses error');
    expect(detail).toMatchObject({ status: 402, type: 'budget_reached', code: 'budget_reached' });
    expect(detail).not.toHaveProperty('error');
  });

  it('a session waiting on a person (409 pending_action) is info too', async () => {
    hoisted.runSyncAgentTurn.mockRejectedValue(new AgentPendingActionError(['act_1']));
    const res = await app.inject(responses({ model: 'support-agent', input: 'more', previous_response_id: 'resp_conv-1' }));
    expect(res.statusCode).toBe(409);
    expect(parseJsonBody<{ error: { pending_action_ids: string[] } }>(res.body).error.pending_action_ids).toEqual(['act_1']);
    expect(hoisted.log.error).not.toHaveBeenCalled();
    expect(hoisted.log.info).toHaveBeenCalledTimes(1);
  });

  it('another 4xx the caller can act on is a warning without a stack', async () => {
    hoisted.runSyncAgentTurn.mockRejectedValue(new Error('Model "gpt-x" not found'));
    const res = await app.inject(responses({ model: 'support-agent', input: 'hi' }));
    expect(res.statusCode).toBe(409);
    expect(hoisted.log.error).not.toHaveBeenCalled();
    expect(hoisted.log.warn).toHaveBeenCalledTimes(1);
    expect(hoisted.log.warn.mock.calls[0]![1]).not.toHaveProperty('error');
  });

  it('a server fault is still an error with its stack', async () => {
    const failure = new Error('kaboom');
    hoisted.runSyncAgentTurn.mockRejectedValue(failure);
    const res = await app.inject(responses({ model: 'support-agent', input: 'hi' }));
    expect(res.statusCode).toBe(500);
    expect(hoisted.log.error).toHaveBeenCalledWith('Client agent responses error', { error: failure });
    expect(hoisted.log.info).not.toHaveBeenCalled();
  });
});

describe('409 for a conversation that is busy', () => {
  it('has the same type and code on the Responses route and on answering a request', async () => {
    hoisted.runSyncAgentTurn.mockResolvedValue({ kind: 'conflict' });
    const fromResponses = await app.inject(responses({ model: 'support-agent', input: 'hi' }));

    hoisted.resolveAction.mockResolvedValue({ kind: 'busy' });
    const fromResolve = await app.inject({
      method: 'POST',
      url: '/api/client/v1/agents/sessions/conv-1/actions/act_1',
      headers,
      payload: { decision: 'allow' },
    });

    expect(fromResponses.statusCode).toBe(409);
    expect(fromResolve.statusCode).toBe(409);
    const a = parseJsonBody<{ error: { type: string; code: string } }>(fromResponses.body).error;
    const b = parseJsonBody<{ error: { type: string; code: string } }>(fromResolve.body).error;
    expect(a).toMatchObject({ type: 'agent_run_conflict', code: 'agent_run_conflict' });
    expect(b).toEqual(a);
  });
});
