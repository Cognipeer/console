/**
 * The built-in console MCP server (/api/client/v1/mcp/console/*).
 *
 * The `mcp` permission opens the endpoint. Its tools return agent tracing
 * data, so each one also needs the permission on the service it reads
 * (`tracing`): the same effective permission the /api/client/v1/tracing routes
 * enforce — the token owner's, capped by the token's own scope. A token without
 * it does not see those tools in the list and cannot call them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

// A real SQLite database and the real policy engine decide; only the tracing
// data behind the tools is stubbed.
const dbHolder = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: dbHolder.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) => {
      const db = await dbHolder.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

vi.mock('@/lib/core/lifecycle', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

const tracing = vi.hoisted(() => ({
  listSessions: vi.fn(async () => ({ total: 1, sessions: [{ sessionId: 's-1' }] })),
  getSessionDetail: vi.fn(async () => ({ session: { sessionId: 's-1' }, events: [] })),
  getDashboardOverview: vi.fn(async () => ({
    analytics: { totals: { sessions: 1 }, statuses: [], agents: [] },
    recentSessions: [],
  })),
}));

vi.mock('@/lib/services/agentTracing', () => ({ AgentTracingService: tracing }));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import type { IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { clientMcpConsoleApiPlugin } from '@/server/api/plugins/client-mcp-console';
import type { UserServicePermissions } from '@/lib/security/rbac';

interface TokenSetup {
  role?: IUser['role'];
  userPermissions?: UserServicePermissions;
  scope?: UserServicePermissions | null;
  ownerMissing?: boolean;
}

let env: IamTestDb;
let userSeq = 0;

async function useToken({ role = 'owner', userPermissions, scope = null, ownerMissing = false }: TokenSetup) {
  userSeq += 1;
  const user = ownerMissing
    ? null
    : ((await env.db.createUser({
        tenantId: env.tenantId,
        email: `user${userSeq}@x.io`,
        name: `user${userSeq}`,
        password: '$2b$10$x',
        role,
        licenseId: 'FREE',
        features: [],
        ...(userPermissions ? { servicePermissions: userPermissions } : {}),
      })) as IUser);
  vi.mocked(requireApiTokenFromHeader).mockResolvedValue({
    token: 'tok_abc',
    tokenRecord: { _id: 'tok-1', userId: user ? String(user._id) : 'user-gone', servicePermissions: scope },
    tenant: { licenseType: 'FREE' },
    tenantId: env.tenantId,
    tenantSlug: 'iam-co',
    tenantDbName: env.tenantDbName,
    projectId: 'default',
    user,
  } as never);
}

interface JsonRpcBody {
  result: { isError?: boolean; content: Array<{ text: string }>; tools: Array<{ name: string }> };
  error?: { code: number; message: string };
}

const AUTH_HEADER = { authorization: 'Bearer tok_abc' };
const TRACING_TOOLS = ['get_dashboard_overview', 'get_session', 'list_recent_sessions'];

describe('built-in console MCP server — tools need the tracing permission', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeAll(async () => {
    env = await createIamTestDb('tenant_console_mcp_perm');
    dbHolder.getDatabase.mockImplementation(async () => env.db);
  });

  afterAll(async () => {
    await app?.close();
    await env?.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    resetProjectNarrowingCachesForTests();
    resetEnforceStatsForTests();
    await app?.close();
    app = await createFastifyApiTestApp(clientMcpConsoleApiPlugin);
  });

  async function listRest() {
    const response = await app.inject({ method: 'GET', url: '/api/client/v1/mcp/console/execute', headers: AUTH_HEADER });
    return { status: response.statusCode, body: parseJsonBody<{ tools: Array<{ name: string }> }>(response.body) };
  }

  async function executeRest(tool: string, args: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/client/v1/mcp/console/execute',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: { tool, arguments: args },
    });
    return { status: response.statusCode, body: parseJsonBody<Record<string, unknown>>(response.body) };
  }

  async function rpc(method: string, params?: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/client/v1/mcp/console/message',
      headers: { ...AUTH_HEADER, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });
    return { status: response.statusCode, body: parseJsonBody<JsonRpcBody>(response.body) };
  }

  describe('a token scoped to the mcp service only', () => {
    beforeEach(async () => { await useToken({ scope: { mcp: 'write' } }); });

    it('lists no tracing tool', async () => {
      const rest = await listRest();
      expect(rest.status).toBe(200);
      expect(rest.body.tools).toEqual([]);

      const rpcList = await rpc('tools/list');
      expect(rpcList.body.result.tools).toEqual([]);
    });

    it('is refused on the REST execute route, before any tracing data is read', async () => {
      for (const tool of TRACING_TOOLS) {
        const { status, body } = await executeRest(tool, { sessionId: 's-1' });
        expect(status, tool).toBe(403);
        expect(body.error).toBe('Forbidden: tracing requires read permission');
      }
      expect(tracing.listSessions).not.toHaveBeenCalled();
      expect(tracing.getSessionDetail).not.toHaveBeenCalled();
      expect(tracing.getDashboardOverview).not.toHaveBeenCalled();
    });

    it('is refused on JSON-RPC tools/call, before any tracing data is read', async () => {
      for (const name of TRACING_TOOLS) {
        const { body } = await rpc('tools/call', { name, arguments: { sessionId: 's-1' } });
        expect(body.result.isError, name).toBe(true);
        expect(body.result.content[0].text).toBe('Forbidden: tracing requires read permission');
      }
      expect(tracing.listSessions).not.toHaveBeenCalled();
      expect(tracing.getSessionDetail).not.toHaveBeenCalled();
      expect(tracing.getDashboardOverview).not.toHaveBeenCalled();
    });

    it('reports an unknown tool as unknown, not as forbidden', async () => {
      expect((await executeRest('no_such_tool')).status).toBe(400);
      const { body } = await rpc('tools/call', { name: 'no_such_tool' });
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toMatch(/unknown tool/i);
    });
  });

  describe('a token that also carries tracing:read', () => {
    beforeEach(async () => { await useToken({ scope: { mcp: 'write', tracing: 'read' } }); });

    it('lists and runs the tracing tools', async () => {
      expect((await listRest()).body.tools.map((t) => t.name).sort()).toEqual(TRACING_TOOLS);
      expect((await rpc('tools/list')).body.result.tools.map((t) => t.name).sort()).toEqual(TRACING_TOOLS);

      const rest = await executeRest('list_recent_sessions', { limit: 5 });
      expect(rest.status).toBe(200);
      expect(rest.body.result).toEqual({ total: 1, sessions: [{ sessionId: 's-1' }] });

      const { body } = await rpc('tools/call', { name: 'get_session', arguments: { sessionId: 's-1' } });
      expect(body.result.isError).toBe(false);
      expect(tracing.getSessionDetail).toHaveBeenCalledTimes(1);
    });
  });

  describe('an unscoped token inherits its owner', () => {
    it('an owner reaches every tool', async () => {
      await useToken({ role: 'owner', scope: null });
      expect((await listRest()).body.tools.map((t) => t.name).sort()).toEqual(TRACING_TOOLS);
      expect((await executeRest('get_dashboard_overview')).status).toBe(200);
    });

    it('a member whose own tracing access is none does not', async () => {
      await useToken({ role: 'user', userPermissions: { tracing: 'none' }, scope: null });
      expect((await listRest()).body.tools).toEqual([]);
      expect((await executeRest('list_recent_sessions')).status).toBe(403);
      expect(tracing.listSessions).not.toHaveBeenCalled();
    });

    it('a member with tracing read does', async () => {
      await useToken({ role: 'user', userPermissions: { tracing: 'read' }, scope: null });
      expect((await listRest()).body.tools.map((t) => t.name).sort()).toEqual(TRACING_TOOLS);
      expect((await executeRest('list_recent_sessions')).status).toBe(200);
    });
  });

  it('a token scope can narrow its owner, never widen it', async () => {
    await useToken({ role: 'owner', scope: { mcp: 'write', tracing: 'none' } });
    expect((await listRest()).body.tools).toEqual([]);
    expect((await executeRest('list_recent_sessions')).status).toBe(403);

    // The owner has no tracing access; a scope that grants it adds nothing.
    await useToken({ role: 'user', userPermissions: { tracing: 'none' }, scope: { mcp: 'write', tracing: 'admin' } });
    expect((await listRest()).body.tools).toEqual([]);
    expect((await executeRest('list_recent_sessions')).status).toBe(403);
  });

  it('a token whose owner is gone reaches nothing', async () => {
    await useToken({ ownerMissing: true, scope: { mcp: 'write', tracing: 'read' } });
    expect((await executeRest('list_recent_sessions')).status).toBe(403);
    expect(tracing.listSessions).not.toHaveBeenCalled();
  });
});
