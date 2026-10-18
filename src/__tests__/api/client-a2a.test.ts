/**
 * Inbound A2A server tests — the JSON-RPC surface that exposes agents to
 * external A2A clients. Locks the contract:
 *   - exposure is opt-in via `agent.metadata.a2a.enabled` (404 otherwise,
 *     identical to a missing agent)
 *   - the agent card advertises the JSON-RPC endpoint + bearer security
 *   - message/send maps contextId ↔ conversationId, stamps the caller's
 *     runtime context with source 'a2a', runs the turn as a recorded inline
 *     run (channel a2a) and returns a terminal task named by the run
 *     (`run_<runId>`), or a `working` one when the wait window ends first
 *   - tasks/get / tasks/cancel read and cancel the run; the older
 *     `task_<conv>_<idx>` ids still rebuild from the conversation store
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

vi.mock('@/lib/database', async () => {
  const errors = await import('@/lib/database/provider/errors');
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
    AgentRunConflictError: errors.AgentRunConflictError,
    AgentRunIdempotencyKeyTakenError: errors.AgentRunIdempotencyKeyTakenError,
  };
});

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

// May the caller end the open request of a task? The policy engine's `agent.approve`; its own tests are
// api/agent-session-authz.test.ts. Here only that the A2A surface asks, and answers its refusal as JSON-RPC.
const approval = vi.hoisted(() => ({ ending: vi.fn(), cancelPending: vi.fn() }));
vi.mock('@/server/api/plugins/agent-approval-authz', () => ({
  authorizeEndingOpenRequests: approval.ending,
  refuseCancelPending: approval.cancelPending,
  CANCEL_PENDING_FORBIDDEN_MESSAGE: 'sending a message would cancel the open request',
  approvalAuthorizerFor: vi.fn(),
}));

// The caller's wait window: the real limits unless a test shortens it.
const limits = vi.hoisted(() => ({ override: null as null | Record<string, number> }));
// A queued start publishes to the job queue; a test that queues stands in for the whole start and reads what it was asked.
const queuedStart = vi.hoisted(() => ({ run: null as null | ((input: Record<string, any>) => unknown) }));
vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
  return {
    ...actual,
    startAgentRun: (input: Parameters<typeof actual.startAgentRun>[0]) =>
      (queuedStart.run && input.execution.kind === 'queued' ? queuedStart.run(input) : actual.startAgentRun(input)),
    resolveAgentRunLimits: async (...args: Parameters<typeof actual.resolveAgentRunLimits>) =>
      (limits.override ? { ...(await actual.resolveAgentRunLimits()), ...limits.override } : actual.resolveAgentRunLimits(...args)),
  };
});

// Files a message carries are stored through the session files (the real input reader and store run on top of these two).
const files = vi.hoisted(() => ({ upload: vi.fn(), fetch: vi.fn() }));
vi.mock('@/lib/services/agents/sessionFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/sessionFiles')>()),
  uploadSessionFile: files.upload,
}));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: files.fetch }));

vi.mock('@/lib/services/agents/agentService', () => ({
  getAgentByKey: vi.fn(),
  executeAgentChat: vi.fn(),
  createConversation: vi.fn(),
  getConversationById: vi.fn(),
  deleteConversation: vi.fn(),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import {
  createConversation,
  deleteConversation,
  executeAgentChat,
  getAgentByKey,
  getConversationById,
} from '@/lib/services/agents/agentService';
import { clientA2aApiPlugin } from '@/server/api/plugins/client-a2a';
import * as spendLimits from '@/lib/services/agents/agentSpendLimits';
import { abortLocalTurns } from '@/lib/services/agents/turnWatch';
import { sessionEventBus } from '@/lib/services/agents/sessionEvents';
import { AgentAttachmentError } from '@/lib/services/agents/agentErrors';
import { AgentRunConflictError } from '@/lib/database/provider/errors';
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

const EXPOSED_AGENT = {
  _id: 'agent-1',
  key: 'support-bot',
  name: 'Support Bot',
  description: 'Answers support questions',
  status: 'active',
  publishedVersion: 3,
  config: { toolBindings: [{ source: 'tool', sourceKey: 'crm', toolNames: ['lookup'] }] },
  metadata: { a2a: { enabled: true } },
};

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());
// message/send is a recorded inline run: inserted before the turn, finalized after it.
const createAgentRun = vi.fn();
const deleteAgentRun = vi.fn();
const finalizeAgentRun = vi.fn();
const markAgentRunDetached = vi.fn();
const getAgentRunById = vi.fn();
const requestAgentRunCancel = vi.fn();

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

async function buildApp() {
  return createFastifyApiTestApp(clientA2aApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
  limits.override = null;
  queuedStart.run = null;
  createAgentRun.mockImplementation(async (record: Record<string, unknown>) => ({ _id: 'run-1', ...record }));
  deleteAgentRun.mockResolvedValue(true);
  finalizeAgentRun.mockImplementation(async (_id: string, _tenant: string, patch: Record<string, unknown>) => ({
    _id: 'run-1', mode: 'inline', agentKey: 'support-bot', conversationId: 'conv-1', ...patch,
  }));
  markAgentRunDetached.mockImplementation(async () => ({
    _id: 'run-1', mode: 'inline', status: 'running', agentKey: 'support-bot', conversationId: 'conv-9', detachedAt: new Date(),
  }));
  getAgentRunById.mockResolvedValue(null);
  requestAgentRunCancel.mockResolvedValue(null);
  mockFn(getDatabase).mockResolvedValue(createMockDb({
    runWithTenant, createAgentRun, deleteAgentRun, finalizeAgentRun, markAgentRunDetached, getAgentRunById, requestAgentRunCancel,
  } as never));
  mockFn(getAgentByKey).mockResolvedValue(EXPOSED_AGENT);
  approval.ending.mockResolvedValue({ allowed: true });
  approval.cancelPending.mockResolvedValue(null);
});

describe('agent card', () => {
  it('404s for agents without the a2a exposure flag (same as missing)', async () => {
    mockFn(getAgentByKey).mockResolvedValue({ ...EXPOSED_AGENT, metadata: {} });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/a2a/support-bot/.well-known/agent-card.json',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('serves a spec-shaped card for an exposed agent', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/a2a/support-bot/.well-known/agent-card.json',
      headers: { authorization: 'Bearer tok', host: 'console.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(200);
    const card = parseJsonBody<Record<string, unknown>>(res.body);
    expect(card.protocolVersion).toBe('1.0');
    expect(card.name).toBe('Support Bot');
    expect(card.url).toBe('https://console.example.com/api/client/v1/a2a/support-bot');
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.version).toBe('3');
    expect((card.capabilities as { streaming: boolean }).streaming).toBe(true);
    expect((card.securitySchemes as Record<string, { scheme: string }>).bearer.scheme).toBe('bearer');
    expect((card.skills as Array<{ tags: string[] }>)[0].tags).toContain('lookup');
  });
});

describe('message/send', () => {
  it('creates a conversation, runs the agent, and returns a completed task', async () => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
    mockFn(executeAgentChat).mockResolvedValue({
      output: [
        { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there' }] },
      ],
      _conversation_messages: [{ role: 'user' }, { role: 'assistant' }],
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: {
        jsonrpc: '2.0',
        id: 7,
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text: 'Hello' }],
            metadata: { runtime_context: { headers: { 'X-Ext': 'v1' } } },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ id: number; result: Record<string, unknown> }>(res.body);
    expect(body.id).toBe(7);
    expect(body.result.kind).toBe('task');
    expect(body.result.contextId).toBe('conv-1');
    expect(body.result.id).toBe('run_run-1');
    expect((body.result.status as { state: string }).state).toBe('completed');
    const artifacts = body.result.artifacts as Array<{ parts: Array<{ text: string }> }>;
    expect(artifacts[0].parts[0].text).toBe('Hi there');

    const chatRequest = mockFn(executeAgentChat).mock.calls[0][0];
    expect(chatRequest.usePublished).toBe(true);
    expect(chatRequest.userMessage).toBe('Hello');
    expect(chatRequest.runtimeContext).toMatchObject({
      headers: { 'X-Ext': 'v1' },
      source: 'a2a',
      userId: 'user-1',
      tokenId: 'tok-1',
    });
    expect(createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'inline', channel: 'a2a', usePublished: true, apiTokenId: 'tok-1' }));
  });

  it('reports a turn that paused for an approval as input-required, with the pending actions', async () => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
    const actions = [{ id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', status: 'pending', requestedAt: 'now' }];
    mockFn(executeAgentChat).mockResolvedValue({
      status: 'requires_action',
      stop_reason: 'requires_action',
      required_action: { type: 'agent_actions', actions },
      output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }],
      _conversation_messages: [{ role: 'user' }, { role: 'assistant' }],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 8, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Run it' }] } } },
    });
    const body = parseJsonBody<{ result: Record<string, unknown> }>(res.body);
    expect((body.result.status as { state: string }).state).toBe('input-required');
    expect(body.result.metadata).toEqual({ stopReason: 'requires_action', pendingActions: actions });
    expect(body.result.id).toBe('run_run-1');
  });

  it('a message sent while the task waits on a person: the run fails, its task names the ids to answer', async () => {
    const { AgentPendingActionError } = await import('@/lib/services/agents/agentErrors');
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    mockFn(executeAgentChat).mockRejectedValue(new AgentPendingActionError(['act_1', 'act_2']));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 9, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Hi' }], contextId: 'conv-9' } } },
    });
    const body = parseJsonBody<{ result: { id: string; status: { state: string }; metadata: Record<string, unknown> } }>(res.body);
    expect(body.result.id).toBe('run_run-1');
    expect(body.result.status.state).toBe('failed');
    expect(body.result.metadata).toEqual({ errorType: 'pending_action', errorCode: 'pending_action', pending_action_ids: ['act_1', 'act_2'] });
  });

  it('reuses the conversation for a known contextId and rejects a foreign one', async () => {
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    mockFn(executeAgentChat).mockResolvedValue({
      output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'again' }] }],
      _conversation_messages: [{}, {}, {}, {}],
    });
    const app = await buildApp();
    const ok = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: { message: { parts: [{ kind: 'text', text: 'More' }], contextId: 'conv-9' } },
      },
    });
    expect(parseJsonBody<{ result: { contextId: string } }>(ok.body).result.contextId).toBe('conv-9');
    expect(mockFn(createConversation)).not.toHaveBeenCalled();

    mockFn(getConversationById).mockResolvedValue({ agentKey: 'other-agent', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'message/send',
        params: { message: { parts: [{ kind: 'text', text: 'More' }], contextId: 'conv-9' } },
      },
    });
    expect(parseJsonBody<{ error: { code: number } }>(bad.body).error.code).toBe(-32602);
  });
});

describe('message/send — a recorded run, one active turn per conversation', () => {
  it('inserts the inline run before the turn and finalizes it after (the row is kept, never deleted)', async () => {
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    mockFn(executeAgentChat).mockImplementation(async () => {
      // While the turn runs, the run holds the conversation and is not finalized yet.
      expect(createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'inline', conversationId: 'conv-9', status: 'running' }));
      expect(finalizeAgentRun).not.toHaveBeenCalled();
      return {
        output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        _conversation_messages: [{}, {}],
      };
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Hi' }], contextId: 'conv-9' } } },
    });

    expect(parseJsonBody<{ result: { contextId: string } }>(res.body).result.contextId).toBe('conv-9');
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'succeeded' }));
    expect(deleteAgentRun).not.toHaveBeenCalled();
  });

  it('REGRESSION: a conversation busy with another run (e.g. a background run) is refused with agent_run_conflict, never run concurrently', async () => {
    const { AgentRunConflictError } = await import('@/lib/database/provider/errors');
    createAgentRun.mockRejectedValue(new AgentRunConflictError('conv-9'));
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 5, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Hi' }], contextId: 'conv-9' } } },
    });

    const body = parseJsonBody<{ error: { code: number; data: { type: string; code: string } } }>(res.body);
    expect(body.error.data.type).toBe('agent_run_conflict');
    expect(body.error.data.code).toBe('agent_run_conflict');
    expect(mockFn(executeAgentChat)).not.toHaveBeenCalled();
  });

  it('a turn that throws is finalized failed and answered as its Task in state failed, with the error', async () => {
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    mockFn(executeAgentChat).mockRejectedValue(new Error('provider exploded'));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 6, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Hi' }], contextId: 'conv-9' } } },
    });

    const body = parseJsonBody<{ result: { kind: string; id: string; contextId: string; status: { state: string; message: { parts: Array<{ text: string }> } }; metadata: Record<string, unknown> } }>(res.body);
    expect(body.result).toMatchObject({ kind: 'task', id: 'run_run-1', contextId: 'conv-9', status: { state: 'failed' } });
    // The words the run row records and `tasks/get` reads back.
    expect(body.result.status.message.parts[0].text).toBe('The agent run failed. See the run trace for details.');
    expect(body.result.metadata).toMatchObject({ errorType: 'server_error', errorCode: 'agent_run_failed' });
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'failed', errorReason: 'agent_error' }));
  });

  describe('a failed run says what the run itself recorded, never the provider\'s own text', () => {
    // What an upstream fault carries: its endpoint, a deployment name and a request id.
    const UPSTREAM = 'upstream connect error: reset before headers at https://10.2.4.7:8443/openai/deployments/prod-gpt4o (request id req_9f3c1a)';
    const PUBLIC = 'The agent run failed. See the run trace for details.';
    const send = async () => {
      mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/client/v1/a2a/support-bot',
        headers: { authorization: 'Bearer tok' },
        payload: { jsonrpc: '2.0', id: 6, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Hi' }], contextId: 'conv-9' } } },
      });
      return { res, body: parseJsonBody<{ result: { id: string; status: { state: string; message: { parts: Array<{ text: string }> } }; metadata: Record<string, unknown> } }>(res.body) };
    };

    it('a provider fault (5xx): the task and the run carry the same public message; the provider text stays in the log', async () => {
      mockFn(executeAgentChat).mockRejectedValue(Object.assign(new Error(UPSTREAM), { status: 502 }));
      const { res, body } = await send();
      expect(body.result.status.state).toBe('failed');
      expect(body.result.status.message.parts[0].text).toBe(PUBLIC);
      expect(body.result.metadata).toMatchObject({ errorType: 'server_error', errorCode: 'provider_error' });
      for (const leaked of ['10.2.4.7', 'prod-gpt4o', 'req_9f3c1a', 'upstream connect']) expect(res.body).not.toContain(leaked);
      // The run row says the same, so tasks/get of this run reads what message/send answered.
      expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'failed', errorReason: 'agent_error', errorMessage: PUBLIC }));
    });

    it('a connection fault that names the provider\'s host answers the same public message', async () => {
      mockFn(executeAgentChat).mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED 10.2.4.7:8443'));
      const { res, body } = await send();
      expect(body.result.status.message.parts[0].text).toBe(PUBLIC);
      expect(res.body).not.toContain('10.2.4.7');
      expect(body.result.metadata).toMatchObject({ errorType: 'server_error', errorCode: expect.any(String) });
    });

    it('a failure the caller can act on keeps its message and code (here: the prompt does not fit the model)', async () => {
      mockFn(executeAgentChat).mockRejectedValue(Object.assign(
        new Error("This model's maximum context length is 128000 tokens. However, your messages resulted in 130114 tokens."),
        { status: 400, code: 'context_length_exceeded' },
      ));
      const { body } = await send();
      expect(body.result.status.message.parts[0].text).toContain('maximum context length is 128000 tokens');
      expect(body.result.metadata).toMatchObject({ errorType: 'invalid_request_error', errorCode: 'context_length_exceeded' });
    });

    it('a run ended elsewhere keeps its own retry message: it is the platform\'s, not the provider\'s', async () => {
      const { AgentRunInterruptedError } = await import('@/lib/services/agents/agentErrors');
      mockFn(executeAgentChat).mockRejectedValue(new AgentRunInterruptedError('worker_lost'));
      const { body } = await send();
      expect(body.result.status.message.parts[0].text).toBe('The agent run was stopped before it finished. It was not completed; retry it.');
      expect(body.result.metadata).toMatchObject({ errorCode: 'agent_run_interrupted', retryable: true });
    });
  });

  it('past the wait window the task comes back working, named by its run, and the run carries on', async () => {
    limits.override = { syncWaitMs: 30 };
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    let finish!: () => void;
    mockFn(executeAgentChat).mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ output: [], _conversation_messages: [] });
    }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 11, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Slow' }], contextId: 'conv-9' } } },
    });

    const body = parseJsonBody<{ result: { id: string; contextId: string; status: { state: string } } }>(res.body);
    expect(body.result).toMatchObject({ id: 'run_run-1', contextId: 'conv-9', status: { state: 'working' } });
    expect(markAgentRunDetached).toHaveBeenCalled();
    expect(finalizeAgentRun).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'succeeded' })));
  });
});

describe('tasks/get and tasks/cancel on run ids (run_<runId>)', () => {
  const rpc = async (method: string, id: string) => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 1, method, params: { id } },
    });
    return parseJsonBody<{ result?: Record<string, any>; error?: { code: number } }>(res.body);
  };
  const row = (overrides: Record<string, unknown>) => ({
    _id: 'run-1', mode: 'inline', agentKey: 'support-bot', conversationId: 'conv-9', tenantId: 'tenant-1', projectId: 'proj-1', ...overrides,
  });

  beforeEach(() => {
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
  });

  it.each([
    ['queued', 'submitted'], ['running', 'working'], ['failed', 'failed'], ['canceled', 'canceled'],
  ])('a %s run reads as %s', async (status, state) => {
    getAgentRunById.mockResolvedValue(row({ status, errorMessage: 'boom' }));
    const body = await rpc('tasks/get', 'run_run-1');
    expect(body.result).toMatchObject({ kind: 'task', id: 'run_run-1', contextId: 'conv-9', status: { state } });
    expect(getAgentRunById).toHaveBeenCalledWith('run-1', 'tenant-1', 'proj-1');
  });

  it('a finished run reads as its completed task, with the answer as the artifact', async () => {
    getAgentRunById.mockResolvedValue(row({
      status: 'succeeded',
      result: { status: 'completed', output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }] },
    }));
    const body = await rpc('tasks/get', 'run_run-1');
    expect(body.result!.status.state).toBe('completed');
    expect(body.result!.artifacts[0].parts[0].text).toBe('Done');
  });

  it('a run of another agent, or on a conversation the caller did not start, is TaskNotFound', async () => {
    getAgentRunById.mockResolvedValue(row({ status: 'running', agentKey: 'other-agent' }));
    expect((await rpc('tasks/get', 'run_run-1')).error?.code).toBe(-32001);

    getAgentRunById.mockResolvedValue(row({ status: 'running' }));
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'someone-else', messages: [] });
    expect((await rpc('tasks/get', 'run_run-1')).error?.code).toBe(-32001);
    expect((await rpc('tasks/cancel', 'run_run-1')).error?.code).toBe(-32001);
  });

  it('tasks/cancel cancels the run (cancelAgentRun): a queued one at once', async () => {
    getAgentRunById.mockResolvedValue(row({ mode: 'background', status: 'queued' }));
    requestAgentRunCancel.mockResolvedValue(row({ mode: 'background', status: 'canceled' }));
    const body = await rpc('tasks/cancel', 'run_run-1');
    expect(body.result).toMatchObject({ id: 'run_run-1', status: { state: 'canceled' } });
    expect(requestAgentRunCancel).toHaveBeenCalledWith('run-1', 'tenant-1', 'proj-1');
  });

  it('tasks/cancel of a finished run cannot cancel it (-32002 TaskNotCancelable)', async () => {
    getAgentRunById.mockResolvedValue(row({ status: 'succeeded' }));
    expect((await rpc('tasks/cancel', 'run_run-1')).error?.code).toBe(-32002);
  });
});

describe('tasks/get and unknown methods', () => {
  it('rebuilds a completed task from the conversation store', async () => {
    mockFn(getConversationById).mockResolvedValue({
      agentKey: 'support-bot',
      projectId: 'proj-1',
      createdBy: 'user-1',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: 'task_conv-1_1' } },
    });
    const body = parseJsonBody<{ result: Record<string, unknown> }>(res.body);
    expect((body.result.status as { state: string }).state).toBe('completed');
    expect((body.result.artifacts as Array<{ parts: Array<{ text: string }> }>)[0].parts[0].text)
      .toBe('Hi there');
  });

  it('tasks/get reports a message with an open request as input-required', async () => {
    const pending = [{ id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', status: 'pending' }];
    mockFn(getConversationById).mockResolvedValue({
      agentKey: 'support-bot',
      projectId: 'proj-1',
      createdBy: 'user-1',
      messages: [
        { role: 'user', content: 'Run it' },
        { role: 'assistant', content: '', stopReason: 'paused', pendingActions: pending },
      ],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: 'task_conv-1_1' } },
    });
    const body = parseJsonBody<{ result: Record<string, unknown> }>(res.body);
    expect((body.result.status as { state: string }).state).toBe('input-required');
    expect((body.result.metadata as { pendingActions: unknown[] }).pendingActions).toEqual([
      { id: 'act_1', kind: 'tool_approval', tool_name: 'sandbox_exec', status: 'pending' },
    ]);
  });

  it('tasks/cancel on a task waiting for a person says how to end the wait, with the ids', async () => {
    const pending = [
      { id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', status: 'pending' },
      { id: 'act_2', kind: 'user_question', status: 'resolved' },
    ];
    mockFn(getConversationById).mockResolvedValue({
      agentKey: 'support-bot',
      projectId: 'proj-1',
      createdBy: 'user-1',
      messages: [
        { role: 'user', content: 'Run it' },
        { role: 'assistant', content: '', stopReason: 'paused', pendingActions: pending },
      ],
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 10, method: 'tasks/cancel', params: { id: 'task_conv-1_1' } },
    });
    const body = parseJsonBody<{ error: { code: number; message: string; data: Record<string, unknown> } }>(res.body);
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toContain('waiting for an approval or an answer');
    expect(body.error.message).not.toContain('synchronously');
    expect(body.error.data).toEqual({ pending_action_ids: ['act_1'] });
  });

  describe('ending a task that waits on a person is answering it with "no": the policy engine says whether the caller may', () => {
    const waiting = {
      _id: 'conv-1', agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', runtimeStatus: 'requires_action',
      messages: [
        { role: 'user', content: 'Run it' },
        { role: 'assistant', content: '', stopReason: 'paused', pendingActions: [{ id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', status: 'pending' }] },
      ],
    };
    const rpc = (method: string, params: Record<string, unknown>) => ({
      method: 'POST' as const, url: '/api/client/v1/a2a/support-bot', headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 20, method, params },
    });

    it('tasks/cancel is refused (-32010, with the decision id and the ids) for a caller the engine does not let answer', async () => {
      mockFn(getConversationById).mockResolvedValue(waiting);
      approval.ending.mockResolvedValue({ allowed: false, decisionId: 'dec-1' });
      const app = await buildApp();
      const res = await app.inject(rpc('tasks/cancel', { id: 'task_conv-1_1' }));
      const body = parseJsonBody<{ error: { code: number; data: Record<string, unknown> } }>(res.body);
      expect(body.error.code).toBe(-32010);
      expect(body.error.data).toEqual({ pending_action_ids: ['act_1'], decision_id: 'dec-1' });
      expect(approval.ending).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        tenantDbName: 'tenant_acme', conversation: expect.objectContaining({ _id: 'conv-1' }), agent: expect.objectContaining({ key: 'support-bot' }),
      }));
    });

    it('tasks/cancel keeps its answer (-32002: nothing to stop, answer through the actions endpoint) for a caller who may answer', async () => {
      mockFn(getConversationById).mockResolvedValue(waiting);
      const app = await buildApp();
      const res = await app.inject(rpc('tasks/cancel', { id: 'task_conv-1_1' }));
      expect(parseJsonBody<{ error: { code: number } }>(res.body).error.code).toBe(-32002);
    });

    it('a message that would cancel the open request (cancel_pending) is refused for a caller who may not answer it', async () => {
      mockFn(getConversationById).mockResolvedValue(waiting);
      approval.cancelPending.mockResolvedValue({ decisionId: 'dec-2' });
      const app = await buildApp();
      const res = await app.inject(rpc('message/send', { message: { parts: [{ kind: 'text', text: 'never mind' }], contextId: 'conv-1' } }));
      const body = parseJsonBody<{ error: { code: number; message: string; data: Record<string, unknown> } }>(res.body);
      expect(body.error.code).toBe(-32010);
      expect(body.error.message).toContain('would cancel');
      expect(body.error.data).toEqual({ decision_id: 'dec-2' });
      expect(mockFn(executeAgentChat)).not.toHaveBeenCalled();
      expect(approval.cancelPending).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        tenantDbName: 'tenant_acme', conversation: expect.objectContaining({ _id: 'conv-1' }), agent: expect.objectContaining({ key: 'support-bot' }),
      }));
    });

    it('a first message (no contextId) asks nothing', async () => {
      mockFn(createConversation).mockResolvedValue({ _id: 'conv-2' });
      mockFn(executeAgentChat).mockResolvedValue({
        output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
        _conversation_messages: [{}, {}],
      });
      const app = await buildApp();
      await app.inject(rpc('message/send', { message: { parts: [{ kind: 'text', text: 'hello' }] } }));
      expect(approval.cancelPending).not.toHaveBeenCalled();
    });
  });

  it('tasks/cancel on a finished or unknown task does not claim anything is pending', async () => {
    mockFn(getConversationById).mockResolvedValue({
      agentKey: 'support-bot',
      projectId: 'proj-1',
      createdBy: 'user-1',
      messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there' }],
    });
    const app = await buildApp();
    for (const id of ['task_conv-1_1', 'nonsense']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/client/v1/a2a/support-bot',
        headers: { authorization: 'Bearer tok' },
        payload: { jsonrpc: '2.0', id: 11, method: 'tasks/cancel', params: { id } },
      });
      const body = parseJsonBody<{ error: { code: number; message: string; data?: unknown } }>(res.body);
      expect(body.error.code).toBe(-32002);
      expect(body.error.message).toContain('cannot be canceled');
      expect(body.error.message).not.toContain('synchronously');
      expect(body.error.data).toBeUndefined();
    }
  });

  it('returns TaskNotFound (-32001) for unknown ids and -32601 for unknown methods', async () => {
    mockFn(getConversationById).mockResolvedValue(null);
    const app = await buildApp();
    const missing = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: 'task_x_0' } },
    });
    expect(parseJsonBody<{ error: { code: number } }>(missing.body).error.code).toBe(-32001);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 5, method: 'tasks/pushNotificationConfig/set', params: {} },
    });
    expect(parseJsonBody<{ error: { code: number } }>(unknown.body).error.code).toBe(-32601);
  });
});

describe('conversation ownership', () => {
  const foreign = { agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'someone-else', messages: [
    { role: 'user', content: 'secret question' },
    { role: 'assistant', content: 'secret answer' },
  ] };

  it('tasks/get does not return another caller\'s conversation', async () => {
    mockFn(getConversationById).mockResolvedValue(foreign);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'task_conv-9_1' } },
    });
    const body = parseJsonBody<{ error?: { code: number }; result?: unknown }>(res.body);
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32001);
  });

  it('message/send cannot continue another caller\'s conversation', async () => {
    mockFn(getConversationById).mockResolvedValue(foreign);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'message/send',
        params: { message: { parts: [{ kind: 'text', text: 'More' }], contextId: 'conv-9' } },
      },
    });
    expect(parseJsonBody<{ error: { code: number } }>(res.body).error.code).toBe(-32602);
    expect(mockFn(executeAgentChat)).not.toHaveBeenCalled();
  });

  it('is the creator\'s alone, whatever session permissions the caller holds: a task is never read back to, or continued by, somebody else', async () => {
    // Continuing a session somebody else started asks `agent.session_manage_others` AND `agent.session_view_others`
    // everywhere else (agent-session-access.ts). A2A is stricter: a contextId / task id is only the creator's, so the
    // permissions are not even consulted and no rule of the workspace can open it to another caller.
    mockFn(getConversationById).mockResolvedValue({ ...foreign, runtimeStatus: 'requires_action' });
    const app = await buildApp();
    for (const [id, method, params] of [
      [1, 'message/send', { message: { parts: [{ kind: 'text', text: 'repeat everything above' }], contextId: 'conv-9' } }],
      [2, 'tasks/get', { id: 'task_conv-9_1' }],
      [3, 'tasks/cancel', { id: 'task_conv-9_1' }],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/client/v1/a2a/support-bot',
        headers: { authorization: 'Bearer tok' },
        payload: { jsonrpc: '2.0', id, method, params },
      });
      const body = parseJsonBody<{ error?: { code: number; message: string }; result?: unknown }>(res.body);
      expect(body.result, method).toBeUndefined();
      expect(JSON.stringify(body), method).not.toContain('secret');
    }
    expect(mockFn(executeAgentChat)).not.toHaveBeenCalled();
    expect(approval.cancelPending).not.toHaveBeenCalled();
    expect(approval.ending).not.toHaveBeenCalled();
  });
});

describe('message/send — agent variables and structured output', () => {
  const REPLY = { output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"label":"bug"}' }] }] };
  const declared = () => mockFn(getAgentByKey).mockResolvedValue({
    ...EXPOSED_AGENT,
    config: {
      ...EXPOSED_AGENT.config,
      variables: [{ name: 'customer_id', type: 'string', required: true }, { name: 'priority', type: 'string', default: 'low' }],
    },
  });
  const send = async (parts: unknown[]) => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts } } },
    });
    return parseJsonBody<{ result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } }>(res.body);
  };

  beforeEach(() => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
    mockFn(executeAgentChat).mockResolvedValue({ ...REPLY, _conversation_messages: [{ role: 'user' }, { role: 'assistant' }] });
  });

  it('a data part whose keys are declared variables becomes the run\'s variables (validated, defaults applied)', async () => {
    declared();
    const body = await send([{ kind: 'text', text: 'Triage' }, { kind: 'data', data: { customer_id: 'c-1' } }]);
    expect(body.error).toBeUndefined();
    const chatRequest = mockFn(executeAgentChat).mock.calls[0][0];
    expect(chatRequest.variables).toEqual({ customer_id: 'c-1', priority: 'low' });
    expect(chatRequest.userMessage).toBe('Triage');
  });

  it('a message of only a data part is a valid turn', async () => {
    declared();
    const body = await send([{ kind: 'data', data: { customer_id: 'c-2', priority: 'high' } }]);
    expect(body.error).toBeUndefined();
    expect(mockFn(executeAgentChat).mock.calls[0][0]).toMatchObject({ userMessage: '', variables: { customer_id: 'c-2', priority: 'high' } });
  });

  it('invalid variables are -32602 with errors[]; nothing runs', async () => {
    declared();
    const body = await send([{ kind: 'text', text: 'Triage' }, { kind: 'data', data: { customer_id: 7 } }]);
    expect(body.error).toMatchObject({ code: -32602, data: { code: 'invalid_variables', errors: [{ field: 'customer_id', message: 'Must be a string' }] } });
    const missing = await send([{ kind: 'text', text: 'Triage' }]);
    expect(missing.error?.data).toMatchObject({ errors: [{ field: 'customer_id', message: 'Required' }] });
    expect(executeAgentChat).not.toHaveBeenCalled();
  });

  it('data that is not a variable is appended to the text as a JSON block, and the declared variables stay apart', async () => {
    declared();
    await send([
      { kind: 'text', text: 'Triage' },
      { kind: 'data', data: { customer_id: 'c-1' } },
      { kind: 'data', data: { ticket: { id: 12 }, note: 'a`b' } },
    ]);
    const chatRequest = mockFn(executeAgentChat).mock.calls[0][0];
    expect(chatRequest.variables).toEqual({ customer_id: 'c-1', priority: 'low' });
    expect(chatRequest.userMessage).toMatch(/^Triage\n\nData:\n```json\n/);
    expect(chatRequest.userMessage).toContain('"id": 12');
    expect(chatRequest.userMessage.match(/```/g)).toHaveLength(2);
  });

  it('an agent that declares no variables reads any data part as plain data', async () => {
    const body = await send([{ kind: 'text', text: 'Hi' }, { kind: 'data', data: { a: 1 } }]);
    expect(body.error).toBeUndefined();
    const chatRequest = mockFn(executeAgentChat).mock.calls[0][0];
    expect(chatRequest.variables).toBeUndefined();
    expect(chatRequest.userMessage).toContain('Data:\n```json');
  });

  it('a structured answer comes back as a data artifact next to the text one', async () => {
    mockFn(executeAgentChat).mockResolvedValue({ ...REPLY, output_parsed: { label: 'bug', score: 2 }, _conversation_messages: [{}, {}] });
    const body = await send([{ kind: 'text', text: 'Triage' }]);
    const artifacts = body.result!.artifacts as Array<{ artifactId: string; name: string; parts: Array<Record<string, unknown>> }>;
    expect(artifacts.map((a) => a.name)).toEqual(['response', 'output']);
    expect(artifacts[1]).toMatchObject({ artifactId: 'run_run-1_data', parts: [{ kind: 'data', data: { label: 'bug', score: 2 } }] });
  });

  it('a failed contract is reported in metadata.outputError, with no data artifact', async () => {
    mockFn(executeAgentChat).mockResolvedValue({ ...REPLY, output_error: 'label is required', _conversation_messages: [{}, {}] });
    const body = await send([{ kind: 'text', text: 'Triage' }]);
    expect(body.result!.metadata).toEqual({ outputError: 'label is required' });
    expect((body.result!.artifacts as unknown[]).length).toBe(1);
  });

  it('tasks/get on a finished run carries the data artifact too', async () => {
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    getAgentRunById.mockResolvedValue({
      _id: 'run-5', mode: 'inline', status: 'succeeded', agentKey: 'support-bot', projectId: 'proj-1', tenantId: 'tenant-1', conversationId: 'conv-1',
      result: { ...REPLY, output_parsed: { label: 'ok' } },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'run_run-5' } },
    });
    const body = parseJsonBody<{ result: { artifacts: Array<{ name: string; parts: Array<{ data?: unknown }> }> } }>(res.body);
    expect(body.result.artifacts.map((a) => a.name)).toEqual(['response', 'output']);
    expect(body.result.artifacts[1].parts[0].data).toEqual({ label: 'ok' });
  });
});

describe('agent card — modes', () => {
  const card = async (agent: Record<string, unknown>) => {
    mockFn(getAgentByKey).mockResolvedValue(agent);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/a2a/support-bot/.well-known/agent-card.json', headers: { authorization: 'Bearer tok' } });
    return parseJsonBody<{ defaultInputModes: string[]; defaultOutputModes: string[]; capabilities: { streaming: boolean }; skills: Array<{ inputModes: string[]; outputModes: string[] }> }>(res.body);
  };

  it('takes text and JSON, and gives text and JSON', async () => {
    const body = await card(EXPOSED_AGENT);
    expect(body.capabilities.streaming).toBe(true);
    expect(body.defaultInputModes).toEqual(['text/plain', 'application/json']);
    expect(body.defaultOutputModes).toEqual(['text/plain', 'application/json']);
    expect(body.skills[0]).toMatchObject({ inputModes: body.defaultInputModes, outputModes: body.defaultOutputModes });
  });

  it('adds the file types the agent accepts once attachments are enabled', async () => {
    const withTypes = await card({ ...EXPOSED_AGENT, config: { attachments: { enabled: true, bucketKey: 'files', allowedMimeTypes: ['application/pdf', 'image/*'] } } });
    expect(withTypes.defaultInputModes).toEqual(['text/plain', 'application/json', 'application/pdf', 'image/*']);
    const anyType = await card({ ...EXPOSED_AGENT, config: { attachments: { enabled: true, bucketKey: 'files' } } });
    expect(anyType.defaultInputModes).toEqual(['text/plain', 'application/json', '*/*']);
    const off = await card({ ...EXPOSED_AGENT, config: { attachments: { enabled: true, allowedMimeTypes: ['application/pdf'] } } });
    expect(off.defaultInputModes).toEqual(['text/plain', 'application/json']);
  });
});

