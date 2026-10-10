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
}));

vi.mock('@/lib/security/rbac', () => ({
  getPermissionServiceForPath: vi.fn(),
  authorizeServiceRequest: vi.fn(),
}));

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
import { getPermissionServiceForPath, authorizeServiceRequest } from '@/lib/security/rbac';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
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
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({ runWithTenant });
    (getPermissionServiceForPath as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (authorizeServiceRequest as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true });
    hoisted.getConversationById.mockResolvedValue(conversation);
    app = await createFastifyApiTestApp(clientAgentSessionsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('the event list carries the data of an event snake_cased, tool arguments untouched', async () => {
    hoisted.db.listAgentSessionEvents.mockResolvedValue([{
      seq: 1, type: 'agent.tool_use', runId: 'run_1',
      data: { toolCallId: 'c1', name: 'sandbox_exec', args: { workDir: '/w' } },
      createdAt: new Date('2024-01-01T00:00:00Z'), expiresAt: new Date('2024-02-01T00:00:00Z'),
    }]);
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/agents/sessions/conv-1/events', headers });
    expect(parseJsonBody<{ events: unknown[] }>(res.body).events).toEqual([{
      seq: 1, type: 'agent.tool_use', run_id: 'run_1',
      data: { tool_call_id: 'c1', name: 'sandbox_exec', args: { workDir: '/w' } },
      created_at: '2024-01-01T00:00:00.000Z',
    }]);
  });

  it('the stream frames use the same field names as the list (run_id, created_at, snake_case data)', async () => {
    hoisted.follow.mockImplementation(async (options: { write: (frame: { id?: number; event: string; data: unknown }) => void }) => {
      options.write({
        id: 3,
        event: 'agent.tool_result',
        data: { seq: 3, type: 'agent.tool_result', data: { toolCallId: 'c1', durationMs: 5 }, runId: 'run_1', createdAt: '2024-01-01T00:00:00.000Z' },
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
      seq: 3, type: 'agent.tool_result', data: { tool_call_id: 'c1', duration_ms: 5 }, run_id: 'run_1', created_at: '2024-01-01T00:00:00.000Z',
    });
    expect(frames[1]).not.toContain('id:');
    expect(JSON.parse(frames[1].split('data: ')[1])).toEqual({
      type: 'agent.message.delta', data: { text: 'hi' }, created_at: '2024-01-01T00:00:01.000Z',
    });
    expect(res.body).not.toContain('runId');
    expect(res.body).not.toContain('createdAt');
  });
});
