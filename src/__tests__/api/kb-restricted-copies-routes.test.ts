/**
 * Stored copies of knowledge base passages not open to everyone, at the REAL routes, the REAL gate and the REAL
 * policy engine, over a real SQLite provider. A session (and what was stored on its behalf: its runs, reminders,
 * trace and model calls) that is marked `kbRestricted` keeps its content for the person it was made for and for
 * whoever reads every knowledge base named through the admin exception (a `rag` administrator of its project,
 * where the knowledge base keeps the exception). Everybody else sees that it exists, not what it holds:
 *
 *   - lists keep the row and leave its content out (`restricted: true`);
 *   - the record itself answers 403 `session_restricted`;
 *   - an API token is never an administrator: through one only the person it was made for reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  requireApiToken: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;

    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: hoisted.requireApiToken };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAgentConversation, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { restrictedKnowledgeTag } from '@/lib/services/rag/access/exposure';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
import { modelsApiPlugin } from '@/server/api/plugins/models';
import { tracingApiPlugin } from '@/server/api/plugins/tracing';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let db: SQLiteProvider;
let tmpDir: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId: string;
let p1: string;
let agentId: string;
let tag: string;
const dbName = 'tenant_restricted_copies';
const users = {} as Record<'owner' | 'starter' | 'other' | 'kbadmin', IUser>;
const sessions = {} as Record<'restricted' | 'open', IAgentConversation>;

const sessionHeaders = (who: keyof typeof users) => ({
  'x-tenant-db-name': dbName,
  'x-tenant-id': tenantId,
  'x-tenant-slug': 'restricted-copies',
  'x-user-id': String(users[who]._id),
  'x-user-role': String(users[who].role),
  'x-user-email': String(users[who].email),
  'x-license-type': 'FREE',
  cookie: `active_project_id=${p1}`,
});

async function tokenOf(who: keyof typeof users) {
  const owner = (await db.findUserById(String(users[who]._id)))!;
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: String(owner._id), servicePermissions: null },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'restricted-copies',
    tenantDbName: dbName,
    projectId: p1,
    user: owner,
  });
}

const idOf = (key: keyof typeof sessions) => String(sessions[key]._id);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }) => parseJsonBody<any>(res.body);
const dash = (who: keyof typeof users, url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: sessionHeaders(who) });
const viaToken = (url: string) => app.inject({ method: 'GET', url: `/api${url}`, headers: { authorization: 'Bearer tok' } });

/** The knowledge base the marks name, with access control on (and, unless told otherwise, the admin exception). */
async function knowledgeBase(adminBypass?: boolean) {
  await db.createRagModule({
    tenantId, projectId: p1, key: 'handbook', name: 'Handbook', embeddingModelKey: 'embed', vectorProviderKey: 'qdrant', vectorIndexKey: 'idx',
    chunkConfig: { strategy: 'recursive_character', chunkSize: 1000, chunkOverlap: 200 }, status: 'active', createdBy: 'x',
    access: { enabled: true, ...(adminBypass === undefined ? {} : { adminBypass }) },
  } as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'restricted-copies-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-restricted-copies', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  p1 = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  tag = restrictedKnowledgeTag({ key: 'handbook', projectId: p1 });
  const mk = async (key: keyof typeof users, role: 'owner' | 'user', over: Record<string, unknown> = {}) => {
    users[key] = await db.createUser({ tenantId, email: `${key}@x.io`, name: `Name of ${key}`, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...over } as never);
  };
  await mk('owner', 'owner');
  for (const key of ['starter', 'other', 'kbadmin'] as const) {
    // kbadmin is a member who administers the Knowledge Engine (project-level overrides only ever narrow)
    await mk(key, 'user', key === 'kbadmin' ? { servicePermissions: { rag: 'admin' } } : {});
    await db.upsertUserProject({ tenantId, userId: String(users[key]._id), projectId: p1, role: 'member' } as never);
  }
  const agent = await db.createAgent({ tenantId, projectId: p1, key: 'support', name: 'Support', config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);
  agentId = String(agent._id);

  const starter = String(users.starter._id);
  sessions.restricted = await db.createAgentConversation({
    tenantId, projectId: p1, agentKey: 'support', title: 'Salary bands 2026', messages: [{ role: 'user', content: 'secret salary bands' }],
    metadata: { source: 'console' }, createdBy: starter,
  } as never);
  await db.addAgentConversationRestriction(idOf('restricted'), [tag]);
  sessions.open = await db.createAgentConversation({
    tenantId, projectId: p1, agentKey: 'support', title: 'Holiday calendar', messages: [{ role: 'user', content: 'when is the holiday' }],
    metadata: { source: 'console' }, createdBy: starter,
  } as never);

  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(agentsApiPlugin);
    await instance.register(clientAgentSessionsApiPlugin);
    await instance.register(clientAgentRunsApiPlugin);
    await instance.register(modelsApiPlugin);
    await instance.register(tracingApiPlugin);
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('the Sessions list', () => {
  const rowsFor = async (who: keyof typeof users) => {
    const res = await dash(who, `/agents/${agentId}/sessions`);
    expect(res.statusCode).toBe(200);
    return Object.fromEntries(json(res).sessions.map((s: { _id: string }) => [s._id, s]));
  };

  it('shows a restricted session to the person who had it, title and all', async () => {
    const rows = await rowsFor('starter');
    expect(rows[idOf('restricted')]).toMatchObject({ title: 'Salary bands 2026' });
    expect(rows[idOf('restricted')].restricted).toBeUndefined();
  });

  it('shows another member that it exists, not what it was about', async () => {
    await knowledgeBase();
    const rows = await rowsFor('other');
    expect(rows[idOf('restricted')]).toMatchObject({ restricted: true, createdBy: String(users.starter._id) });
    expect(rows[idOf('restricted')].title).toBeUndefined();
    expect(JSON.stringify(rows[idOf('restricted')])).not.toContain('Salary');
    // a session that drew on nothing restricted is untouched
    expect(rows[idOf('open')]).toMatchObject({ title: 'Holiday calendar' });
  });

  it('shows it whole to an administrator of the knowledge base\'s project (the admin exception)', async () => {
    await knowledgeBase();
    expect((await rowsFor('owner'))[idOf('restricted')]).toMatchObject({ title: 'Salary bands 2026' });
    expect((await rowsFor('kbadmin'))[idOf('restricted')]).toMatchObject({ title: 'Salary bands 2026' });
  });

  it('keeps it from the administrators too when the knowledge base gave up the admin exception', async () => {
    await knowledgeBase(false);
    expect((await rowsFor('owner'))[idOf('restricted')]).toMatchObject({ restricted: true });
    expect((await rowsFor('starter'))[idOf('restricted')]).toMatchObject({ title: 'Salary bands 2026' });
  });
});

describe('one restricted session', () => {
  it('answers 403 session_restricted to another member, without its content', async () => {
    await knowledgeBase();
    const res = await dash('other', `/agents/${agentId}/sessions/${idOf('restricted')}`);
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'session_restricted' });
    expect(res.body).not.toContain('secret salary');
  });

  it('is open to the person who had it and to an administrator', async () => {
    await knowledgeBase();
    expect((await dash('starter', `/agents/${agentId}/sessions/${idOf('restricted')}`)).statusCode).toBe(200);
    const admin = await dash('owner', `/agents/${agentId}/sessions/${idOf('restricted')}`);
    expect(admin.statusCode).toBe(200);
    expect(admin.body).toContain('secret salary');
  });

  it('is not the gate\'s business when it drew on nothing restricted', async () => {
    expect((await dash('other', `/agents/${agentId}/sessions/${idOf('open')}`)).statusCode).toBe(200);
  });
});

describe('through an API token', () => {
  it('the list leaves the title out unless the token is the person\'s who had it', async () => {
    await knowledgeBase();
    await tokenOf('other');
    const theirs = json(await viaToken('/client/v1/agents/sessions?limit=100')).data as Array<{ id: string; title: string | null; restricted?: boolean }>;
    expect(theirs.find((s) => s.id === idOf('restricted'))).toMatchObject({ title: null, restricted: true });
    expect(theirs.find((s) => s.id === idOf('open'))).toMatchObject({ title: 'Holiday calendar' });

    await tokenOf('starter');
    const own = json(await viaToken('/client/v1/agents/sessions?limit=100')).data as Array<{ id: string; title: string | null; restricted?: boolean }>;
    expect(own.find((s) => s.id === idOf('restricted'))).toMatchObject({ title: 'Salary bands 2026' });
  });

  it('a token is never an administrator: the owner\'s token does not read somebody else\'s restricted session', async () => {
    await knowledgeBase();
    await tokenOf('owner');
    const listed = json(await viaToken('/client/v1/agents/sessions?limit=100')).data as Array<{ id: string; restricted?: boolean }>;
    expect(listed.find((s) => s.id === idOf('restricted'))).toMatchObject({ restricted: true });
    const one = await viaToken(`/client/v1/agents/sessions/${idOf('restricted')}`);
    expect(one.statusCode).toBe(403);
    expect(one.body).toContain('session_restricted');
    expect(one.body).not.toContain('secret salary');
  });
});

describe('runs and reminders of a restricted session', () => {
  async function run(over: Record<string, unknown> = {}) {
    return db.createAgentRun({
      tenantId, tenantDbName: dbName, projectId: p1, agentKey: 'support', conversationId: idOf('restricted'), mode: 'background',
      userMessage: 'list the salary bands', status: 'succeeded', userId: String(users.starter._id), ...over,
    } as never);
  }

  it('the runs list keeps the run and leaves its result out for another member', async () => {
    await knowledgeBase();
    await run({ result: { output_text: 'band A is secret' } });
    const forOther = json(await dash('other', `/agents/${agentId}/runs`)).runs as Array<Record<string, unknown>>;
    expect(forOther).toHaveLength(1);
    expect(forOther[0]).toMatchObject({ restricted: true, output_text: null });
    expect(JSON.stringify(forOther[0])).not.toContain('band A');

    const forStarter = json(await dash('starter', `/agents/${agentId}/runs`)).runs as Array<Record<string, unknown>>;
    expect(forStarter[0].restricted).toBeUndefined();
  });

  it('polling the run through a token of another member is viewing the session: refused', async () => {
    await knowledgeBase();
    const created = await run();
    await tokenOf('other');
    const res = await viaToken(`/client/v1/agents/runs/${String(created._id)}`);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('session_restricted');
    await tokenOf('starter');
    expect((await viaToken(`/client/v1/agents/runs/${String(created._id)}`)).statusCode).toBe(200);
  });

  it('a reminder keeps when and whose, not what, for another member', async () => {
    await knowledgeBase();
    await run({ channel: 'reminder', status: 'scheduled', userMessage: 'remind me of band A', notBefore: new Date(Date.now() + 3_600_000) });
    const forOther = json(await dash('other', `/agents/${agentId}/reminders`)).reminders as Array<Record<string, unknown>>;
    expect(forOther).toHaveLength(1);
    expect(forOther[0]).toMatchObject({ message: null, reason: null, restricted: true });
    expect(forOther[0].session_title).toBeUndefined();
    const forStarter = json(await dash('starter', `/agents/${agentId}/reminders`)).reminders as Array<Record<string, unknown>>;
    expect(forStarter[0]).toMatchObject({ message: 'remind me of band A', session_title: 'Salary bands 2026' });
  });
});

describe('the trace of a restricted turn', () => {
  async function trace(sessionId: string, over: Record<string, unknown>) {
    await db.createAgentTracingSession({
      sessionId, tenantId, projectId: p1, agentName: 'support', status: 'success', startedAt: new Date(), endedAt: new Date(), totalEvents: 0,
      userId: String(users.starter._id), ...over,
    } as never);
  }

  it('is refused to another member when its own marks say so (a stateless call: no session to ask)', async () => {
    await knowledgeBase();
    await trace('trace-marked', { kbRestricted: [tag] });
    const res = await dash('other', '/tracing/sessions/trace-marked');
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'session_restricted' });
    expect((await dash('other', '/tracing/sessions/trace-marked/events/e1')).statusCode).toBe(403);
    expect((await dash('starter', '/tracing/sessions/trace-marked')).statusCode).toBe(200);
    expect((await dash('owner', '/tracing/sessions/trace-marked')).statusCode).toBe(200);
  });

  it('is refused to another member when the session it belongs to is restricted', async () => {
    await knowledgeBase();
    await trace('trace-threaded', { threadId: idOf('restricted') });
    expect((await dash('other', '/tracing/sessions/trace-threaded')).statusCode).toBe(403);
    expect((await dash('other', `/tracing/threads/${idOf('restricted')}`)).statusCode).toBe(403);
    expect((await dash('starter', '/tracing/sessions/trace-threaded')).statusCode).toBe(200);
  });

  it('keeps the marks it was stamped with when it is updated', async () => {
    await trace('trace-kept', { kbRestricted: [tag] });
    await db.updateAgentTracingSession?.('trace-kept', { status: 'error' } as never);
    const stored = await db.findAgentTracingSessionById?.('trace-kept');
    if (stored) expect(stored.kbRestricted).toEqual([tag]);
  });
});