describe('message/stream', () => {
  const ANSWER = (text: string, extra: Record<string, unknown> = {}) => ({
    output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    _conversation_messages: [{}, {}],
    ...extra,
  });
  type Evt = Record<string, any>;
  const parseEvents = (body: string): Evt[] => body.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => {
    const frame = JSON.parse(chunk.slice('data: '.length));
    expect(frame).toMatchObject({ jsonrpc: '2.0', id: 3 });
    return frame.result;
  });
  const summary = (events: Evt[]) => events.map((e) => (e.kind === 'status-update' ? `status:${e.status.state}${e.final ? ':final' : ''}`
    : e.kind === 'artifact-update' ? `artifact:${e.artifact.name ?? e.artifact.artifactId}${e.append ? ':append' : ''}${e.lastChunk ? ':last' : ''}` : e.kind));
  const stream = async (parts: unknown[] = [{ kind: 'text', text: 'Hello' }], agent: Record<string, unknown> = EXPOSED_AGENT) => {
    mockFn(getAgentByKey).mockResolvedValue(agent);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 3, method: 'message/stream', params: { message: { role: 'user', parts } } },
    });
    return res;
  };

  beforeEach(() => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
  });

  it('opens with the Task, then working, streams the text as artifact chunks and closes with a completed status', async () => {
    mockFn(executeAgentChat).mockImplementation(async (request: { onTextChunk: (t: string) => void }) => {
      request.onTextChunk('Hel');
      request.onTextChunk('lo');
      return ANSWER('Hello');
    });
    const res = await stream();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = parseEvents(res.body);
    expect(summary(events)).toEqual([
      'task', 'status:working', 'artifact:response', 'artifact:response:append', 'artifact:response:append:last', 'status:completed:final',
    ]);
    expect(events[0]).toMatchObject({ id: 'run_run-1', contextId: 'conv-1', status: { state: 'submitted' } });
    expect(events.slice(1).every((e) => e.taskId === 'run_run-1' && e.contextId === 'conv-1')).toBe(true);
    expect(events.filter((e) => e.kind === 'artifact-update').map((e) => e.artifact.parts[0].text)).toEqual(['Hel', 'lo', '']);
    expect(createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'inline', channel: 'a2a' }));
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'succeeded' }));
  });

  it('a model that does not stream still gets its answer as one closed artifact', async () => {
    mockFn(executeAgentChat).mockResolvedValue(ANSWER('All at once'));
    const events = parseEvents((await stream()).body);
    expect(summary(events)).toEqual(['task', 'status:working', 'artifact:response:last', 'status:completed:final']);
    expect(events[2].artifact.parts[0].text).toBe('All at once');
  });

  it('closes with the files and the structured answer as artifacts, and what the run stopped on', async () => {
    mockFn(executeAgentChat).mockImplementation(async (request: { onTextChunk: (t: string) => void }) => {
      request.onTextChunk('{"label":"bug"}');
      return ANSWER('{"label":"bug"}', {
        output_parsed: { label: 'bug' },
        output_files: [{ id: 'f1', name: 'report.md', mime_type: 'text/markdown', size: 12, download_url: '/client/v1/agents/sessions/conv-1/files/f1/content' }],
        stop_reason: 'max_tokens',
        stop_detail: 'The answer was cut off.',
      });
    });
    const events = parseEvents((await stream()).body);
    expect(summary(events)).toEqual([
      'task', 'status:working', 'artifact:response', 'artifact:response:append:last', 'artifact:output:last', 'artifact:report.md:last', 'status:completed:final',
    ]);
    expect(events[4].artifact.parts[0]).toEqual({ kind: 'data', data: { label: 'bug' } });
    expect(events[5].artifact.parts[0].file).toMatchObject({ name: 'report.md', mimeType: 'text/markdown' });
    expect(events[6].metadata).toMatchObject({ stopReason: 'max_tokens' });
  });

  it('a turn that waits for a person ends the stream input-required, with the actions to answer', async () => {
    mockFn(executeAgentChat).mockResolvedValue(ANSWER('May I?', {
      status: 'requires_action',
      required_action: { type: 'tool_approval', actions: [{ id: 'act-1', tool_name: 'send_email' }] },
    }));
    const events = parseEvents((await stream()).body);
    expect(summary(events).slice(-2)).toEqual(['artifact:response:last', 'status:input-required:final']);
    expect(events[events.length - 1].metadata).toMatchObject({ stopReason: 'requires_action', pendingActions: [{ id: 'act-1' }] });
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'requires_action' }));
  });

  it('a turn that fails after the stream opened ends it failed, with the public message', async () => {
    mockFn(executeAgentChat).mockImplementation(async (request: { onTextChunk: (t: string) => void }) => {
      request.onTextChunk('Part');
      throw new Error('upstream exploded');
    });
    const res = await stream();
    expect(res.statusCode).toBe(200);
    const events = parseEvents(res.body);
    const last = events[events.length - 1];
    expect(summary(events)).toEqual(['task', 'status:working', 'artifact:response', 'status:failed:final']);
    expect(last.status.message.parts[0].text).not.toContain('upstream exploded');
    expect(last.status.message.parts[0].text.length).toBeGreaterThan(0);
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'failed' }));
  });

  it('a provider fault after the stream opened ends it failed with the run\'s public message, not the provider\'s text', async () => {
    mockFn(executeAgentChat).mockImplementation(async (request: { onTextChunk: (t: string) => void }) => {
      request.onTextChunk('Part');
      throw Object.assign(new Error('upstream connect error at https://10.2.4.7:8443/openai/deployments/prod-gpt4o (request id req_9f3c1a)'), { status: 502 });
    });
    const res = await stream();
    const events = parseEvents(res.body);
    const last = events[events.length - 1];
    expect(summary(events)).toEqual(['task', 'status:working', 'artifact:response', 'status:failed:final']);
    expect(last.status.message.parts[0].text).toBe('The agent run failed. See the run trace for details.');
    expect(last.metadata).toMatchObject({ errorType: 'server_error', errorCode: 'provider_error' });
    for (const leaked of ['10.2.4.7', 'prod-gpt4o', 'req_9f3c1a']) expect(res.body).not.toContain(leaked);
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({
      status: 'failed', errorMessage: 'The agent run failed. See the run trace for details.',
    }));
  });

  it('a stopped turn ends the stream canceled', async () => {
    mockFn(executeAgentChat).mockImplementation(async (request: { onTextChunk: (t: string) => void }) => {
      request.onTextChunk('Half');
      abortLocalTurns('tenant-1', 'conv-1');
      return ANSWER('Half');
    });
    const events = parseEvents((await stream()).body);
    expect(summary(events)).toEqual(['task', 'status:working', 'artifact:response', 'artifact:response:append:last', 'status:canceled:final']);
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'canceled' }));
  });

  it('a refusal before the run starts is a plain JSON-RPC error, not a stream', async () => {
    mockFn(createAgentRun).mockRejectedValue(new AgentRunConflictError('busy'));
    const res = await stream();
    expect(res.headers['content-type']).toContain('application/json');
    expect(parseJsonBody<{ error: { code: number; data: { code: string } } }>(res.body).error).toMatchObject({ code: -32603, data: { code: 'agent_run_conflict' } });
    expect(executeAgentChat).not.toHaveBeenCalled();
  });

  it('declared variables and data parts reach the run like they do on message/send', async () => {
    mockFn(executeAgentChat).mockResolvedValue(ANSWER('ok'));
    await stream(
      [{ kind: 'text', text: 'Triage' }, { kind: 'data', data: { customer_id: 'c-1' } }],
      { ...EXPOSED_AGENT, config: { variables: [{ name: 'customer_id', type: 'string', required: true }] } },
    );
    expect(mockFn(executeAgentChat).mock.calls[0][0]).toMatchObject({ userMessage: 'Triage', variables: { customer_id: 'c-1' } });
  });

  it('the client going away leaves the run going: it detaches and completes', async () => {
    let finishTurn!: () => void;
    mockFn(executeAgentChat).mockImplementation(async (request: { onTextChunk: (t: string) => void }) => {
      request.onTextChunk('Working');
      await new Promise<void>((resolve) => { finishTurn = resolve; });
      return ANSWER('Working on it');
    });
    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/client/v1/a2a/support-bot`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'message/stream', params: { message: { parts: [{ kind: 'text', text: 'Hi' }] } } }),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"task"');
    controller.abort();
    await vi.waitFor(() => expect(markAgentRunDetached).toHaveBeenCalledWith('run-1', 'tenant-1', expect.any(Date)));
    expect(requestAgentRunCancel).not.toHaveBeenCalled();
    finishTurn();
    await vi.waitFor(() => expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'succeeded' })));
    await app.close();
  });
});

describe('tasks/resubscribe', () => {
  type Evt = Record<string, any>;
  const resubscribe = async (id: string) => {
    const app = await buildApp();
    return app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 7, method: 'tasks/resubscribe', params: { id } },
    });
  };
  const eventsOf = (body: string): Evt[] => body.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => {
    const frame = JSON.parse(chunk.slice('data: '.length));
    expect(frame).toMatchObject({ jsonrpc: '2.0', id: 7 });
    return frame.result;
  });
  const summary = (events: Evt[]) => events.map((e) => (e.kind === 'status-update' ? `status:${e.status.state}${e.final ? ':final' : ''}`
    : e.kind === 'artifact-update' ? `artifact:${e.artifact.name ?? e.artifact.artifactId}${e.append ? ':append' : ''}${e.lastChunk ? ':last' : ''}` : e.kind));
  const row = (overrides: Record<string, unknown>) => ({
    _id: 'run-1', mode: 'inline', agentKey: 'support-bot', conversationId: 'conv-9', tenantId: 'tenant-1', projectId: 'proj-1', ...overrides,
  });
  const DONE = {
    status: 'completed',
    output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
  };
  const listAgentSessionEvents = vi.fn();
  const getAgentSessionMaxSeq = vi.fn();

  beforeEach(() => {
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    listAgentSessionEvents.mockResolvedValue([]);
    getAgentSessionMaxSeq.mockResolvedValue(4);
    mockFn(getDatabase).mockResolvedValue(createMockDb({
      runWithTenant, getAgentRunById, listAgentSessionEvents, getAgentSessionMaxSeq,
    } as never));
  });

  it('a running task: the Task, then what the run writes next, and its end as artifacts and the final status', async () => {
    let reads = 0;
    getAgentRunById.mockImplementation(async () => {
      reads += 1;
      // 1: the lookup, 2: the first poll (the follower is subscribed by now), 3: the run has ended.
      if (reads === 2) {
        setTimeout(() => {
          const at = new Date().toISOString();
          sessionEventBus.publish('conv-9', { seq: 5, type: 'session.status_running', data: {}, runId: 'run-1', createdAt: at });
          sessionEventBus.publish('conv-9', { type: 'agent.message.delta', data: { text: 'Hel' }, runId: 'run-1', createdAt: at });
          // Another run of the session is not this task.
          sessionEventBus.publish('conv-9', { type: 'agent.message.delta', data: { text: 'other' }, runId: 'run-2', createdAt: at });
          sessionEventBus.publish('conv-9', { type: 'agent.message.delta', data: { text: 'lo' }, runId: 'run-1', createdAt: at });
        }, 20);
      }
      return reads < 3 ? row({ status: 'running' }) : row({ status: 'succeeded', result: DONE });
    });
    const res = await resubscribe('run_run-1');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = eventsOf(res.body);
    expect(summary(events)).toEqual([
      'task', 'status:working', 'artifact:response', 'artifact:response:append', 'artifact:response:last', 'status:completed:final',
    ]);
    expect(events[0]).toMatchObject({ kind: 'task', id: 'run_run-1', contextId: 'conv-9', status: { state: 'working' } });
    expect(events.filter((e) => e.kind === 'artifact-update').map((e) => e.artifact.parts[0].text)).toEqual(['Hel', 'lo', 'Hello']);
    expect(events.slice(1).every((e) => e.taskId === 'run_run-1' && e.contextId === 'conv-9')).toBe(true);
    // Followed from the session event log, after the newest event stored when it attached.
    expect(listAgentSessionEvents).toHaveBeenCalledWith('conv-9', expect.objectContaining({ afterSeq: 4, runId: 'run-1' }));
  });

  it('a finished task: its Task and the final status event at once', async () => {
    getAgentRunById.mockResolvedValue(row({ status: 'succeeded', result: DONE }));
    const events = eventsOf((await resubscribe('run_run-1')).body);
    expect(summary(events)).toEqual(['task', 'status:completed:final']);
    expect(events[0].artifacts[0].parts[0].text).toBe('Hello');
    expect(getAgentSessionMaxSeq).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'failed'], ['canceled', 'canceled'], ['requires_action', 'input-required'],
  ])('a %s run ends at once with its %s final status', async (status, state) => {
    getAgentRunById.mockResolvedValue(row({ status, errorMessage: 'boom', result: status === 'requires_action' ? { status: 'requires_action', output: [] } : null }));
    expect(summary(eventsOf((await resubscribe('run_run-1')).body))).toEqual(['task', `status:${state}:final`]);
  });

  it('a task id from before runs (task_<conversation>_<index>) resolves like tasks/get', async () => {
    mockFn(getConversationById).mockResolvedValue({
      agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Earlier answer' }],
    });
    const events = eventsOf((await resubscribe('task_conv-9_1')).body);
    expect(summary(events)).toEqual(['task', 'status:completed:final']);
    expect(events[0]).toMatchObject({ id: 'task_conv-9_1', artifacts: [{ parts: [{ text: 'Earlier answer' }] }] });
  });

  it('an unknown task, or one the caller may not read, is TaskNotFound (-32001) as plain JSON', async () => {
    getAgentRunById.mockResolvedValue(null);
    for (const id of ['run_missing', 'bogus', '']) {
      const res = await resubscribe(id);
      expect(res.headers['content-type']).toContain('application/json');
      expect(parseJsonBody<{ error: { code: number } }>(res.body).error.code).toBe(-32001);
    }
    getAgentRunById.mockResolvedValue(row({ status: 'running' }));
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'someone-else', messages: [] });
    expect(parseJsonBody<{ error: { code: number } }>((await resubscribe('run_run-1')).body).error.code).toBe(-32001);
  });
});

describe('message/send — configuration.blocking', () => {
  const send = async (configuration?: Record<string, unknown>) => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'Later' }] }, ...(configuration ? { configuration } : {}) } },
    });
    return parseJsonBody<{ result?: Record<string, any>; error?: { code: number } }>(res.body);
  };

  beforeEach(() => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
  });

  it('blocking:false queues the run and answers with its submitted task; tasks/get follows it', async () => {
    const queued = { _id: 'run-7', mode: 'background', status: 'queued', agentKey: 'support-bot', conversationId: 'conv-1', projectId: 'proj-1', tenantId: 'tenant-1' };
    queuedStart.run = vi.fn(async () => ({ kind: 'accepted', run: queued }));
    const body = await send({ blocking: false });
    expect(body.result).toMatchObject({ kind: 'task', id: 'run_run-7', contextId: 'conv-1', status: { state: 'submitted' } });
    expect(queuedStart.run).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'a2a', usePublished: true, userMessage: 'Later', conversationId: 'conv-1', execution: { kind: 'queued' },
    }));
    expect(executeAgentChat).not.toHaveBeenCalled();

    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    getAgentRunById.mockResolvedValue({ ...queued, status: 'running' });
    const app = await buildApp();
    const polled = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'run_run-7' } },
    });
    expect(parseJsonBody<{ result: Record<string, any> }>(polled.body).result).toMatchObject({ id: 'run_run-7', status: { state: 'working' } });
    getAgentRunById.mockResolvedValue({ ...queued, status: 'succeeded', result: { output: [{ type: 'message', content: [{ text: 'Done' }] }] } });
    const done = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'run_run-7' } },
    });
    expect(parseJsonBody<{ result: Record<string, any> }>(done.body).result).toMatchObject({ status: { state: 'completed' }, artifacts: [{ parts: [{ text: 'Done' }] }] });
  });

  it('blocking:true (and no configuration) waits for the answer', async () => {
    mockFn(executeAgentChat).mockResolvedValue({ output: [], _conversation_messages: [{}, {}] });
    for (const configuration of [undefined, { blocking: true }]) {
      const body = await send(configuration);
      expect(body.result).toMatchObject({ status: { state: 'completed' } });
    }
    expect(createAgentRun).toHaveBeenCalledTimes(2);
  });

  it('a queued turn over a spent tenant limit is refused before a session is created', async () => {
    queuedStart.run = vi.fn();
    mockFn(getDatabase).mockResolvedValue(createMockDb({
      runWithTenant, findAgentByKey: vi.fn(async () => ({ key: 'support-bot', config: { modelKey: 'm1' } })),
    } as never));
    // The spend gate itself is tested with the agent spend limits; here only that the A2A surface asks it first.
    vi.spyOn(spendLimits, 'assertQueuedTurnSpendAllowed').mockRejectedValueOnce(new Error('limit reached'));
    const body = await send({ blocking: false });
    expect(body.error?.code).toBe(-32603);
    expect(createConversation).not.toHaveBeenCalled();
    expect(queuedStart.run).not.toHaveBeenCalled();
  });
});

describe('message/send — file parts', () => {
  const FILE_AGENT = { ...EXPOSED_AGENT, config: { attachments: { enabled: true, bucketKey: 'files' } } };
  const send = async (parts: unknown[], agent: Record<string, unknown> = FILE_AGENT) => {
    mockFn(getAgentByKey).mockResolvedValue(agent);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts } } },
    });
    return parseJsonBody<{ result?: Record<string, any>; error?: { code: number; message: string; data?: Record<string, any> } }>(res.body);
  };

  beforeEach(() => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
    mockFn(executeAgentChat).mockResolvedValue({ output: [], _conversation_messages: [{}, {}] });
    files.upload.mockResolvedValue({ id: 'file-1' });
  });

  it('inline bytes become a file of the session, and the turn attaches it', async () => {
    const body = await send([
      { kind: 'text', text: 'Read this' },
      { kind: 'file', file: { bytes: Buffer.from('hello').toString('base64'), name: 'a.txt', mimeType: 'text/plain' } },
    ]);
    expect(body.error).toBeUndefined();
    expect(files.upload).toHaveBeenCalledWith(expect.objectContaining({
      fileName: 'a.txt',
      contentType: 'text/plain',
      data: Buffer.from('hello').toString('base64'),
      conversation: { _id: 'conv-1', agentKey: 'support-bot' },
      actor: { userId: 'user-1', licenseType: 'STARTER', tokenId: 'tok-1' },
    }));
    expect(mockFn(executeAgentChat).mock.calls[0][0]).toMatchObject({ userMessage: 'Read this', attachments: ['file-1'] });
  });

  it('a uri is fetched through the outbound guard and stored; a message of only a file is a turn', async () => {
    files.fetch.mockResolvedValue(new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }));
    const body = await send([{ kind: 'file', file: { uri: 'https://files.example.com/docs/report.pdf' } }]);
    expect(body.error).toBeUndefined();
    expect(files.fetch).toHaveBeenCalledWith('https://files.example.com/docs/report.pdf', expect.objectContaining({ method: 'GET' }), expect.anything());
    expect(files.upload).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'report.pdf', contentType: 'application/pdf' }));
    expect(Buffer.isBuffer(files.upload.mock.calls[0][0].data)).toBe(true);
    expect(mockFn(executeAgentChat).mock.calls[0][0]).toMatchObject({ userMessage: '', attachments: ['file-1'] });
  });

  it('a uri that is not http(s) is invalid params; nothing is fetched or run', async () => {
    const body = await send([{ kind: 'file', file: { uri: 'file:///etc/passwd' } }]);
    expect(body.error).toMatchObject({ code: -32602, data: { code: 'invalid_file_url' } });
    expect(files.fetch).not.toHaveBeenCalled();
    expect(executeAgentChat).not.toHaveBeenCalled();
  });

  it('an agent that takes no files refuses them before a session is created', async () => {
    const body = await send([{ kind: 'text', text: 'Hi' }, { kind: 'file', file: { bytes: 'aGk=', name: 'a.txt' } }], EXPOSED_AGENT);
    expect(body.error).toMatchObject({ code: -32602, data: { code: 'attachments_disabled' } });
    expect(createConversation).not.toHaveBeenCalled();
    expect(executeAgentChat).not.toHaveBeenCalled();
  });

  it('a file the agent limits refuse is invalid params with the limit named', async () => {
    files.upload.mockRejectedValue(new AgentAttachmentError(413, 'file_too_large', 'The file exceeds the 20 MB limit of this agent.'));
    const body = await send([{ kind: 'file', file: { bytes: 'aGk=', name: 'big.bin' } }]);
    expect(body.error).toMatchObject({ code: -32602, data: { code: 'file_too_large' } });
    expect(executeAgentChat).not.toHaveBeenCalled();
  });
});

describe('message/send — how a run that did not finish normally is answered', () => {
  const answer = (text: string) => ({
    output: [{ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    _conversation_messages: [{}, {}],
    stop_reason: 'cancelled',
  });
  const send = async (message: Record<string, unknown> = { parts: [{ kind: 'text', text: 'Hi' }] }) => {
    const app = await buildApp();
    return app.inject({
      method: 'POST',
      url: '/api/client/v1/a2a/support-bot',
      headers: { authorization: 'Bearer tok' },
      payload: { jsonrpc: '2.0', id: 21, method: 'message/send', params: { message } },
    });
  };

  it('a run stopped while the call waited is a Task in state canceled, not completed', async () => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
    mockFn(executeAgentChat).mockImplementation(async () => {
      abortLocalTurns('tenant-1', 'conv-1');
      return answer('Half');
    });
    const body = parseJsonBody<{ result: { id: string; contextId: string; status: { state: string } } }>((await send()).body);
    expect(body.result).toMatchObject({ id: 'run_run-1', contextId: 'conv-1', status: { state: 'canceled' } });
    expect(finalizeAgentRun).toHaveBeenCalledWith('run-1', 'tenant-1', expect.objectContaining({ status: 'canceled' }));
  });

  it('a start refused on a new conversation removes that conversation; a continued one is kept', async () => {
    const deleteAgentConversation = mockFn(deleteConversation).mockResolvedValue(true);
    mockFn(getDatabase).mockResolvedValue(createMockDb({
      runWithTenant, createAgentRun, deleteAgentRun, finalizeAgentRun, markAgentRunDetached, getAgentRunById, requestAgentRunCancel,
      countActiveAgentRuns: vi.fn().mockResolvedValue(2),
    } as never));
    limits.override = { maxActivePerTenant: 1 };
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-new' });

    const fresh = parseJsonBody<{ error: { data: { code: string } } }>((await send()).body);
    expect(fresh.error.data.code).toBe('agent_run_concurrency_limit');
    expect(deleteAgentConversation).toHaveBeenCalledWith('tenant_acme', 'conv-new');

    deleteAgentConversation.mockClear();
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', projectId: 'proj-1', createdBy: 'user-1', messages: [] });
    const continued = parseJsonBody<{ error: { data: { code: string } } }>((await send({ parts: [{ kind: 'text', text: 'Hi' }], contextId: 'conv-9' })).body);
    expect(continued.error.data.code).toBe('agent_run_concurrency_limit');
    expect(deleteAgentConversation).not.toHaveBeenCalled();
    expect(executeAgentChat).not.toHaveBeenCalled();
  });

  it('an authenticated caller\'s data variables stay prompt variables (not external content)', async () => {
    mockFn(createConversation).mockResolvedValue({ _id: 'conv-1' });
    mockFn(getAgentByKey).mockResolvedValue({ ...EXPOSED_AGENT, config: { ...EXPOSED_AGENT.config, variables: [{ name: 'topic', type: 'string' }] } });
    mockFn(executeAgentChat).mockResolvedValue(answer('ok'));
    await send({ parts: [{ kind: 'text', text: 'Go' }, { kind: 'data', data: { topic: 'billing' } }] });
    const request = mockFn(executeAgentChat).mock.calls[0][0];
    expect(request.variables).toEqual({ topic: 'billing' });
    expect(request.variablesInPrompt).toBeUndefined();
    expect(request.externalContent).toBeUndefined();
  });
});
