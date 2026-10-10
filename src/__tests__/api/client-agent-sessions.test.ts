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

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  // The gate reads the caller (and the engine its policies) through the tenant scope.
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));


vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

const hoisted = vi.hoisted(() => ({
  getConversationById: vi.fn(),
  db: {
    listAgentSessionEvents: vi.fn(),
    listAgentPendingActions: vi.fn(),
  },
}));

vi.mock('@/lib/services/agents', () => ({
  getConversationById: hoisted.getConversationById,
}));

vi.mock('@/lib/services/agents/agentRunService', () => ({
  apiErrorBody: (type: string, message: string, code = type) => ({ error: { type, message, code } }),
  runWithTenantDb: (_name: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
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

const conversation = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentKey: 'support-agent',
  messages: [],
  createdBy: 'user-1',
  ...overrides,
});

const event = (seq: number, type = 'agent.tool_use') => ({
  seq, type, data: { n: seq }, createdAt: new Date('2024-01-01T00:00:00Z'), expiresAt: new Date('2024-02-01T00:00:00Z'),
});

describe('client agent session routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
    app = await createFastifyApiTestApp(clientAgentSessionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET session reports the runtime status, stop reason, pending actions and last event seq', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation({
      runtimeStatus: 'requires_action', stopReason: 'requires_action', pendingActionIds: ['act_1'], lastEventSeq: 9,
    }));
    hoisted.db.listAgentPendingActions.mockResolvedValue([{
      _id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', args: { cmd: 'ls' }, sdkId: 'sdk-secret',
      status: 'pending', requestedAt: new Date('2024-01-01T00:00:00Z'), createdBy: 'user-1',
    }]);

    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1', headers: { authorization: '******' } });

    expect(res.statusCode).toBe(200);
    expect(hoisted.getConversationById).toHaveBeenCalledWith('tenant_acme', 'conv-1');
    const body = parseJsonBody<Record<string, unknown>>(res.body);
    expect(body).toMatchObject({
      id: 'conv-1', object: 'agent.session', agent: 'support-agent', runtime_status: 'requires_action',
      stop_reason: 'requires_action', last_event_seq: 9,
    });
    expect(body.pending_actions).toEqual([{
      id: 'act_1', kind: 'tool_approval', tool_name: 'sandbox_exec', args: { cmd: 'ls' }, status: 'pending',
      requested_at: '2024-01-01T00:00:00.000Z',
    }]);
    expect(JSON.stringify(body)).not.toContain('sdk-secret');
  });

  it('a conversation without runtime fields reads as idle', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation());
    hoisted.db.listAgentPendingActions.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1', headers: { authorization: '******' } });
    expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({
      runtime_status: 'idle', stop_reason: null, pending_actions: [], last_event_seq: 0,
    });
  });

  it('404s a conversation of another project, a missing one, and an id the store rejects', async () => {
    hoisted.getConversationById.mockResolvedValueOnce(conversation({ projectId: 'proj-other' }));
    let res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1', headers: { authorization: '******' } });
    expect(res.statusCode).toBe(404);

    hoisted.getConversationById.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/nope/events', headers: { authorization: '******' } });
    expect(res.statusCode).toBe(404);

    hoisted.getConversationById.mockRejectedValueOnce(new Error('bad ObjectId'));
    res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/zzz/events/stream', headers: { authorization: '******' } });
    expect(res.statusCode).toBe(404);
    expect(hoisted.db.listAgentSessionEvents).not.toHaveBeenCalled();
  });

  it('GET events pages after ?after, filters by ?types and flags has_more', async () => {
    hoisted.getConversationById.mockResolvedValue(conversation());
    hoisted.db.listAgentSessionEvents.mockResolvedValue([event(4), event(5), event(6)]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/client/v1/agents/sessions/conv-1/events?after=3&limit=2&types=agent.tool_use,agent.message',
      headers: { authorization: '******' },
    });

    expect(res.statusCode).toBe(200);
    expect(hoisted.db.listAgentSessionEvents).toHaveBeenCalledWith('conv-1', {
      afterSeq: 3, limit: 3, types: ['agent.tool_use', 'agent.message'],
    });
    const body = parseJsonBody<{ events: Array<{ seq: number }>; has_more: boolean; last_seq: number }>(res.body);
    expect(body.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(body.has_more).toBe(true);
    expect(body.last_seq).toBe(5);
  });
});
