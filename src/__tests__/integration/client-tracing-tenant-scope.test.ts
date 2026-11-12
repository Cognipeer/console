/**
 * Client tracing routes keep every tenant-db access inside an explicit tenant scope: two tenants
 * ingesting (and reading threads) concurrently through the live Fastify plugin each see only
 * their own data, on both real backends. Both tenants use the SAME session and thread ids, so a
 * write or read bound to the wrong tenant would collide or leak.
 *
 * The routes, including their background writes, never move the shared handle
 * (`switchToTenant`) themselves; reverting them to a bare switch fails every case.
 * Services further down the same path (thread reads, quota, pricing) are moved off
 * the shared handle in their own changes, so the check looks at the direct caller.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
}));

import type { DatabaseProvider } from '@/lib/database';
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db: DatabaseProvider = await hoisted.getDatabase();
      return db.runWithTenant?.(tenantDbName, () => fn(db));
    },
  };
});

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
    requireApiTokenFromHeader: async (header: string | null) => {
      const ctx = hoisted.tokens.get(String(header).replace(/^Bearer /, ''));
      if (!ctx) throw new ApiTokenAuthError('Invalid API token', 401);
      return ctx;
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { __resetEntityMetricsRollupForTests, flushEntityMetricsRollup } from '@/lib/services/entityMetrics/entityMetricsRollup';
import { flushUsageRollup } from '@/lib/services/usage/usageRollup';
import { clientTracingApiPlugin } from '@/server/api/plugins/client-tracing';
import { createFastifyApiTestApp } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

type Seeded = { token: string; dbName: string; tenantId: string; projectId: string; agent: string };

/** Records the frame that called `switchToTenant` directly: the first one outside node_modules and this file. */
function recordSwitchCallers(target: DatabaseProvider): string[] {
  const callers: string[] = [];
  const original = target.switchToTenant.bind(target);
  vi.spyOn(target, 'switchToTenant').mockImplementation(async (tenantDbName: string) => {
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    const caller = frames.find((frame) => !frame.includes('node_modules') && !frame.includes('client-tracing-tenant-scope.test'));
    callers.push(caller?.trim() ?? '<unknown>');
    return original(tenantDbName);
  });
  return callers;
}

const fromTracingRoutes = (callers: string[]) => callers.filter((frame) => frame.includes('plugins/client-tracing/'));

