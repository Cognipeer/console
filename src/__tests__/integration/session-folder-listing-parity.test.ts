/**
 * The Document Store's FOLDER view and the sessions it names - through the real routes, the real gate and
 * the real policy engine, over BOTH database providers (SQLite and, when mongodb-memory-server is installed,
 * MongoDB).
 *
 * A session's files are stored in `<folder>/<agentKey>/<sessionId>/`, so listing `<folder>/<agentKey>/` shows
 * one sub-folder per session, named by the session's id. Somebody who may not view another person's sessions
 * (`agent.session_view_others`, restricted by an ordinary deny rule) must not learn that those sessions exist
 * from the folder rows any more than from their files: the dashboard listing and the client Files API leave
 * them out, the page is filled with what the caller may see (a folder counts as an entry, as it does in the
 * read), and the decision behind it is taken once per request, however many folders the page holds.
 *
 * What only a real provider can show: a session id is a UUID on SQLite and an ObjectId on MongoDB, and the
 * names of the folders that are NOT sessions ("agent-sessions", "support", "2024") are looked up too - the
 * store has to answer "no such session" for them, not fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const hoisted = vi.hoisted(() => ({
  db: { current: null as unknown },
  requireApiToken: vi.fn(),
  viewDecisions: { count: 0 },
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn(async () => hoisted.db.current),
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = hoisted.db.current as any;
      return db.runWithTenant ? db.runWithTenant(tenantDbName, () => fn(db)) : fn(db);
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
// Counts the questions asked about "may this caller view the sessions of an agent others started".
vi.mock('@/lib/iam/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/iam/engine')>();
  return {
    ...actual,
    authorize: (input: Parameters<typeof actual.authorize>[0]) => {
      if (input.action === 'agent.session_view_others') hoisted.viewDecisions.count += 1;
      return actual.authorize(input);
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { encryptObject } from '@/lib/utils/crypto';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { compileSpec } from '@/lib/iam/policySpec';
import { createPolicy } from '@/lib/iam/store';
import { resetSessionAccessCachesForTests } from '@/server/api/plugins/agent-session-access';
import { sessionOfFolder } from '@/server/api/plugins/session-linked-files';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

type Who = 'starter' | 'other' | 'padmin';
type Listing = { items: Array<{ key: string }>; folders?: string[]; nextCursor?: string; prefix?: string };

describe('sessionOfFolder', () => {
  it('reads the session id off a folder path of at least two segments, and nothing off any other', () => {
    expect(sessionOfFolder('agent-sessions/support/6f1c9a/')).toBe('6f1c9a');
    expect(sessionOfFolder('a/b/c/d/sess-1')).toBe('sess-1');
    expect(sessionOfFolder('agent-sessions/')).toBeNull();
    expect(sessionOfFolder('agent-sessions')).toBeNull();
    expect(sessionOfFolder('')).toBeNull();
    expect(sessionOfFolder(null)).toBeNull();
    expect(sessionOfFolder(undefined)).toBeNull();
  });
});

describeForEachProvider('Folder rows of the Document Store, for the sessions they name', (getDb) => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: DatabaseProvider;
  let tmpDir: string;
  let tenantId: string;
  let tenantDbName: string;
  let project: string;
  const users = {} as Record<Who, string>;
  /** Session ids by name. */
  const sid = {} as Record<'starters' | 'others' | 'salesStarters' | 'extra1' | 'extra2' | 'extra3', string>;

  const dashHeaders = (who: Who) => ({
    'x-tenant-db-name': tenantDbName,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'folders-parity',
    'x-user-id': users[who],
    'x-user-role': 'user',
    'x-user-email': `${who}@x.io`,
    'x-license-type': 'FREE',
    cookie: `active_project_id=${project}`,
  });
  const ls = (who: Who, prefix: string, extra = '') =>
    app.inject({ method: 'GET', url: `/api/files/buckets/docs/objects?prefix=${encodeURIComponent(prefix)}${extra}`, headers: dashHeaders(who) });
  const json = (res: { body: string }) => parseJsonBody<Listing>(res.body);

  async function tokenOf(who: Who) {
    // The account lives in the tenant's database.
    const owner = (await db.runWithTenant!(tenantDbName, () => db.findUserById(users[who])))!;
    hoisted.requireApiToken.mockResolvedValue({
      token: 'tok',
      tokenRecord: { _id: 'tok-1', userId: users[who], servicePermissions: null },
      tenant: { licenseType: 'FREE' },
      tenantId,
      tenantSlug: 'folders-parity',
      tenantDbName,
      projectId: project,
      user: owner,
    });
  }
  const lsClient = (prefix: string, extra = '') =>
    app.inject({ method: 'GET', url: `/api/client/v1/files/buckets/docs/objects?prefix=${encodeURIComponent(prefix)}${extra}`, headers: { authorization: 'Bearer tok' } });

  /** A deny written the way the visual editor writes it: it covers the person and the tokens they own. */
  async function denyViewOthers(who: Who) {
    const compiled = await compileSpec({ effect: 'forbid', principals: { users: [users[who]] }, actions: ['agent.session_view_others'], resources: { any: true } });
    expect(compiled.errors).toEqual([]);
    await createPolicy(tenantDbName, { policyId: `deny-view-others-${who}`, name: `${who} may not view others' sessions`, cedar: compiled.cedar, spec: compiled.spec }, 'tester');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetSessionAccessCachesForTests();
  }

  const sessionFolder = (agent: string, id: string) => `agent-sessions/${agent}/${id}/`;

  beforeEach(async () => {
    db = getDb();
    hoisted.db.current = db;
    vi.clearAllMocks();
    hoisted.viewDecisions.count = 0;
    tmpDir = mkdtempSync(path.join(tmpdir(), 'folders-parity-'));
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    resetProjectNarrowingCachesForTests();
    resetEnforceStatsForTests();
    resetResourceAuthzThrottleForTests();
    resetResourceAuthzStatsForTests();
    resetSessionAccessCachesForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tenantDbName = `tenant_folders_${suffix}`;
    const tenant = await db.createTenant({ companyName: 'Acme', slug: `acme-folders-${suffix}`, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);

    await db.runWithTenant!(tenantDbName, async () => {
      project = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'x' }))._id);
      for (const who of ['starter', 'other', 'padmin'] as const) {
        const user = await db.createUser({ tenantId, email: `${who}@x.io`, name: `Name of ${who}`, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
        users[who] = String(user._id);
        await db.upsertUserProject({ tenantId, userId: users[who], projectId: project, role: who === 'padmin' ? 'project_admin' : 'member' } as never);
      }
      await db.createAgent({ tenantId, projectId: project, key: 'support', name: 'Support', config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);
      await db.createAgent({ tenantId, projectId: project, key: 'sales', name: 'Sales', config: { modelKey: 'm' }, status: 'active', createdBy: 'x' } as never);

      const session = async (agentKey: string, createdBy: string) => String((await db.createAgentConversation({
        tenantId, projectId: project, agentKey, title: `by ${createdBy}`, messages: [], metadata: { source: 'console' }, createdBy,
      } as never))._id);
      sid.starters = await session('support', users.starter);
      sid.others = await session('support', users.other);
      sid.salesStarters = await session('sales', users.starter);

      await db.createProvider({ tenantId, projectId: project, key: 'local', type: 'file', driver: 'local-filesystem', label: 'Local', status: 'active', credentialsEnc: encryptObject({}), settings: { basePath: tmpDir }, createdBy: users.starter });
      await db.createFileBucket({ tenantId, projectId: project, key: 'docs', name: 'Docs', providerKey: 'local', status: 'active', createdBy: users.starter } as never);
      const put = (key: string, extra: Record<string, unknown> = {}) => db.createFileRecord({
        tenantId, projectId: project, providerKey: 'local', bucketKey: 'docs', key, name: key.split('/').pop()!, size: 3, markdownStatus: 'none', createdBy: users.starter, uploadedBy: users.starter, ...extra,
      } as never);
      const sessionFile = (agent: string, id: string, name: string, createdBy: string) =>
        put(`agent-sessions/${agent}/${id}/${name}`, { purpose: 'conversation', conversationId: id, agentKey: agent, createdBy, uploadedBy: createdBy });
      await sessionFile('support', sid.starters, 'a.txt', users.starter);
      await sessionFile('support', sid.others, 'b.txt', users.other);
      await sessionFile('sales', sid.salesStarters, 'c.txt', users.starter);
      await put('agent-sessions/notes.txt');
      await put('invoices/2024/jan.pdf');
    });
    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(filesApiPlugin);
      await instance.register(clientFilesApiPlugin);
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await drainPendingTasks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('by default the agent folder lists every session folder: today\'s behaviour', async () => {
    const res = await ls('other', 'agent-sessions/support/');
    expect(res.statusCode).toBe(200);
    expect(json(res).folders).toEqual([sessionFolder('support', sid.starters), sessionFolder('support', sid.others)].sort());
    expect(hoisted.viewDecisions.count).toBe(0);
  });

  it('a caller a rule stops from viewing others\' sessions sees only their own session folder - and nothing about the rest', async () => {
    await denyViewOthers('other');
    const res = await ls('other', 'agent-sessions/support/');
    expect(res.statusCode).toBe(200);
    expect(json(res).folders).toEqual([sessionFolder('support', sid.others)]);
    expect(res.body).not.toContain(sid.starters);

    // an agent of which they own nothing: no session folder at all
    const sales = await ls('other', 'agent-sessions/sales/');
    expect(sales.statusCode).toBe(200);
    expect(json(sales).folders).toEqual([]);
    expect(sales.body).not.toContain(sid.salesStarters);

    // the session folder itself: nothing of the starter's session, and their own files still there
    const hidden = await ls('other', sessionFolder('support', sid.starters));
    expect(hidden.statusCode).toBe(200);
    expect(json(hidden).items).toEqual([]);
    expect(json(hidden).folders).toEqual([]);
    const own = await ls('other', sessionFolder('support', sid.others));
    expect(json(own).items.map((i) => i.key)).toEqual([`agent-sessions/support/${sid.others}/b.txt`]);
  });

  it('the folders that are not sessions stay: the root, the agent folders, ordinary folders and the files beside them', async () => {
    await denyViewOthers('other');
    const root = json(await ls('other', ''));
    expect(root.folders).toEqual(['agent-sessions/', 'invoices/']);
    const sessions = json(await ls('other', 'agent-sessions/'));
    expect(sessions.folders).toEqual(['agent-sessions/sales/', 'agent-sessions/support/']);
    expect(sessions.items.map((i) => i.key)).toEqual(['agent-sessions/notes.txt']);
    expect(json(await ls('other', 'invoices/')).folders).toEqual(['invoices/2024/']);
  });

  it('nobody else is affected by a rule about one person', async () => {
    await denyViewOthers('other');
    const all = [sessionFolder('support', sid.starters), sessionFolder('support', sid.others)].sort();
    expect(json(await ls('padmin', 'agent-sessions/support/')).folders).toEqual(all);
    expect(json(await ls('starter', 'agent-sessions/support/')).folders).toEqual(all);
    expect(json(await ls('padmin', 'agent-sessions/sales/')).folders).toEqual([sessionFolder('sales', sid.salesStarters)]);
  });

  it('the client Files API leaves the same folders out for a token whose owner is stopped', async () => {
    await denyViewOthers('other');
    await tokenOf('other');
    const res = await lsClient('agent-sessions/support/');
    expect(res.statusCode).toBe(200);
    expect((parseJsonBody<{ folders: string[] }>(res.body)).folders).toEqual([sessionFolder('support', sid.others)]);
    expect(res.body).not.toContain(sid.starters);
    expect((parseJsonBody<{ folders: string[] }>((await lsClient('agent-sessions/sales/')).body)).folders).toEqual([]);

    await tokenOf('padmin');
    expect((parseJsonBody<{ folders: string[] }>((await lsClient('agent-sessions/support/')).body)).folders).toHaveLength(2);
  });

  it('a page is filled with what the caller may see, folders counting as entries; no hidden folder rides on any page', async () => {
    // more sessions of the starter's, interleaved with the caller's own in key order is unknowable (ids are random): page one entry at a time
    await db.runWithTenant!(tenantDbName, async () => {
      for (const name of ['extra1', 'extra2', 'extra3'] as const) {
        sid[name] = String((await db.createAgentConversation({
          tenantId, projectId: project, agentKey: 'support', title: name, messages: [], metadata: { source: 'console' }, createdBy: users.starter,
        } as never))._id);
        await db.createFileRecord({
          tenantId, projectId: project, providerKey: 'local', bucketKey: 'docs', key: `agent-sessions/support/${sid[name]}/x.txt`, name: 'x.txt', size: 1, markdownStatus: 'none',
          purpose: 'conversation', conversationId: sid[name], agentKey: 'support', createdBy: users.starter, uploadedBy: users.starter,
        } as never);
      }
    });
    await denyViewOthers('other');

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await ls('other', 'agent-sessions/support/', `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode).toBe(200);
      const page = json(res);
      for (const hidden of [sid.starters, sid.extra1, sid.extra2, sid.extra3]) expect(res.body).not.toContain(hidden);
      seen.push(...(page.folders ?? []));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 12);
    expect(cursor).toBeUndefined();
    expect(seen).toEqual([sessionFolder('support', sid.others)]);
    // every page the walk made holds a visible entry or is the last one (a page is not left empty with a cursor behind it)
    expect(pages).toBeLessThanOrEqual(2);
  });

  it('asks once per request: the number of decisions depends on the agents of the project, not on the folders listed', async () => {
    await db.runWithTenant!(tenantDbName, async () => {
      for (let i = 0; i < 8; i += 1) {
        const id = String((await db.createAgentConversation({
          tenantId, projectId: project, agentKey: 'support', title: `n${i}`, messages: [], metadata: { source: 'console' }, createdBy: users.starter,
        } as never))._id);
        await db.createFileRecord({
          tenantId, projectId: project, providerKey: 'local', bucketKey: 'docs', key: `agent-sessions/support/${id}/n.txt`, name: 'n.txt', size: 1, markdownStatus: 'none',
          purpose: 'conversation', conversationId: id, agentKey: 'support', createdBy: users.starter, uploadedBy: users.starter,
        } as never);
      }
    });
    await denyViewOthers('other');
    hoisted.viewDecisions.count = 0;
    const res = await ls('other', 'agent-sessions/support/', '&limit=100');
    expect(res.statusCode).toBe(200);
    expect(json(res).folders).toEqual([sessionFolder('support', sid.others)]);
    // two agents, and one question for the sessions of an agent that no longer exists
    expect(hoisted.viewDecisions.count).toBe(3);
  });

  it('a store that cannot say whether a folder is a session fails the listing (503) - it never shows the folder', async () => {
    await denyViewOthers('other');
    const lookup = vi.spyOn(db, 'findAgentConversationById').mockRejectedValue(new Error('the store is down'));
    try {
      const res = await ls('other', 'agent-sessions/support/');
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain(sid.starters);
      expect(res.body).not.toContain(sid.others);
    } finally {
      lookup.mockRestore();
    }
  });
});