describe('model logs', () => {
  let modelId: string;

  beforeEach(async () => {
    const model = await db.createModel({
      key: 'gpt', name: 'GPT', providerKey: 'openai', providerDriver: 'openai', category: 'llm', modelId: 'gpt', projectId: p1, tenantId,
      settings: {}, pricing: { inputTokenPer1M: 0, outputTokenPer1M: 0 },
    } as never);
    modelId = String(model._id);
    const log = (requestId: string, over: Record<string, unknown>) => db.createModelUsageLog({
      tenantId, projectId: p1, modelKey: 'gpt', requestId, route: 'chat.completions', status: 'success',
      providerRequest: { messages: [{ role: 'user', content: `request ${requestId}` }] }, providerResponse: { text: `answer ${requestId}` },
      inputTokens: 10, outputTokens: 5, totalTokens: 15, userId: String(users.starter._id), ...over,
    } as never);
    await log('marked', { kbRestricted: [tag] });
    await log('plain', {});
  });

  it('a call that carried restricted passages keeps its numbers, not its text, for another member', async () => {
    await knowledgeBase();
    const res = await dash('other', `/models/${modelId}/logs`);
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(json(res).logs.map((l: { requestId: string }) => [l.requestId, l]));
    expect(byId.marked).toMatchObject({ restricted: true, inputTokens: 10, outputTokens: 5 });
    expect(byId.marked.providerRequest).toBeUndefined();
    expect(byId.marked.providerResponse).toBeUndefined();
    expect(byId.plain.providerRequest).toBeDefined();
  });

  it('shows the text to the person who made the call and to an administrator', async () => {
    await knowledgeBase();
    const forStarter = json(await dash('starter', `/models/${modelId}/logs`)).logs as Array<{ requestId: string; providerRequest?: unknown }>;
    expect(forStarter.find((l) => l.requestId === 'marked')?.providerRequest).toBeDefined();
    const forOwner = json(await dash('owner', `/models/${modelId}/logs`)).logs as Array<{ requestId: string; providerRequest?: unknown }>;
    expect(forOwner.find((l) => l.requestId === 'marked')?.providerRequest).toBeDefined();
  });
});
