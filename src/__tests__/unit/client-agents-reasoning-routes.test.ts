/**
 * Reasoning on the client agent routes: `reasoning_effort` / `reasoning:
 * { effort }` are validated (400 `invalid_reasoning`) and handed to the run as
 * the lowest rung of the precedence; `include_reasoning: false` narrows a
 * response; the agent info says whether the agent shows its reasoning.
 *
 * Same harness as client-agents-responses-contract.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getAgentByKey: vi.fn(),
  getConversationById: vi.fn(),
  createConversation: vi.fn(),
  startAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  requireApiTokenFromHeader: vi.fn(),
  getDatabase: vi.fn(),
  resolveAgentRunLimits: vi.fn(),
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
    startAgentRun: hoisted.startAgentRun,
    getAgentRunStatus: hoisted.getAgentRunStatus,
    resolveAgentRunLimits: hoisted.resolveAgentRunLimits,
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
  config: { modelKey: 'gpt-4o', budget: { maxCostUsd: 2, onReach: 'pause' } },
};
const EXISTING_SESSION = { _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', messages: [], createdBy: 'user-1' };

const LIMITS = { syncWaitMs: 60_000, maxDurationMs: 1_800_000, maxActivePerTenant: 0, maxActivePerProject: 0 };
const responses = (payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url: '/api/client/v1/agents/responses',
  headers: { ...headers, ...extraHeaders },
  payload,
});

const RUN = { _id: 'run-1', status: 'succeeded', mode: 'inline', conversationId: 'conv-1', agentKey: 'support-agent' };

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.getDatabase.mockResolvedValue(createMockDb());
  hoisted.requireApiTokenFromHeader.mockResolvedValue(AUTH_CTX);
  hoisted.getAgentByKey.mockResolvedValue(BOUND_AGENT);
  hoisted.getConversationById.mockResolvedValue(EXISTING_SESSION);
  hoisted.createConversation.mockResolvedValue({ _id: 'conv-new' });
  hoisted.getAgentRunStatus.mockResolvedValue(null);
  hoisted.resolveAgentRunLimits.mockResolvedValue(LIMITS);
  hoisted.blocking.mockResolvedValue(null);
  hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: RUN, response: { id: 'resp_run-1', status: 'completed' } });
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(clientAgentSessionsApiPlugin);
    await instance.register(clientAgentsApiPlugin);
  });
});

afterEach(async () => {
  await app.close();
});


const lastSyncRequest = () => hoisted.startAgentRun.mock.calls.at(-1)![0] as Record<string, unknown>;

describe('reasoning_effort on /client/v1/agents/responses', () => {
  it('hands a valid effort to the run as the request value', async () => {
    const res = await app.inject(responses({ model: 'support-agent', input: 'hi', reasoning_effort: 'low' }));
    expect(res.statusCode).toBe(200);
    expect(lastSyncRequest().requestReasoning).toEqual({ effort: 'low' });
  });

  it('understands reasoning: { effort } and lets the object win', async () => {
    let res = await app.inject(responses({ model: 'support-agent', input: 'hi', reasoning: { effort: 'high' } }));
    expect(res.statusCode).toBe(200);
    expect(lastSyncRequest().requestReasoning).toEqual({ effort: 'high' });

    res = await app.inject(responses({ model: 'support-agent', input: 'hi', reasoning_effort: 'low', reasoning: { effort: 'minimal' } }));
    expect(lastSyncRequest().requestReasoning).toEqual({ effort: 'minimal' });
  });

  it('sends nothing when the request has neither', async () => {
    await app.inject(responses({ model: 'support-agent', input: 'hi' }));
    expect(lastSyncRequest()).not.toHaveProperty('requestReasoning');
  });

  it.each([
    [{ reasoning_effort: 'extreme' }],
    [{ reasoning: { effort: 'turbo' } }],
    [{ reasoning: 'high' }],
  ])('refuses %j with 400 invalid_reasoning and runs nothing', async (extra) => {
    const res = await app.inject(responses({ model: 'support-agent', input: 'hi', ...extra }));
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: { code: string; message: string } }>(res.body).error).toMatchObject({ code: 'invalid_reasoning' });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });
});

describe('include_reasoning: false', () => {
  const withReasoning = {
    id: 'resp_conv-1', status: 'completed',
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
      { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  };

  it('leaves the reasoning item out of this response', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: RUN, response: withReasoning });
    const res = await app.inject(responses({ model: 'support-agent', input: 'hi', include_reasoning: false }));
    const output = parseJsonBody<{ output: Array<{ type: string }> }>(res.body).output;
    expect(output.map((item) => item.type)).toEqual(['message']);
  });

  it('keeps it otherwise', async () => {
    hoisted.startAgentRun.mockResolvedValue({ kind: 'completed', run: RUN, response: withReasoning });
    const res = await app.inject(responses({ model: 'support-agent', input: 'hi' }));
    expect(parseJsonBody<{ output: Array<{ type: string }> }>(res.body).output.map((item) => item.type)).toEqual(['reasoning', 'message']);
  });
});

describe('agent info', () => {
  it('exposes showReasoning (default true, false when the agent hides it)', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/support-agent', headers });
    expect(parseJsonBody<{ agent: { config: { showReasoning: boolean } } }>(res.body).agent.config.showReasoning).toBe(true);

    hoisted.getAgentByKey.mockResolvedValue({ ...BOUND_AGENT, config: { ...BOUND_AGENT.config, showReasoning: false } });
    res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/support-agent', headers });
    expect(parseJsonBody<{ agent: { config: { showReasoning: boolean } } }>(res.body).agent.config.showReasoning).toBe(false);
  });
});
