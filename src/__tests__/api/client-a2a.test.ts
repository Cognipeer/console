/**
 * Inbound A2A server tests — the JSON-RPC surface that exposes agents to
 * external A2A clients. Locks the contract:
 *   - exposure is opt-in via `agent.metadata.a2a.enabled` (404 otherwise,
 *     identical to a missing agent)
 *   - the agent card advertises the JSON-RPC endpoint + bearer security
 *   - message/send maps contextId ↔ conversationId, stamps the caller's
 *     runtime context with source 'a2a', and returns a terminal task
 *   - tasks/get rebuilds a completed task from the conversation store
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

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  getAgentByKey: vi.fn(),
  executeAgentChat: vi.fn(),
  createConversation: vi.fn(),
  getConversationById: vi.fn(),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import {
  createConversation,
  executeAgentChat,
  getAgentByKey,
  getConversationById,
} from '@/lib/services/agents/agentService';
import { clientA2aApiPlugin } from '@/server/api/plugins/client-a2a';
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

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

async function buildApp() {
  return createFastifyApiTestApp(clientA2aApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(requireApiTokenFromHeader).mockResolvedValue(AUTH_CTX);
  mockFn(getDatabase).mockResolvedValue({ runWithTenant });
  mockFn(getPermissionServiceForPath).mockReturnValue(null);
  mockFn(authorizeServiceRequest).mockReturnValue({ allowed: true });
  mockFn(getAgentByKey).mockResolvedValue(EXPOSED_AGENT);
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
    expect((card.capabilities as { streaming: boolean }).streaming).toBe(false);
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
    expect(body.result.id).toBe('task_conv-1_1');
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
  });

  it('reuses the conversation for a known contextId and rejects a foreign one', async () => {
    mockFn(getConversationById).mockResolvedValue({ agentKey: 'support-bot', messages: [] });
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

    mockFn(getConversationById).mockResolvedValue({ agentKey: 'other-agent', messages: [] });
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

describe('tasks/get and unknown methods', () => {
  it('rebuilds a completed task from the conversation store', async () => {
    mockFn(getConversationById).mockResolvedValue({
      agentKey: 'support-bot',
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
      payload: { jsonrpc: '2.0', id: 5, method: 'message/stream', params: {} },
    });
    expect(parseJsonBody<{ error: { code: number } }>(unknown.body).error.code).toBe(-32601);
  });
});
