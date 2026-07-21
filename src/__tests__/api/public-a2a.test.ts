/**
 * Public (unauthenticated) A2A surface tests. Locks the contract:
 *   - only agents with a2a { enabled, accessMode 'public', matching slug }
 *     resolve; everything else is an identical 404 (no existence leak)
 *   - the public agent card advertises the slug URL and no bearer security
 *   - message/send executes without any API token, attributed to the
 *     'a2a-public' sentinel user with runtime-context source 'a2a'
 *   - dashboard PATCH normalization keeps the endpoint slug server-owned
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  getAgentByKey: vi.fn(),
  executeAgentChat: vi.fn(),
  createConversation: vi.fn(),
  getConversationById: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import {
  createConversation,
  executeAgentChat,
} from '@/lib/services/agents/agentService';
import {
  normalizeA2aMetadataUpdate,
  resolveA2aExposure,
} from '@/lib/services/agents/a2aExposure';
import { publicA2aApiPlugin } from '@/server/api/plugins/public-a2a';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const SLUG = 'abcdef1234567890';

const PUBLIC_AGENT = {
  _id: 'agent-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'support-bot',
  name: 'Support Bot',
  description: 'Answers support questions',
  status: 'active',
  publishedVersion: 3,
  config: { toolBindings: [] },
  metadata: { a2a: { enabled: true, accessMode: 'public', endpointSlug: SLUG } },
};

const runWithTenant = vi.fn(<T>(_db: string, fn: () => T | Promise<T>) => fn());
const listAgents = vi.fn();
const findTenantById = vi.fn();

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

async function buildApp() {
  return createFastifyApiTestApp(publicA2aApiPlugin);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFn(getDatabase).mockResolvedValue({ runWithTenant, listAgents, findTenantById });
  findTenantById.mockResolvedValue({ _id: 'tenant-1', dbName: 'tenant_acme' });
  listAgents.mockResolvedValue([PUBLIC_AGENT]);
});

describe('public agent card', () => {
  it('serves a card with the public endpoint URL and no bearer security', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/public/a2a/tenant-1/${SLUG}/.well-known/agent-card.json`,
      headers: { host: 'console.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(200);
    const card = parseJsonBody<Record<string, unknown>>(res.body);
    expect(card.url).toBe(`https://console.example.com/api/public/a2a/tenant-1/${SLUG}`);
    expect(card.securitySchemes).toEqual({});
    expect(card.security).toEqual([]);
  });

  it('404s for token-mode agents, wrong slugs, and unknown tenants alike', async () => {
    const app = await buildApp();

    listAgents.mockResolvedValue([
      { ...PUBLIC_AGENT, metadata: { a2a: { enabled: true, accessMode: 'token', endpointSlug: SLUG } } },
    ]);
    const tokenMode = await app.inject({
      method: 'GET',
      url: `/api/public/a2a/tenant-1/${SLUG}/.well-known/agent-card.json`,
    });
    expect(tokenMode.statusCode).toBe(404);

    listAgents.mockResolvedValue([PUBLIC_AGENT]);
    const wrongSlug = await app.inject({
      method: 'GET',
      url: '/api/public/a2a/tenant-1/0000000000000000/.well-known/agent-card.json',
    });
    expect(wrongSlug.statusCode).toBe(404);

    findTenantById.mockResolvedValue(null);
    const unknownTenant = await app.inject({
      method: 'GET',
      url: `/api/public/a2a/nope/${SLUG}/.well-known/agent-card.json`,
    });
    expect(unknownTenant.statusCode).toBe(404);
  });

  it('404s for inactive agents', async () => {
    listAgents.mockResolvedValue([{ ...PUBLIC_AGENT, status: 'inactive' }]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/public/a2a/tenant-1/${SLUG}/.well-known/agent-card.json`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('public message/send', () => {
  it('runs the agent without a token, attributed to the public sentinel user', async () => {
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
      url: `/api/public/a2a/tenant-1/${SLUG}`,
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
    expect(body.result.kind).toBe('task');
    expect((body.result.status as { state: string }).state).toBe('completed');

    const conversationArgs = mockFn(createConversation).mock.calls[0];
    expect(conversationArgs[0]).toBe('tenant_acme');
    expect(conversationArgs[3]).toBe('a2a-public');

    const chatRequest = mockFn(executeAgentChat).mock.calls[0][0];
    expect(chatRequest.usePublished).toBe(true);
    expect(chatRequest.tenantDbName).toBe('tenant_acme');
    expect(chatRequest.userId).toBe('a2a-public');
    expect(chatRequest.runtimeContext).toMatchObject({ source: 'a2a', userId: 'a2a-public' });
    expect(chatRequest.runtimeContext.tokenId).toBeUndefined();
  });

  it('404s the RPC endpoint for non-public agents', async () => {
    listAgents.mockResolvedValue([
      { ...PUBLIC_AGENT, metadata: { a2a: { enabled: true, accessMode: 'token', endpointSlug: SLUG } } },
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/public/a2a/tenant-1/${SLUG}`,
      payload: { jsonrpc: '2.0', id: 1, method: 'message/send', params: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(mockFn(executeAgentChat)).not.toHaveBeenCalled();
  });
});

describe('a2a metadata normalization (dashboard PATCH)', () => {
  it('mints a slug on first exposure and coerces fields', () => {
    const normalized = normalizeA2aMetadataUpdate({ enabled: true, accessMode: 'public' }, null);
    expect(normalized.enabled).toBe(true);
    expect(normalized.accessMode).toBe('public');
    expect(normalized.endpointSlug).toMatch(/^[0-9a-f]{16}$/);

    const junk = normalizeA2aMetadataUpdate({ enabled: 'yes', accessMode: 'open' }, null);
    expect(junk.enabled).toBe(false);
    expect(junk.accessMode).toBe('token');
  });

  it('preserves the existing slug and ignores client-supplied ones', () => {
    const existing = { metadata: { a2a: { enabled: true, accessMode: 'token', endpointSlug: SLUG } } };
    const normalized = normalizeA2aMetadataUpdate(
      { enabled: true, accessMode: 'public', endpointSlug: 'attacker-chosen-x' },
      existing,
    );
    expect(normalized.endpointSlug).toBe(SLUG);
  });

  it('resolveA2aExposure defaults to token mode and rejects short slugs', () => {
    expect(resolveA2aExposure({ metadata: {} })).toEqual({ enabled: false, accessMode: 'token' });
    const short = resolveA2aExposure({ metadata: { a2a: { enabled: true, endpointSlug: 'abc' } } });
    expect(short.endpointSlug).toBeUndefined();
    expect(short.accessMode).toBe('token');
  });
});
