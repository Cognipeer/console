/**
 * Regression tests for the findings of the F2 review of the IAM integration, at the REAL routes, the REAL
 * gate and the REAL policy engine, over a real SQLite provider:
 *
 *  - IAM-1  thread metadata cannot write the session's tool allow-list (or any other server-owned key);
 *  - IAM-2  a manifest import asks the same Files question as a create or an update;
 *  - IAM-3  a session that cannot be read is "unavailable", never "not a session, so allowed";
 *  - IAM-4  the sessions of a deleted agent are somebody else's like any other, in every list;
 *  - IAM-5  a list's scope costs no question per agent for the default caller, and little for the rest;
 *  - IAM-7  an engine outage under a client list is a 503 to retry, not a 500;
 *  - IAM-8  the default needs the `agents` service (said in the docs, pinned here);
 *  - IAM-9  a restricted caller's page is filled, and says where it goes on from.
 *
 * (IAM-6, the webhook address, and IAM-10, the open stream, have their own unit tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  requireApiToken: vi.fn(),
  engine: { down: false as boolean, only: null as null | string, calls: [] as string[], policySetDown: false as boolean },
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
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    // The policy set a list's scope is decided from, when the test says it cannot be loaded.
    describeTenantPolicySet: (tenant: Parameters<typeof actual.describeTenantPolicySet>[0]) => (hoisted.engine.policySetDown
      ? Promise.reject(new Error('the policy set cannot be loaded'))
      : actual.describeTenantPolicySet(tenant)),
    authorize: (input: Parameters<typeof actual.authorize>[0]) => {
      hoisted.engine.calls.push(input.action);
      return hoisted.engine.down && (!hoisted.engine.only || input.action.startsWith(hoisted.engine.only))
        ? Promise.resolve({ allowed: false, reasons: [], errors: ['the engine is down'], obligations: {}, durationUs: 0, failed: true } as Awaited<ReturnType<typeof actual.authorize>>)
        : actual.authorize(input);
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { encryptObject } from '@/lib/utils/crypto';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { compileSpec, type PolicySpec } from '@/lib/iam/policySpec';
import { createPolicy } from '@/lib/iam/store';
import { AGENT_MANIFEST_API_VERSION } from '@/lib/services/agents/agentManifest';
import { sessionAllowedTools } from '@/lib/services/agents/agentHumanInTheLoop';
import { listSkills } from '@/lib/services/agents/skillService';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { clientAgentRunsApiPlugin } from '@/server/api/plugins/client-agent-runs';
import { clientAgentSessionsApiPlugin } from '@/server/api/plugins/client-agent-sessions';
import { clientAssistantsApiPlugin } from '@/server/api/plugins/client-assistants';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { clientTracingApiPlugin } from '@/server/api/plugins/client-tracing';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { resetSessionAccessCachesForTests, sessionStreamStillAllowed } from '@/server/api/plugins/agent-session-access';
import { tracingApiPlugin } from '@/server/api/plugins/tracing';
import { ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { withApiRequestContext, withClientApiRequestContext } from '@/server/api/fastify-utils';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

let db: SQLiteProvider;
let tmpDir: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId: string;
let p1: string;
const dbName = 'tenant_iam_review';
const users = {} as Record<'admin' | 'starter' | 'other' | 'writer' | 'tracer', IUser>;
const bucketIds = {} as Record<'docs' | 'secret', string>;
const agentIds = {} as Record<string, string>;

const sessionHeaders = (who: keyof typeof users) => ({
  'x-tenant-db-name': dbName,
  'x-tenant-id': tenantId,
  'x-tenant-slug': 'iam-review',
  'x-user-id': String(users[who]._id),
  'x-user-role': String(users[who].role),
  'x-user-email': String(users[who].email),
  'x-license-type': 'FREE',
  cookie: `active_project_id=${p1}`,
});

async function tokenOf(who: keyof typeof users, scope: Record<string, string> | null = null) {
  const owner = (await db.findUserById(String(users[who]._id)))!;
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: String(owner._id), servicePermissions: scope },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'iam-review',
    tenantDbName: dbName,
    projectId: p1,
    user: owner,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: { body: string }) => parseJsonBody<any>(res.body);
const dash = (who: keyof typeof users, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, headers: { ...sessionHeaders(who), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
const viaToken = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api${url}`, headers: { authorization: 'Bearer tok', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
const decisions = (action: string) => hoisted.engine.calls.filter((a) => a === action).length;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 3));
/** What happens to the stored state between the two questions of the stream probes. */
const probeBetween: { run: null | (() => Promise<void>) } = { run: null };

