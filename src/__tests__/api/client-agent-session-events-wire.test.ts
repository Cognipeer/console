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
  // The gate reads the caller (and the engine its policies) through the tenant scope.
  return { getDatabase, runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()) };
});

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

const hoisted = vi.hoisted(() => ({
  getConversationById: vi.fn(),
  follow: vi.fn(),
  db: {
    listAgentSessionEvents: vi.fn(),
    listAgentPendingActions: vi.fn(),
  },
}));

vi.mock('@/lib/services/agents/sessionEvents', () => ({
  parseResumeSeq: () => 0,
  followSessionEvents: hoisted.follow,
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
const conversation = { _id: 'conv-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-agent', messages: [], createdBy: 'user-1' };
const headers = { authorization: 'Bearer tok' };

describe('client session events: snake_case on the wire', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb({ runWithTenant } as never));
    hoisted.getConversationById.mockResolvedValue(conversation);
    app = await createFastifyApiTestApp(clientAgentSessionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('the event list carries the data of an event snake_cased, tool arguments untouched, and the run id as the API spells it (run_<id>)', async () => {
    hoisted.db.listAgentSessionEvents.mockResolvedValue([{
      seq: 1, type: 'agent.tool_use', runId: 'd90f17a3-0001',
      data: { toolCallId: 'c1', name: 'sandbox_exec', args: { workDir: '/w' } },
      createdAt: new Date('2024-01-01T00:00:00Z'), expiresAt: new Date('2024-02-01T00:00:00Z'),
    }]);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1/events', headers });
    expect(parseJsonBody<{ events: unknown[] }>(res.body).events).toEqual([{
      seq: 1, type: 'agent.tool_use', run_id: 'run_d90f17a3-0001',
      data: { tool_call_id: 'c1', name: 'sandbox_exec', args: { workDir: '/w' } },
      created_at: '2024-01-01T00:00:00.000Z',
    }]);
  });

  it('the stream frames use the same field names as the list (run_id as run_<id>, created_at, snake_case data)', async () => {
    hoisted.follow.mockImplementation(async (options: { write: (frame: { id?: number; event: string; data: unknown }) => void }) => {
      options.write({
        id: 3,
        event: 'agent.tool_result',
        data: { seq: 3, type: 'agent.tool_result', data: { toolCallId: 'c1', durationMs: 5 }, runId: 'd90f17a3-0001', createdAt: '2024-01-01T00:00:00.000Z' },
      });
      options.write({
        event: 'agent.message.delta',
        data: { type: 'agent.message.delta', data: { text: 'hi' }, createdAt: '2024-01-01T00:00:01.000Z' },
      });
    });
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1/events/stream', headers });
    expect(res.statusCode).toBe(200);
    const frames = res.body.split('\n\n').filter((frame) => frame.trim());
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('id: 3\nevent: agent.tool_result\n');
    expect(JSON.parse(frames[0].split('data: ')[1])).toEqual({
      seq: 3, type: 'agent.tool_result', data: { tool_call_id: 'c1', duration_ms: 5 }, run_id: 'run_d90f17a3-0001', created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(frames[1]).not.toContain('id:');
    expect(JSON.parse(frames[1].split('data: ')[1])).toEqual({
      type: 'agent.message.delta', data: { text: 'hi' }, created_at: '2024-01-01T00:00:01.000Z',
    });
    expect(res.body).not.toContain('runId');
    expect(res.body).not.toContain('createdAt');
  });

  describe('what only the dashboard\'s session view reads (plan, sub-agents, positioned passes)', () => {
    const at = new Date('2024-01-01T00:00:00Z');
    const row = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, data, createdAt: at, expiresAt: at });

    it('the list leaves out plan and sub-agent rows and a sub-agent\'s pass, and pages past them from the unfiltered page', async () => {
      hoisted.db.listAgentSessionEvents.mockResolvedValue([
        row(1, 'agent.tool_use', { toolCallId: 'c1', name: 'lookup' }),
        row(2, 'agent.plan', { version: 1, operation: 'write', steps: [], at: 'now' }),
        row(3, 'agent.subagent', { phase: 'start', id: 'sa_1', name: 'helper', at: 'now' }),
        row(4, 'agent.compaction', { at: 'now', subagent: { id: 'sa_1', name: 'helper' } }),
      ]);
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1/events?limit=3', headers });
      const body = parseJsonBody<{ events: Array<{ seq: number }>; has_more: boolean; last_seq: number }>(res.body);
      expect(body.events.map((e) => e.seq)).toEqual([1]);
      // The page ended at seq 3 (the fourth row only says there is more): a client resumes from there.
      expect(body.last_seq).toBe(3);
      expect(body.has_more).toBe(true);
    });

    it('a page made only of such rows is empty, and still moves last_seq on', async () => {
      hoisted.db.listAgentSessionEvents.mockResolvedValue([
        row(7, 'agent.plan', { version: 2, steps: [] }),
        row(8, 'agent.subagent', { phase: 'result', id: 'sa_1', name: 'helper' }),
      ]);
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1/events?after=6', headers });
      expect(parseJsonBody(res.body)).toMatchObject({ events: [], has_more: false, last_seq: 8 });
    });

    it('a tool row loses the sub-agent id and delegation, a pass loses its position, and everything else keeps its documented shape', async () => {
      hoisted.db.listAgentSessionEvents.mockResolvedValue([
        row(1, 'agent.tool_use', { toolCallId: 'c1', name: 'lookup', args: { subagentId: 'kept' }, subagent: 'helper', subagentId: 'sa_1', parentToolCallId: 'd1', parallel: true }),
        row(2, 'agent.tool_result', { toolCallId: 'c1', name: 'lookup', ok: true, durationMs: 5, subagent: 'helper', subagentId: 'sa_1', parentToolCallId: 'd1' }),
        row(3, 'agent.compaction', {
          at: 'now', messagesCompressed: 6, tokensBefore: 8000, id: 'pass-1', index: 1, afterToolCallId: 'd1', trigger: 'mid_leg',
          compactedTools: [{ toolName: 'lookup', toolCallId: 'c1' }],
        }),
      ]);
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1/events', headers });
      const { events } = parseJsonBody<{ events: Array<{ data: Record<string, unknown> }> }>(res.body);
      expect(events[0].data).toEqual({ tool_call_id: 'c1', name: 'lookup', args: { subagentId: 'kept' }, subagent: 'helper' });
      expect(events[1].data).toEqual({ tool_call_id: 'c1', name: 'lookup', ok: true, duration_ms: 5, subagent: 'helper' });
      expect(events[2].data).toEqual({ at: 'now', messages_compressed: 6, tokens_before: 8000 });
    });

    it('the stream skips them too, and the frames it keeps lose the same fields', async () => {
      const frame = (seq: number, type: string, data: Record<string, unknown>) => ({
        id: seq, event: type, data: { seq, type, data, createdAt: '2024-01-01T00:00:00.000Z' },
      });
      hoisted.follow.mockImplementation(async (options: { write: (f: { id?: number; event: string; data: unknown }) => void }) => {
        options.write(frame(1, 'agent.plan', { version: 1, steps: [] }));
        options.write(frame(2, 'agent.subagent', { phase: 'start', id: 'sa_1', name: 'helper' }));
        options.write(frame(3, 'agent.compaction', { at: 'now', subagent: { name: 'helper' } }));
        options.write(frame(4, 'agent.tool_use', { toolCallId: 'c1', name: 'lookup', subagent: 'helper', subagentId: 'sa_1', parentToolCallId: 'd1' }));
        options.write(frame(5, 'agent.compaction', { at: 'now', id: 'pass-1', index: 1, afterToolCallId: null, messagesCompressed: 2 }));
      });
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1/events/stream', headers });
      const frames = res.body.split('\n\n').filter((f) => f.trim());
      expect(frames.map((f) => f.split('\n')[0])).toEqual(['id: 4', 'id: 5']);
      expect(JSON.parse(frames[0].split('data: ')[1]).data).toEqual({ tool_call_id: 'c1', name: 'lookup', subagent: 'helper' });
      expect(JSON.parse(frames[1].split('data: ')[1]).data).toEqual({ at: 'now', messages_compressed: 2 });
      expect(res.body).not.toContain('agent.plan');
      expect(res.body).not.toContain('agent.subagent');
    });
  });
});
