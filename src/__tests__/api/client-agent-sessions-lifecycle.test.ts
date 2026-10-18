/**
 * `POST /client/v1/agents/sessions`, `GET /client/v1/agents/sessions` and
 * `DELETE /client/v1/agents/sessions/:id` — start a session without a message,
 * list the project's sessions, delete one. The services behind them
 * (conversation CRUD, the list query) are faked; what is checked here is what the
 * routes validate, scope, and answer.
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
  listAgents: vi.fn(),
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listSessionPage: vi.fn(),
  listAgentRuns: vi.fn(),
  db: {
    listAgentPendingActions: vi.fn(async () => []),
    getAgentSessionMaxSeq: vi.fn(async () => 0),
    listAgentRuns: vi.fn(),
  },
}));

vi.mock('@/lib/services/agents', () => ({
  getConversationById: hoisted.getConversationById,
  getAgentByKey: hoisted.getAgentByKey,
  listAgents: hoisted.listAgents,
  createConversation: hoisted.createConversation,
  deleteConversation: hoisted.deleteConversation,
}));
vi.mock('@/lib/services/agents/agentRunService', () => ({
  apiErrorBody: (type: string, message: string, code = type, extra?: Record<string, unknown>) => ({ error: { type, message, code, ...extra } }),
  invalidRequestErrorBody: (message: string, code = 'invalid_request') => ({ error: { type: 'invalid_request_error', message, code } }),
  runWithTenantDb: (_name: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
}));
vi.mock('@/lib/services/agents/sessionList', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/agents/sessionList')>('@/lib/services/agents/sessionList');
  return { ...actual, listSessionPage: hoisted.listSessionPage };
});

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { encodeSessionCursor } from '@/lib/services/agents/sessionList';
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
const headers = { authorization: 'Bearer tok_abc' };
const runWithTenant = vi.fn(<T>(_tenantDbName: string, fn: () => T | Promise<T>) => fn());

const AGENT = { _id: 'agent-1', key: 'support-agent', name: 'Support', status: 'active', projectId: 'proj-1', config: { modelKey: 'm' } };
const created = (overrides: Record<string, unknown> = {}) => ({
  _id: 'conv-new', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', title: 'New conversation', messages: [],
  createdBy: 'user-1', metadata: { source: 'api' }, createdAt: new Date('2026-01-02T03:04:05.000Z'), updatedAt: new Date('2026-01-02T03:04:05.000Z'), ...overrides,
});

describe('client agent session lifecycle routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
    hoisted.getAgentByKey.mockResolvedValue(AGENT);
    hoisted.listAgents.mockResolvedValue([]);
    hoisted.createConversation.mockImplementation(async (...args: unknown[]) => created({ title: args[5] ?? 'New conversation', metadata: args[6], ...(args[7] ? { budget: args[7], spentUsd: 0 } : {}) }));
    hoisted.db.listAgentPendingActions.mockResolvedValue([]);
    hoisted.db.getAgentSessionMaxSeq.mockResolvedValue(0);
    hoisted.db.listAgentRuns.mockResolvedValue([]);
    app = await createFastifyApiTestApp(clientAgentSessionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/client/v1/agents/sessions', headers: { ...headers, ...extraHeaders }, payload });

  describe('POST — create', () => {
    it('creates an idle session for the token’s owner, marked api, and answers it as the session resource (201)', async () => {
      const res = await post({ agent: 'support-agent' });

      expect(res.statusCode).toBe(201);
      expect(hoisted.getAgentByKey).toHaveBeenCalledWith('tenant_acme', 'support-agent', 'proj-1');
      expect(hoisted.createConversation).toHaveBeenCalledWith(
        'tenant_acme', 'tenant-1', 'proj-1', 'user-1', 'support-agent', undefined, { source: 'api' }, undefined,
      );
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({
        id: 'conv-new', object: 'agent.session', agent: 'support-agent', title: 'New conversation',
        created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-01-02T03:04:05.000Z', metadata: {},
        runtime_status: 'idle', stop_reason: null, pending_actions: [], last_event_seq: 0, budget: null, spent_usd: 0,
      });
    });

    it('takes a title, string metadata (kept apart from the server’s own keys) and a session context built from the body only', async () => {
      const res = await post(
        { agent: 'support-agent', title: '  Refund #42 ', metadata: { ticket: '42', source: 'hacked' }, runtime_context: { metadata: { tier: 'gold' } } },
        { 'x-cpr-hdr-authorization': 'secret-header' },
      );

      expect(res.statusCode).toBe(201);
      const call = hoisted.createConversation.mock.calls[0]!;
      expect(call[5]).toBe('Refund #42');
      // The client's `source` is data, not the server's `source`.
      expect(call[6]).toMatchObject({ source: 'api', clientMetadata: { ticket: '42', source: 'hacked' } });
      expect(call[6].runtimeContext).toMatchObject({ metadata: { tier: 'gold' }, userId: 'user-1', tokenId: 'tok-1', source: 'api' });
      // Nothing from the HTTP headers of this call is kept on the session.
      expect(JSON.stringify(call[6])).not.toContain('secret-header');
      expect(parseJsonBody<{ metadata: Record<string, string> }>(res.body).metadata).toEqual({ ticket: '42', source: 'hacked' });
    });

    it('takes a budget — and null for none — under the same rules as the first turn of a Responses call', async () => {
      const res = await post({ agent: 'support-agent', budget: { max_cost_usd: 3, on_reach: 'stop' } });
      expect(res.statusCode).toBe(201);
      expect(hoisted.createConversation.mock.calls[0]![7]).toEqual({ maxCostUsd: 3, onReach: 'stop' });
      expect(parseJsonBody<Record<string, unknown>>(res.body).budget).toEqual({ max_cost_usd: 3, on_reach: 'stop' });

      await post({ agent: 'support-agent', budget: null });
      expect(hoisted.createConversation.mock.calls[1]![7]).toBeNull();

      const bad = await post({ agent: 'support-agent', budget: { max_cost_usd: -1 } });
      expect(bad.statusCode).toBe(400);
      expect(parseJsonBody<{ error: { code: string } }>(bad.body).error.code).toBe('invalid_budget');
    });

    it('an agent whose admin set a session budget binds the client: removing or raising it is 403', async () => {
      hoisted.getAgentByKey.mockResolvedValue({ ...AGENT, config: { modelKey: 'm', budget: { maxCostUsd: 5, onReach: 'pause' } } });
      for (const budget of [null, { max_cost_usd: 50 }]) {
        const res = await post({ agent: 'support-agent', budget });
        expect(res.statusCode).toBe(403);
        expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('budget_override_forbidden');
      }
      expect((await post({ agent: 'support-agent', budget: { max_cost_usd: 2 } })).statusCode).toBe(201);
      expect(hoisted.createConversation).toHaveBeenCalledTimes(1);
    });

    it('refuses what it cannot make a session of: no agent, an unknown or inactive agent, bad title or metadata', async () => {
      expect((await post({})).statusCode).toBe(400);
      expect((await post({ agent: 5 })).statusCode).toBe(400);
      expect((await post({ agent: 'support-agent', title: 'x'.repeat(201) })).statusCode).toBe(400);
      expect((await post({ agent: 'support-agent', title: 5 })).statusCode).toBe(400);
      for (const metadata of ['text', ['a'], { a: 1 }, { a: 'x'.repeat(513) }, { ['k'.repeat(65)]: 'v' }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v']))]) {
        const res = await post({ agent: 'support-agent', metadata });
        expect(res.statusCode, JSON.stringify(metadata).slice(0, 40)).toBe(400);
        expect(parseJsonBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_metadata');
      }

      hoisted.getAgentByKey.mockResolvedValue(null);
      const unknown = await post({ agent: 'nobody' });
      expect(unknown.statusCode).toBe(404);
      expect(parseJsonBody<{ error: { code: string } }>(unknown.body).error.code).toBe('agent_not_found');

      hoisted.getAgentByKey.mockResolvedValue({ ...AGENT, status: 'draft' });
      expect((await post({ agent: 'support-agent' })).statusCode).toBe(400);
      expect(hoisted.createConversation).not.toHaveBeenCalled();
    });
  });

  describe('GET — list', () => {
    const row = (id: string, overrides: Record<string, unknown> = {}) => ({
      _id: id, tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', title: 'chat', createdBy: 'user-1', messageCount: 3,
      createdAt: new Date('2026-01-02T00:00:00.000Z'), updatedAt: new Date('2026-01-02T01:00:00.000Z'), metadata: { source: 'api', clientMetadata: { ticket: '7' } }, ...overrides,
    });

    it('lists a page newest first as summaries, with has_more and a cursor to the next page', async () => {
      const next = encodeSessionCursor(row('c2'));
      hoisted.listSessionPage.mockResolvedValue({
        sessions: [
          row('c3', { runtimeStatus: 'budget_paused', stopReason: 'budget_reached', budget: { maxCostUsd: 2, onReach: 'pause' }, spentUsd: 2.0000000001, lastEventSeq: 12 }),
          row('c2'),
        ],
        hasMore: true,
        nextCursor: next,
      });

      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions', headers });

      expect(res.statusCode).toBe(200);
      expect(hoisted.listSessionPage).toHaveBeenCalledWith('tenant_acme', { projectId: 'proj-1', limit: 20 });
      const body = parseJsonBody<{ object: string; data: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string }>(res.body);
      expect(body).toMatchObject({ object: 'list', has_more: true, next_cursor: next });
      expect(body.data[0]).toEqual({
        id: 'c3', object: 'agent.session', agent: 'support-agent', title: 'chat', created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T01:00:00.000Z',
        metadata: { ticket: '7' }, message_count: 3, runtime_status: 'budget_paused', stop_reason: 'budget_reached', last_event_seq: 12,
        budget: { max_cost_usd: 2, on_reach: 'pause' }, spent_usd: 2,
      });
      // A session that never ran its runtime reads as idle; no transcript, no pending actions in a list row.
      // Its total was never kept (it has messages), which a list cannot add up: unknown, not zero.
      expect(body.data[1]).toMatchObject({ id: 'c2', runtime_status: 'idle', stop_reason: null, last_event_seq: 0, budget: null, spent_usd: null });
      expect(JSON.stringify(body)).not.toContain('messages');
      expect(body.data[1]).not.toHaveProperty('pending_actions');
    });

    it('spent_usd of a row is the stored running total: 0 only when it is known to be 0, null when the session predates the total (F2-11)', async () => {
      hoisted.listSessionPage.mockResolvedValue({
        sessions: [
          row('kept', { spentUsd: 0.0412 }),
          row('zero', { spentUsd: 0 }),
          row('empty', { messageCount: 0 }),
          row('legacy'),
        ],
        hasMore: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions', headers });

      const spent = Object.fromEntries(parseJsonBody<{ data: Array<{ id: string; spent_usd: number | null }> }>(res.body).data.map((entry) => [entry.id, entry.spent_usd]));
      expect(spent).toEqual({ kept: 0.0412, zero: 0, empty: 0, legacy: null });
    });

    it('the last page has no next cursor', async () => {
      hoisted.listSessionPage.mockResolvedValue({ sessions: [], hasMore: false });
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions', headers });
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({ object: 'list', data: [], has_more: false, next_cursor: null });
    });

    it('passes the agent, status, limit and cursor on — scoped to the token’s project', async () => {
      hoisted.listSessionPage.mockResolvedValue({ sessions: [], hasMore: false });
      const after = encodeSessionCursor(row('c2'));
      const res = await app.inject({
        method: 'GET', url: `/api/client/v1/agents/sessions?agent=support-agent&status=requires_action&limit=100&after=${encodeURIComponent(after)}`, headers,
      });
      expect(res.statusCode).toBe(200);
      expect(hoisted.listSessionPage).toHaveBeenCalledWith('tenant_acme', {
        projectId: 'proj-1', agentKey: 'support-agent', status: 'requires_action', limit: 100,
        after: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'c2' },
      });
    });

    it('refuses a limit outside 1..100, an unknown status and a cursor it did not issue', async () => {
      for (const query of ['limit=0', 'limit=101', 'limit=ten', 'limit=2.5', 'status=sleeping', 'after=not-a-cursor', `after=${Buffer.from('[1]').toString('base64url')}`]) {
        const res = await app.inject({ method: 'GET', url: `/api/client/v1/agents/sessions?${query}`, headers });
        expect(res.statusCode, query).toBe(400);
      }
      expect(hoisted.listSessionPage).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('deletes the session (files, events and pending requests go with it) and says so', async () => {
      hoisted.getConversationById.mockResolvedValue(created({ _id: 'conv-1' }));
      hoisted.deleteConversation.mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/client/v1/agents/sessions/conv-1', headers });

      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({ id: 'conv-1', object: 'agent.session', deleted: true });
      expect(hoisted.deleteConversation).toHaveBeenCalledWith('tenant_acme', 'conv-1');
    });

    it('404s a session of another project (even with its id), and an unknown one', async () => {
      hoisted.getConversationById.mockResolvedValue(created({ projectId: 'proj-2' }));
      expect((await app.inject({ method: 'DELETE', url: '/api/client/v1/agents/sessions/conv-1', headers })).statusCode).toBe(404);
      hoisted.getConversationById.mockResolvedValue(null);
      expect((await app.inject({ method: 'DELETE', url: '/api/client/v1/agents/sessions/conv-1', headers })).statusCode).toBe(404);
      expect(hoisted.deleteConversation).not.toHaveBeenCalled();
    });

    it('409s while a run is queued or running on it — the result would be written into a session that is gone', async () => {
      hoisted.getConversationById.mockResolvedValue(created({ _id: 'conv-1' }));
      hoisted.db.listAgentRuns.mockResolvedValue([{ _id: 'run-1', status: 'running' }]);

      const res = await app.inject({ method: 'DELETE', url: '/api/client/v1/agents/sessions/conv-1', headers });

      expect(res.statusCode).toBe(409);
      expect(parseJsonBody<{ error: { type: string } }>(res.body).error.type).toBe('agent_run_conflict');
      expect(hoisted.db.listAgentRuns).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', projectId: 'proj-1', status: ['queued', 'running'] }));
      expect(hoisted.deleteConversation).not.toHaveBeenCalled();
    });
  });

  describe('GET one — the session resource now carries its title, times and metadata', () => {
    it('adds title, created_at, updated_at and the client’s metadata, and keeps every field it had', async () => {
      hoisted.getConversationById.mockResolvedValue(created({
        _id: 'conv-1', title: 'Refund', metadata: { source: 'api', clientMetadata: { ticket: '42' } }, runtimeStatus: 'running', lastEventSeq: 4,
      }));
      hoisted.db.getAgentSessionMaxSeq.mockResolvedValue(6);

      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1', headers });

      expect(parseJsonBody<Record<string, unknown>>(res.body)).toEqual({
        id: 'conv-1', object: 'agent.session', agent: 'support-agent', title: 'Refund', created_at: '2026-01-02T03:04:05.000Z',
        updated_at: '2026-01-02T03:04:05.000Z', metadata: { ticket: '42' }, runtime_status: 'running', stop_reason: null,
        pending_actions: [], last_event_seq: 6, budget: null, spent_usd: 0,
      });
    });
  });
});

describe('the session cursor', () => {
  it('round-trips a row’s (createdAt, id) and refuses what it did not issue', async () => {
    const { decodeSessionCursor } = await import('@/lib/services/agents/sessionList');
    const cursor = encodeSessionCursor({ _id: 'abc123', createdAt: new Date('2026-05-06T07:08:09.123Z') });
    expect(decodeSessionCursor(cursor)).toEqual({ createdAt: new Date('2026-05-06T07:08:09.123Z'), id: 'abc123' });
    for (const bad of ['', 'zzz', Buffer.from('{}').toString('base64url'), Buffer.from('["x","y"]').toString('base64url'), Buffer.from('[1,""]').toString('base64url'), Buffer.from('[1,2]').toString('base64url')]) {
      expect(decodeSessionCursor(bad), bad).toBeNull();
    }
  });
});