type Resources = PolicySpec['resources'];
/** A deny written the way the visual editor writes it. */
async function denyFor(action: string, who: keyof typeof users, resources: Resources = { any: true }) {
  const compiled = await compileSpec({ effect: 'forbid', principals: { users: [String(users[who]._id)] }, actions: [action], resources });
  expect(compiled.errors, JSON.stringify(compiled.errors)).toEqual([]);
  await createPolicy(dbName, { policyId: `deny-${action}-${who}-${Math.random()}`, name: `${who} may not (${action})`, cedar: compiled.cedar, spec: compiled.spec }, 'tester');
  resetIamEngineForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
}

/** A custom rule that changes nothing a test below asks about: it only makes the policy set "custom". */
async function addUnrelatedCustomRule() {
  await denyFor('agent.approve', 'admin');
}

const conv = (createdBy: string, agentKey: string, title: string) => db.createAgentConversation({
  tenantId, projectId: p1, agentKey, title, messages: [{ role: 'user', content: title }], metadata: { source: 'console' }, createdBy,
} as never);

async function traceOf(conversationId: string, sessionId: string) {
  await db.createAgentTracingSession({
    sessionId, threadId: conversationId, tenantId, projectId: p1, agentName: 'bot-1', status: 'success',
    startedAt: new Date(), endedAt: new Date(), totalEvents: 0,
  } as never);
  await tick();
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.engine.down = false;
  hoisted.engine.only = null;
  hoisted.engine.calls = [];
  hoisted.engine.policySetDown = false;
  probeBetween.run = null;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'iam-review-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  resetPrincipalCacheForTests();
  resetIamEngineForTests();
  resetProjectNarrowingCachesForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
  resetSessionAccessCachesForTests();
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-iam-review', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  p1 = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
  const mk = async (key: keyof typeof users, role: 'admin' | 'user', servicePermissions?: Record<string, string>) => {
    users[key] = await db.createUser({ tenantId, email: `${key}@x.io`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...(servicePermissions ? { servicePermissions } : {}) } as never);
    await db.upsertUserProject({ tenantId, userId: String(users[key]._id), projectId: p1, role: 'member' } as never);
  };
  await mk('admin', 'admin');
  await mk('starter', 'user');
  await mk('other', 'user');
  await mk('writer', 'user', { agents: 'write', files: 'write' });
  await mk('tracer', 'user', { agents: 'none', tracing: 'read' });

  await db.createProvider({ tenantId, projectId: p1, key: 'local', type: 'file', driver: 'local-filesystem', label: 'Local', status: 'active', credentialsEnc: encryptObject({}), settings: { basePath: tmpDir }, createdBy: 'x' });
  for (const key of ['docs', 'secret'] as const) {
    const bucket = await db.createFileBucket({ tenantId, projectId: p1, key, name: key, providerKey: 'local', status: 'active', createdBy: 'x' } as never);
    bucketIds[key] = String(bucket._id);
  }
  for (let i = 0; i < 6; i += 1) {
    const agent = await db.createAgent({ tenantId, projectId: p1, key: `bot-${i}`, name: `Bot ${i}`, config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);
    agentIds[`bot-${i}`] = String(agent._id);
  }

  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(agentsApiPlugin);
    await instance.register(clientAgentRunsApiPlugin);
    await instance.register(clientAgentSessionsApiPlugin);
    await instance.register(clientAssistantsApiPlugin);
    await instance.register(clientFilesApiPlugin);
    await instance.register(clientTracingApiPlugin);
    await instance.register(filesApiPlugin);
    await instance.register(tracingApiPlugin);
    // Stand-ins for an event stream that is already open: the same request asks "may the viewer still watch?" twice,
    // with `between` (a change in the stored state) in between, and reports both answers.
    const stillAllowedTwice = async (request: Parameters<typeof sessionStreamStillAllowed>[0], id: string, projectId: string) => {
      const before = await sessionStreamStillAllowed(request, id, { projectId });
      await probeBetween.run?.();
      const after = await sessionStreamStillAllowed(request, id, { projectId });
      return { before, after };
    };
    instance.get('/agents/probe-stream/:id', withApiRequestContext(async (request, reply) => reply.send(await stillAllowedTwice(request, (request.params as { id: string }).id, p1))));
    instance.get('/client/v1/agents/probe-stream/:id', withClientApiRequestContext(async (request, reply) => reply.send(await stillAllowedTwice(request, (request.params as { id: string }).id, p1))));
  });
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  await drainPendingTasks();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── IAM-1 ────────────────────────────────────────────────────────────────