describeForEachProvider('client tracing routes are tenant-scoped', (getDb) => {
  let db: DatabaseProvider;
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let tenants: Seeded[];
  let run = 0;

  async function seedTenant(label: string): Promise<Seeded> {
    const slug = `scope-${label}-${Date.now()}-${run}-${Math.random().toString(36).slice(2, 6)}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: label, slug, dbName, licenseType: 'ENTERPRISE', ownerId: 'pending' });
    const tenantId = String(tenant._id);
    const { owner, projectId } = await db.runWithTenant!(dbName, async () => ({
      owner: await db.createUser({
        tenantId, email: `owner@${label}.io`, name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'ENTERPRISE', features: [],
      }),
      projectId: String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'test' }))._id),
    }));
    const token = `tok-${label}-${run}`;
    hoisted.tokens.set(token, {
      token,
      tokenRecord: { _id: `${token}-id`, userId: String(owner._id), servicePermissions: null, projectId },
      tenant: { licenseType: 'ENTERPRISE' },
      tenantId,
      tenantSlug: slug,
      tenantDbName: dbName,
      projectId,
      user: owner,
    });
    return { token, dbName, tenantId, projectId, agent: `agent-${label}-${run}` };
  }

  beforeEach(async () => {
    run += 1;
    hoisted.getDatabase.mockImplementation(async () => getDb());
    hoisted.tokens.clear();
    __resetEntityMetricsRollupForTests();
    db = getDb();
    tenants = [await seedTenant('a'), await seedTenant('b')];
    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(clientTracingApiPlugin);
    });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await drainPendingTasks();
    await flushUsageRollup();
    __resetEntityMetricsRollupForTests();
  });

  const call = (tenant: Seeded, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tenant.token}`, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });

  const aiCall = (id: string) => ({
    id, type: 'ai_call', status: 'success', model: 'gpt-x', inputTokens: 10, outputTokens: 5,
    durationMs: 100, sequence: 1, timestamp: new Date().toISOString(),
  });

  async function sessionsOf(tenant: Seeded) {
    return db.runWithTenant!(tenant.dbName, () => db.listAgentTracingSessions({ limit: 50 }, tenant.projectId));
  }

  async function eventsOf(tenant: Seeded, sessionId: string) {
    return db.runWithTenant!(tenant.dbName, () => db.listAgentTracingEvents(sessionId, tenant.projectId));
  }

  it('batch ingest and stream ingest from two tenants at once land only in their own tenant', async () => {
    const [a, b] = tenants;
    const switchCallers = recordSwitchCallers(db);
    const sharedBatchId = `batch-shared-${run}`;
    const sharedStreamId = `stream-shared-${run}`;
    const startedAt = new Date().toISOString();

    for (let round = 0; round < 3; round += 1) {
      const responses = await Promise.all([
        call(a, 'POST', '/api/client/v1/tracing/sessions', {
          sessionId: sharedBatchId, threadId: 'thread-shared', agent: { name: a.agent }, startedAt, endedAt: startedAt,
          events: [aiCall(`a-batch-${round}-1`)],
        }),
        call(b, 'POST', '/api/client/v1/tracing/sessions', {
          sessionId: sharedBatchId, threadId: 'thread-shared', agent: { name: b.agent }, startedAt, endedAt: startedAt,
          events: [aiCall(`b-batch-${round}-1`), { ...aiCall(`b-batch-${round}-2`), sequence: 2 }],
        }),
        call(a, 'POST', `/api/client/v1/tracing/sessions/stream/${sharedStreamId}/start`, {
          sessionId: sharedStreamId, agent: { name: a.agent }, startedAt,
        }),
        call(b, 'POST', `/api/client/v1/tracing/sessions/stream/${sharedStreamId}/start`, {
          sessionId: sharedStreamId, agent: { name: b.agent }, startedAt,
        }),
      ]);
      for (const response of responses) expect(response.statusCode, response.body).toBe(200);
      await drainPendingTasks();
    }

    for (const tenant of tenants) {
      const { sessions } = await sessionsOf(tenant);
      expect(sessions.map((session) => session.sessionId).sort()).toEqual([sharedBatchId, sharedStreamId].sort());
      expect(sessions.every((session) => session.agentName === tenant.agent)).toBe(true);
    }
    expect((await eventsOf(a, sharedBatchId)).map((event) => event.id).sort()).toEqual(['a-batch-2-1']);
    expect((await eventsOf(b, sharedBatchId)).map((event) => event.id).sort()).toEqual(['b-batch-2-1', 'b-batch-2-2']);

    // Concurrent stream events and ends, one tenant failing on a missing session, the other succeeding.
    const events = await Promise.all([
      call(a, 'POST', `/api/client/v1/tracing/sessions/stream/${sharedStreamId}/events`, { event: aiCall('a-stream-1') }),
      call(b, 'POST', `/api/client/v1/tracing/sessions/stream/${sharedStreamId}/events`, { event: aiCall('b-stream-1') }),
      call(a, 'POST', `/api/client/v1/tracing/sessions/stream/only-in-a-${run}/events`, { event: aiCall('a-orphan') }),
    ]);
    expect(events.map((response) => response.statusCode)).toEqual([200, 200, 404]);
    await drainPendingTasks();
    const ends = await Promise.all(tenants.map((tenant) =>
      call(tenant, 'POST', `/api/client/v1/tracing/sessions/stream/${sharedStreamId}/end`, { durationMs: 10 })));
    for (const response of ends) expect(response.statusCode, response.body).toBe(200);
    await settleAll();

    expect((await eventsOf(a, sharedStreamId)).map((event) => event.id)).toEqual(['a-stream-1']);
    expect((await eventsOf(b, sharedStreamId)).map((event) => event.id)).toEqual(['b-stream-1']);
    for (const tenant of tenants) {
      const stored = await db.runWithTenant!(tenant.dbName, () => db.findAgentTracingSessionById(sharedStreamId, tenant.projectId));
      expect(stored).toMatchObject({ agentName: tenant.agent, status: 'success', totalEvents: 1 });
    }
    expect(fromTracingRoutes(switchCallers)).toEqual([]);
  });

  it('thread reads from two tenants at once return only their own threads', async () => {
    const [a, b] = tenants;
    const switchCallers = recordSwitchCallers(db);
    const startedAt = new Date().toISOString();
    await Promise.all(tenants.map((tenant, index) =>
      call(tenant, 'POST', '/api/client/v1/tracing/sessions', {
        sessionId: `read-${run}-${tenant.agent}`, threadId: `thread-${tenant.agent}`, agent: { name: tenant.agent }, startedAt, endedAt: startedAt,
        events: [aiCall(`read-${index}`)],
      })));
    await settleAll();

    const reads = await Promise.all([
      call(a, 'GET', '/api/client/v1/tracing/threads'),
      call(b, 'GET', '/api/client/v1/tracing/threads'),
      call(a, 'GET', `/api/client/v1/tracing/threads/thread-${a.agent}`),
      call(b, 'GET', `/api/client/v1/tracing/threads/thread-${a.agent}`),
    ]);
    for (const response of reads.slice(0, 3)) expect(response.statusCode, response.body).toBe(200);
    expect(reads[3].statusCode).toBe(404);

    const threadIds = (response: { body: string }) =>
      (JSON.parse(response.body).threads as Array<{ threadId: string }>).map((thread) => thread.threadId);
    expect(threadIds(reads[0])).toEqual([`thread-${a.agent}`]);
    expect(threadIds(reads[1])).toEqual([`thread-${b.agent}`]);
    expect(fromTracingRoutes(switchCallers)).toEqual([]);
  });

  async function settleAll() {
    await drainPendingTasks();
    await flushEntityMetricsRollup();
  }
});