describe('IAM-1: thread metadata is the caller\'s, not the server\'s', () => {
  const patchThread = (conversationId: string, metadata: Record<string, unknown>) =>
    viaToken('POST', `/client/v1/threads/thread_${conversationId}`, { metadata });

  it('cannot write the session\'s tool allow-list, however the key is spelled in the body', async () => {
    const thread = await db.createAgentConversation({
      tenantId, projectId: p1, agentKey: 'bot-1', title: 't', messages: [], metadata: { source: 'api' }, createdBy: String(users.other._id),
    } as never);
    await tokenOf('starter'); // not the owner: a writer may manage somebody else's thread by default
    const res = await patchThread(String(thread._id), { hitlAllowedTools: ['sandbox_exec', 'any_tool'], colour: 'red' });
    expect(res.statusCode).toBe(200);
    const stored = await db.findAgentConversationById(String(thread._id));
    expect([...sessionAllowedTools(stored?.metadata as never)]).toEqual([]);
    expect(stored?.metadata?.hitlAllowedTools).toBeUndefined();
    // what is the caller's stays the caller's
    expect(stored?.metadata?.colour).toBe('red');
    expect(stored?.metadata?.source).toBe('api');
  });

  it('leaves an allow-list that a person\'s approval built exactly as it was', async () => {
    const thread = await db.createAgentConversation({
      tenantId, projectId: p1, agentKey: 'bot-1', title: 't', messages: [], createdBy: String(users.starter._id),
      metadata: { source: 'api', hitlAllowedTools: ['web_search'], runtimeContext: { tenant: 'a' }, portalId: 'p', channel: 'portal' },
    } as never);
    await tokenOf('starter');
    const res = await patchThread(String(thread._id), {
      hitlAllowedTools: [], source: 'console', runtimeContext: { tenant: 'b' }, portalId: 'other', channel: 'api', sandbox: { id: 'someone-elses' }, assistantsApi: { runs: [] }, clientMetadata: { a: 'b' },
    });
    expect(res.statusCode).toBe(200);
    const metadata = (await db.findAgentConversationById(String(thread._id)))?.metadata as Record<string, unknown>;
    expect(metadata.hitlAllowedTools).toEqual(['web_search']);
    expect(metadata.source).toBe('api');
    expect(metadata.runtimeContext).toEqual({ tenant: 'a' });
    expect(metadata.portalId).toBe('p');
    expect(metadata.channel).toBe('portal');
    expect(metadata.sandbox).toBeUndefined();
    expect(metadata.clientMetadata).toBeUndefined();
  });
});

// ── IAM-2 ────────────────────────────────────────────────────────────────

describe('IAM-2: importing an agent names a bucket only with the right to name it', () => {
  const manifestOf = (key: string, bucketKey: string | null, extra: Record<string, unknown> = {}) => ({
    apiVersion: AGENT_MANIFEST_API_VERSION,
    kind: 'Agent',
    metadata: { key, name: key, exportedAt: new Date().toISOString() },
    spec: { modelKey: 'm', ...(bucketKey ? { attachments: { enabled: true, bucketKey } } : {}) },
    dependencies: [],
    ...extra,
  });
  const importManifest = (who: keyof typeof users, manifest: unknown, mode = 'create') => dash(who, 'POST', '/agents/import', { manifest, mode });
  const importDocument = (who: keyof typeof users, manifest: unknown, overwrite = false) =>
    dash(who, 'POST', '/agents/import/document', { content: JSON.stringify(manifest), format: 'cognipeer', overwrite });
  const bucketOf = async (key: string) => (await db.findAgentByKey(key, p1))?.config?.attachments?.bucketKey;

  beforeEach(async () => {
    await denyFor('file-bucket.update', 'writer', { resources: [{ type: 'file-bucket', id: bucketIds.secret }] });
  });

  it('refuses a create that names a bucket the writer may not name (403, with the decision), and stores nothing', async () => {
    const res = await importManifest('writer', manifestOf('named-bucket', 'secret'));
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'files_write_required', field: 'attachments.bucketKey' });
    expect(typeof json(res).decisionId).toBe('string');
    expect(await db.findAgentByKey('named-bucket', p1)).toBeNull();
  });

  it('lets the same writer import into a bucket the rule does not cover, and an agent with no bucket', async () => {
    expect((await importManifest('writer', manifestOf('fine', 'docs'))).statusCode).toBe(201);
    expect(await bucketOf('fine')).toBe('docs');
    expect((await importManifest('writer', manifestOf('plain', null))).statusCode).toBe(201);
  });

  it('refuses an upsert that CHANGES the bucket to one the writer may not name, and keeps what was stored', async () => {
    await db.createAgent({ tenantId, projectId: p1, key: 'existing', name: 'E', config: { modelKey: 'm', attachments: { enabled: true, bucketKey: 'docs' } }, status: 'active', createdBy: 'x' } as never);
    const res = await importManifest('writer', manifestOf('existing', 'secret'), 'upsert');
    expect(res.statusCode).toBe(403);
    expect(await bucketOf('existing')).toBe('docs');
  });

  it('asks nothing of Files when the import keeps the bucket the agent already has', async () => {
    await db.createAgent({ tenantId, projectId: p1, key: 'kept', name: 'K', config: { modelKey: 'm', attachments: { enabled: true, bucketKey: 'secret' } }, status: 'active', createdBy: 'x' } as never);
    const res = await importManifest('writer', manifestOf('kept', 'secret'), 'upsert');
    expect(res.statusCode).toBe(200);
  });

  it('a dry run writes nothing and asks nothing', async () => {
    const res = await dash('writer', 'POST', '/agents/import', { manifest: manifestOf('dry', 'secret'), dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(await db.findAgentByKey('dry', p1)).toBeNull();
  });

  it('the document import refuses too - before it creates the skills and prompts the document embeds', async () => {
    const manifest = manifestOf('doc-agent', 'secret', { resources: { skills: [{ key: 'embedded-skill', title: 'T', header: 'H', body: 'B' }] } });
    const res = await importDocument('writer', manifest);
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ code: 'files_write_required' });
    expect(await db.findAgentByKey('doc-agent', p1)).toBeNull();
    expect((await listSkills(dbName, p1)).map((skill) => skill.key)).not.toContain('embedded-skill');
    // and the same document into a bucket the writer may name is imported
    const allowed = await importDocument('writer', manifestOf('doc-agent', 'docs'));
    expect(allowed.statusCode).toBe(201);
    expect(await bucketOf('doc-agent')).toBe('docs');
  });

  it('is a 503 when the engine cannot decide - never an import', async () => {
    hoisted.engine.down = true;
    hoisted.engine.only = 'file-bucket.';
    const res = await importManifest('writer', manifestOf('outage', 'docs'));
    expect(res.statusCode).toBe(503);
    expect(await db.findAgentByKey('outage', p1)).toBeNull();
  });
});

// ── IAM-3 ────────────────────────────────────────────────────────────────

describe('IAM-3: a session that cannot be read is unavailable, never "not a session, so allowed"', () => {
  it('a tracing thread whose conversation cannot be read answers 503, not the thread', async () => {
    const owned = await conv(String(users.other._id), 'bot-1', 'someone else\'s');
    await traceOf(String(owned._id), 'trace-1');
    vi.spyOn(db, 'findAgentConversationById').mockRejectedValue(new Error('cosmos 429 TooManyRequests'));
    const res = await dash('starter', 'GET', `/tracing/threads/${String(owned._id)}`);
    expect(res.statusCode).toBe(503);
    expect(json(res).code).toBe('authorization_unavailable');
    expect((await dash('starter', 'GET', '/tracing/sessions/trace-1')).statusCode).toBe(503);
  });

  it('an id that is no conversation id is a clean "not found": the tracing store answers it, the permission does not', async () => {
    expect((await dash('starter', 'GET', '/tracing/threads/another-producers-thread')).statusCode).toBe(404);
  });

  it('polling or cancelling a run whose session cannot be read is a 503 and leaves the run alone', async () => {
    const owned = await conv(String(users.other._id), 'bot-1', 'someone else\'s');
    const run = await db.createAgentRun({
      mode: 'background', tenantId, tenantDbName: dbName, projectId: p1, agentKey: 'bot-1', conversationId: String(owned._id), userMessage: 'hi', status: 'queued', userId: String(users.other._id),
    } as never);
    await tokenOf('starter');
    vi.spyOn(db, 'findAgentConversationById').mockRejectedValue(new Error('cosmos 429 TooManyRequests'));
    const polled = await viaToken('GET', `/client/v1/agents/runs/${String(run._id)}`);
    expect(polled.statusCode).toBe(503);
    expect(json(polled).error.code).toBe('authorization_unavailable');
    const cancelled = await viaToken('POST', `/client/v1/agents/runs/${String(run._id)}/cancel`, {});
    expect(cancelled.statusCode).toBe(503);
    vi.restoreAllMocks();
    expect((await db.getAgentRunById(String(run._id), tenantId, p1))?.status).toBe('queued');
  });

  it('a list fails as a whole when a row\'s session cannot be read, for a caller whose view is restricted', async () => {
    const owned = await conv(String(users.other._id), 'bot-1', 'someone else\'s');
    await traceOf(String(owned._id), 'trace-1');
    await denyFor('agent.session_view_others', 'starter');
    vi.spyOn(db, 'findAgentConversationById').mockRejectedValue(new Error('cosmos 429 TooManyRequests'));
    const res = await dash('starter', 'GET', '/tracing/threads');
    expect(res.statusCode).toBe(503);
  });
});

// ── IAM-4 ────────────────────────────────────────────────────────────────

describe('IAM-4: the sessions of a deleted agent are somebody else\'s like any other', () => {
  const titles = async () => (json(await viaToken('GET', '/client/v1/agents/sessions?limit=100')).data as Array<{ title: string }>).map((s) => s.title).sort();

  beforeEach(async () => {
    await conv(String(users.other._id), 'bot-1', 'live of other');
    await conv(String(users.other._id), 'deleted-agent', 'ghost of other');
    await conv(String(users.starter._id), 'deleted-agent', 'ghost of mine');
    await conv(String(users.starter._id), 'bot-1', 'live of mine');
  });

  it('is open to everybody by default, ghosts included', async () => {
    await tokenOf('starter');
    expect(await titles()).toEqual(['ghost of mine', 'ghost of other', 'live of mine', 'live of other']);
  });

  it('a caller denied viewing others\' sessions sees only their own, the deleted agent\'s included', async () => {
    await denyFor('agent.session_view_others', 'starter');
    await tokenOf('starter');
    expect(await titles()).toEqual(['ghost of mine', 'live of mine']);
    // naming the deleted agent changes nothing
    const byAgent = json(await viaToken('GET', '/client/v1/agents/sessions?agent=deleted-agent')).data as Array<{ title: string }>;
    expect(byAgent.map((s) => s.title)).toEqual(['ghost of mine']);
    // and opening one by id agrees with the list
    const ghost = (await db.listAgentConversations('deleted-agent', { projectId: p1 })).find((c) => c.title === 'ghost of other')!;
    expect((await viaToken('GET', `/client/v1/agents/sessions/${String(ghost._id)}`)).statusCode).toBe(403);
  });

  it('a rule about ONE agent cuts that agent and the deleted ones, and leaves the other agents whole', async () => {
    await conv(String(users.other._id), 'bot-2', 'bot-2 of other');
    await denyFor('agent.session_view_others', 'starter', { resources: [{ type: 'agent', id: agentIds['bot-1'] }] });
    await tokenOf('starter');
    expect(await titles()).toEqual(['bot-2 of other', 'ghost of mine', 'live of mine']);
  });

  it('with no agent left in the project, a rule that covers every agent still cuts the deleted ones', async () => {
    for (const id of Object.values(agentIds)) await db.deleteAgent(id);
    await denyFor('agent.session_view_others', 'starter');
    await tokenOf('starter');
    expect(await titles()).toEqual(['ghost of mine', 'live of mine']);
  });

  it('the tracing list leaves out the thread of a deleted agent\'s session as well', async () => {
    const ghost = (await db.listAgentConversations('deleted-agent', { projectId: p1 })).find((c) => c.title === 'ghost of other')!;
    const mine = (await db.listAgentConversations('deleted-agent', { projectId: p1 })).find((c) => c.title === 'ghost of mine')!;
    await traceOf(String(ghost._id), 'trace-ghost');
    await traceOf(String(mine._id), 'trace-mine');
    await denyFor('agent.session_view_others', 'starter');
    const threads = json(await dash('starter', 'GET', '/tracing/threads')).threads as Array<{ threadId: string }>;
    expect(threads.map((t) => t.threadId)).toEqual([String(mine._id)]);
  });
});

// ── IAM-5 ────────────────────────────────────────────────────────────────

describe('IAM-5: what a list\'s scope costs', () => {
  it('the default caller (no custom rule in force) costs no question per agent, on any list', async () => {
    await tokenOf('starter');
    expect((await dash('starter', 'GET', '/tracing/threads')).statusCode).toBe(200);
    expect((await viaToken('GET', '/client/v1/agents/sessions')).statusCode).toBe(200);
    expect((await viaToken('GET', '/client/v1/tracing/threads')).statusCode).toBe(200);
    expect(decisions('agent.session_view_others')).toBe(0);
  });

  it('reaches the same verdict as the engine does for every level of the `agents` service', async () => {
    // a thread of somebody else, then who may list it: by the arithmetic (no custom rule) and by the engine (one custom rule)
    const owned = await conv(String(users.other._id), 'bot-1', 'someone else\'s');
    await traceOf(String(owned._id), 'trace-1');
    const seen = async () => {
      const out: Record<string, number> = {};
      for (const who of ['admin', 'starter', 'writer', 'tracer'] as const) {
        resetSessionAccessCachesForTests();
        out[who] = (json(await dash(who, 'GET', '/tracing/threads')).threads as unknown[]).length;
      }
      return out;
    };
    const byArithmetic = await seen();
    expect(byArithmetic).toEqual({ admin: 1, starter: 1, writer: 1, tracer: 0 });
    expect(decisions('agent.session_view_others')).toBe(0);
    await addUnrelatedCustomRule();
    expect(await seen()).toEqual(byArithmetic);
    expect(decisions('agent.session_view_others')).toBeGreaterThan(0);
  });

  it('with custom rules the answer is kept for a few seconds per person and policy version, and follows a policy change at once', async () => {
    await addUnrelatedCustomRule();
    expect((await dash('starter', 'GET', '/tracing/threads')).statusCode).toBe(200);
    const first = decisions('agent.session_view_others');
    expect(first).toBeGreaterThanOrEqual(6); // one per agent of the project (and one for the deleted ones)
    hoisted.engine.calls = [];
    expect((await dash('starter', 'GET', '/tracing/threads')).statusCode).toBe(200);
    expect((await dash('starter', 'GET', '/tracing/threads')).statusCode).toBe(200);
    expect(decisions('agent.session_view_others')).toBe(0);
    // a new rule is a new policy version: the next list is decided again
    const owned = await conv(String(users.other._id), 'bot-1', 'someone else\'s');
    await traceOf(String(owned._id), 'trace-1');
    expect((json(await dash('starter', 'GET', '/tracing/threads')).threads as unknown[])).toHaveLength(1);
    await denyFor('agent.session_view_others', 'starter');
    expect((json(await dash('starter', 'GET', '/tracing/threads')).threads as unknown[])).toHaveLength(0);
    expect(decisions('agent.session_view_others')).toBeGreaterThan(0);
  });

  it('a policy set that cannot be loaded is a 503 under a list, not an unrestricted list', async () => {
    await tokenOf('starter');
    hoisted.engine.policySetDown = true;
    const res = await viaToken('GET', '/client/v1/agents/sessions');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

// ── IAM-7 ────────────────────────────────────────────────────────────────

describe('IAM-7: an engine outage under a client list is a 503 to retry', () => {
  beforeEach(async () => {
    // custom rules in force: the scope is then a question to the engine, per agent
    await addUnrelatedCustomRule();
    await tokenOf('starter');
    hoisted.engine.down = true;
    hoisted.engine.only = 'agent.session_view_others';
  });

  const expectUnavailable = (res: { statusCode: number; headers: Record<string, unknown>; body: string }) => {
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeDefined();
    expect(json(res).error.code).toBe('authorization_unavailable');
  };

  it('the sessions list', async () => {
    expectUnavailable(await viaToken('GET', '/client/v1/agents/sessions'));
  });

  it('the tracing threads list', async () => {
    expectUnavailable(await viaToken('GET', '/client/v1/tracing/threads'));
  });

  it('the Files object list', async () => {
    expectUnavailable(await viaToken('GET', '/client/v1/files/buckets/docs/objects'));
  });

  it('the dashboard lists answer 503 as before', async () => {
    expect((await dash('starter', 'GET', '/tracing/threads')).statusCode).toBe(503);
    expect((await dash('starter', 'GET', '/files/buckets/docs/objects')).statusCode).toBe(503);
  });
});

// ── IAM-8 ────────────────────────────────────────────────────────────────

describe('IAM-8: the default needs the `agents` service, and the docs say so', () => {
  it('a tracing-only reader does not reach agent sessions (403) and sees none of their threads', async () => {
    const owned = await conv(String(users.other._id), 'bot-1', 'someone else\'s');
    await traceOf(String(owned._id), 'trace-1');
    expect((await dash('tracer', 'GET', `/tracing/threads/${String(owned._id)}`)).statusCode).toBe(403);
    expect((json(await dash('tracer', 'GET', '/tracing/threads')).threads as unknown[])).toHaveLength(0);
    // a thread of some other producer is the tracing store's: a 404 there, not a 403
    expect((await dash('tracer', 'GET', '/tracing/threads/another-producers-thread')).statusCode).toBe(404);
  });

  it('the authorization guide, the Tracing guide and the Files guide state it instead of "as before"', () => {
    const root = path.resolve(__dirname, '../../..');
    const authorization = readFileSync(path.join(root, 'docs/guide/authorization.md'), 'utf8');
    expect(authorization).toMatch(/Tracing[^\n]*Files[^\n]*(no|without|not hold)[^\n]*Agents/i);
    for (const guide of ['docs/guide/tracing.md', 'docs/guide/files.md']) {
      expect(readFileSync(path.join(root, guide), 'utf8'), guide).toMatch(/Agents[^\n]*(Read|read)[^\n]*(session|thread)/);
    }
  });
});

// ── IAM-9 ────────────────────────────────────────────────────────────────

describe('IAM-9: a restricted caller\'s page is filled, and says where it goes on from', () => {
  /** `mine` of the caller's sessions, at the OLD end of the list, behind `others` of somebody else's. */
  async function seedThreads(mine: number, others: number) {
    for (let i = 0; i < mine; i += 1) await traceOf(String((await conv(String(users.starter._id), 'bot-1', `mine ${i}`))._id), `trace-mine-${i}`);
    for (let i = 0; i < others; i += 1) await traceOf(String((await conv(String(users.other._id), 'bot-1', `other ${i}`))._id), `trace-other-${i}`);
  }
  const page = async (query: string) => json(await dash('starter', 'GET', `/tracing/threads?${query}`));

  it('the default caller still gets the page as the database cut it, with its total', async () => {
    await seedThreads(2, 25);
    const body = await page('limit=10');
    expect(body.threads).toHaveLength(10);
    expect(body.total).toBe(27);
    expect(body.nextSkip).toBeUndefined();
  });

  it('reads on past rows it must drop, so the caller\'s own sessions are not hidden behind a busy colleague\'s', async () => {
    await seedThreads(3, 25);
    await denyFor('agent.session_view_others', 'starter');
    const body = await page('limit=10');
    expect(body.threads).toHaveLength(3);
    expect(body.hasMore).toBe(false);
    expect(body.nextSkip).toBeNull();
    // there is no total to recompute: it is not known without reading everything
    expect(body.total).toBeUndefined();
  });

  it('pages through the caller\'s own sessions with nextSkip: every one once, every page full but the last', async () => {
    await seedThreads(12, 30);
    await denyFor('agent.session_view_others', 'starter');
    const seen: string[] = [];
    const sizes: number[] = [];
    let skip = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const body = await page(`limit=5&skip=${skip}`);
      sizes.push(body.threads.length);
      seen.push(...body.threads.map((t: { threadId: string }) => t.threadId));
      if (!body.hasMore) break;
      skip = body.nextSkip;
    }
    expect(sizes).toEqual([5, 5, 2]);
    expect(new Set(seen).size).toBe(12);
    const mine = new Set((await db.listAgentConversations('bot-1', { projectId: p1, createdBy: String(users.starter._id) })).map((c) => String(c._id)));
    expect(new Set(seen)).toEqual(mine);
  });

  it('the client API pages the same way', async () => {
    await seedThreads(3, 25);
    await denyFor('agent.session_view_others', 'starter');
    await tokenOf('starter');
    const body = json(await viaToken('GET', '/client/v1/tracing/threads?limit=10'));
    expect(body.threads).toHaveLength(3);
    expect(body.hasMore).toBe(false);
  });

  it('a Files listing (a folder of a bucket) is filled from the following pages too, and its cursor goes on from the last row it returned', async () => {
    const file = (key: string, conversationId: string) => db.createFileRecord({
      tenantId, projectId: p1, providerKey: 'local', bucketKey: 'docs', key, name: key, size: 3, markdownStatus: 'none',
      purpose: 'conversation', conversationId, agentKey: 'bot-1', createdBy: 'x', uploadedBy: 'x',
    } as never);
    const theirs = await conv(String(users.other._id), 'bot-1', 'theirs');
    const mine = await conv(String(users.starter._id), 'bot-1', 'mine');
    for (let i = 0; i < 12; i += 1) await file(`a-${String(i).padStart(2, '0')}.txt`, String(theirs._id));
    for (let i = 0; i < 4; i += 1) await file(`z-${i}.txt`, String(mine._id));
    await denyFor('agent.session_view_others', 'starter');

    const collected: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const body = json(await dash('starter', 'GET', `/files/buckets/docs/objects?prefix=&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      sizes.push(body.items.length);
      collected.push(...body.items.map((i: { key: string }) => i.key));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(collected).toEqual(['z-0.txt', 'z-1.txt', 'z-2.txt', 'z-3.txt']);
    expect(sizes).toEqual([3, 1]);

    await tokenOf('starter');
    const viaClient = json(await viaToken('GET', '/client/v1/files/buckets/docs/objects?prefix=&limit=3'));
    expect(viaClient.files.map((f: { key: string }) => f.key)).toEqual(['z-0.txt', 'z-1.txt', 'z-2.txt']);
    expect(viaClient.count).toBe(3);
    expect(viaClient.nextCursor).toBeDefined();
  });
});

// ── IAM-10 ───────────────────────────────────────────────────────────────

describe('IAM-10: an open event stream is checked again', () => {
  let theirs: string;
  beforeEach(async () => {
    theirs = String((await conv(String(users.other._id), 'bot-1', 'someone else\'s'))._id);
  });

  it('a rule written while the stream is open ends it for the viewer it stops, not for the others', async () => {
    probeBetween.run = () => denyFor('agent.session_view_others', 'starter');
    expect(json(await dash('starter', 'GET', `/agents/probe-stream/${theirs}`))).toEqual({ before: true, after: false });
    probeBetween.run = null;
    expect(json(await dash('admin', 'GET', `/agents/probe-stream/${theirs}`))).toEqual({ before: true, after: true });
  });

  it('the person who started the session keeps watching it', async () => {
    probeBetween.run = () => denyFor('agent.session_view_others', 'other');
    expect(json(await dash('other', 'GET', `/agents/probe-stream/${theirs}`))).toEqual({ before: true, after: true });
  });

  it('a removed permission ends it, even for the person who started the session', async () => {
    const mine = String((await conv(String(users.starter._id), 'bot-1', 'mine'))._id);
    probeBetween.run = async () => { await db.updateUser(String(users.starter._id), { servicePermissions: { agents: 'none' } } as never); };
    expect(json(await dash('starter', 'GET', `/agents/probe-stream/${mine}`))).toEqual({ before: true, after: false });
  });

  it('a token that is revoked while the stream is open ends it', async () => {
    await tokenOf('starter');
    probeBetween.run = async () => { hoisted.requireApiToken.mockRejectedValue(new ApiTokenAuthError('Token revoked', 401)); };
    expect(json(await viaToken('GET', `/client/v1/agents/probe-stream/${theirs}`))).toEqual({ before: true, after: false });
  });

  it('a session that is gone, or one the store cannot read, ends it', async () => {
    probeBetween.run = async () => { await db.deleteAgentConversation(theirs); };
    expect(json(await dash('starter', 'GET', `/agents/probe-stream/${theirs}`))).toEqual({ before: true, after: false });
    const again = String((await conv(String(users.other._id), 'bot-1', 'again'))._id);
    probeBetween.run = async () => { vi.spyOn(db, 'findAgentConversationById').mockRejectedValue(new Error('cosmos 429')); };
    expect(json(await dash('starter', 'GET', `/agents/probe-stream/${again}`))).toEqual({ before: true, after: false });
  });
});
