/**
 * The read-only views of the Access tab and of the identity directories over HTTP: who may ask, what is asked of
 * them, what comes back, and what a refusal leaves out.
 *
 *   GET  /rag/modules/:key/access/summary          the knowledge base at a glance
 *   POST /rag/modules/:key/access/nodes            the permission state of listed folders and documents
 *   POST /rag/modules/:key/access/audience         who permission keys stand for
 *   GET  /rag/modules/:key/access/principals       people, groups and tokens to put on a permission
 *   GET  /rag/identity/console-people              console people and groups to link to a directory
 *   GET  /rag/identity/domains/:domainKey/people   the people of a directory and the console people they are tied to
 *   POST /rag/identity/domains/:domainKey/preview  what unsaved matching rules would match
 *   GET  /rag/identity/domains/:domainKey/groups   the groups of a directory
 *   GET  /rag/identity/domains/:domainKey/links    the links of a directory, with names
 *   GET  /rag/modules/:key/folders                 (changed) each folder carries how many documents it holds
 *
 * Real gate, real authorization engine, real SQLite. The people:
 *   admin        workspace admin: administers the Knowledge Engine and reads everything
 *   writer       Knowledge Engine write, named on the Finance folder and (through the directory) on Partners
 *   reader       Knowledge Engine read, named only on Q1 inside Finance
 *   outsider     Knowledge Engine read, named nowhere
 *   projectAdmin Knowledge Engine admin of this project, not of the workspace (see `gate` below)
 *   dave         a console person with no Knowledge Engine access, linked to a directory user (never calls)
 *
 * The knowledge base: Public (open), Finance (writer) with Q1 (reader) inside it, Board (nobody), Partners (the
 * directory group "partners"); documents in them, one closed document and one only the writer may read.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-views-routes-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_views_routes_main';

// ragService pulls in to-markdown, whose file-type CJS import trips vitest's ESM resolver.
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));

// A custom policy can allow rag.admin inside one project and not in the workspace. The engine's answer to the quiet
// workspace-level question is "no" for the people listed here; everything else is the real engine.
const gate = vi.hoisted(() => ({ notWorkspaceAdmin: new Set<string>() }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    serviceActionAllowedForRequest: ((request, service, level, options) => {
      if (options?.workspace && gate.notWorkspaceAdmin.has(String(request.headers['x-user-id'] ?? ''))) return Promise.resolve(false);
      return actual.serviceActionAllowedForRequest(request, service, level, options);
    }) as typeof actual.serviceActionAllowedForRequest,
  };
});

import type { FastifyPluginAsync } from 'fastify';
import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IUser } from '@/lib/database';
import {
  createRagIdentityLinkFor,
  createRagModuleFolder,
  putRagIdentityDomain,
  setRagNodeAclFromConsole,
  syncRagIdentityUsers,
  type RagAccessContext,
} from '@/lib/services/rag/ragAccessService';
import { ragApiPlugin } from '@/server/api/plugins/rag';
import { ragAccessApiPlugin } from '@/server/api/plugins/rag-access';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_views_routes_tenant';
const MODULE_KEY = 'kb';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
/** The same plugins behind the production JSON parser: the body stays the raw string, an empty one reaches the handler. */
let rawApp: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId = 'pending';
let projectId = 'pending';
let otherProjectId = 'pending';
let ctx: RagAccessContext;
const users = {} as Record<'admin' | 'writer' | 'reader' | 'outsider' | 'projectAdmin' | 'dave', IUser>;
const folders = {} as Record<'public' | 'finance' | 'q1' | 'board' | 'partners', string>;
const docs = {} as Record<'handbook' | 'publicSecret' | 'budget' | 'q1Plan' | 'top' | 'closed', string>;
let supportGroupId = 'pending';
let linkId = 'pending';
let tokenId = 'pending';

type Who = 'admin' | 'writer' | 'reader' | 'outsider' | 'projectAdmin';
type Method = 'GET' | 'POST' | 'DELETE';

const uid = (who: keyof typeof users): string => String(users[who]._id);

function headersOf(who: Who | null, json = false, project = projectId) {
  return {
    ...(who
      ? {
        'x-tenant-db-name': TENANT_DB_NAME,
        'x-tenant-id': tenantId,
        'x-tenant-slug': 'rag-views-routes',
        'x-user-id': uid(who),
        'x-user-role': String(users[who].role),
        'x-user-email': String(users[who].email),
        'x-license-type': 'FREE',
      }
      : {}),
    cookie: `active_project_id=${project}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: { body: string }) => parseJsonBody<any>(res.body);

const send = (who: Who | null, method: Method, url: string, payload?: unknown, project = projectId) => app.inject({
  method,
  url: `/api${url}`,
  headers: headersOf(who, payload !== undefined, project),
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

/** A POST whose body is the text as given, through the production parser. */
const sendRaw = (who: Who, url: string, text: string) => rawApp.inject({
  method: 'POST',
  url: `/api${url}`,
  headers: headersOf(who, true),
  payload: text,
});

const both: FastifyPluginAsync = async (instance) => {
  await instance.register(ragApiPlugin);
  await instance.register(ragAccessApiPlugin);
};

/** The nine views, each with a request that is valid for the knowledge base and the directory seeded below. */
const MODULE_VIEWS: Array<{ name: string; method: Method; url: string; payload?: unknown; key: string }> = [
  { name: 'summary', method: 'GET', url: `/rag/modules/${MODULE_KEY}/access/summary`, key: 'summary' },
  { name: 'nodes', method: 'POST', url: `/rag/modules/${MODULE_KEY}/access/nodes`, payload: {}, key: 'nodes' },
  { name: 'audience', method: 'POST', url: `/rag/modules/${MODULE_KEY}/access/audience`, payload: { principals: ['everyone'] }, key: 'audience' },
  { name: 'principals', method: 'GET', url: `/rag/modules/${MODULE_KEY}/access/principals?type=user`, key: 'items' },
];
const DIRECTORY_VIEWS: Array<{ name: string; method: Method; url: string; payload?: unknown; key: string }> = [
  { name: 'console people', method: 'GET', url: '/rag/identity/console-people?type=user', key: 'items' },
  { name: 'people', method: 'GET', url: '/rag/identity/domains/corp/people', key: 'users' },
  { name: 'preview', method: 'POST', url: '/rag/identity/domains/corp/preview', payload: { userMatch: [] }, key: 'preview' },
  { name: 'groups', method: 'GET', url: '/rag/identity/domains/corp/groups', key: 'groups' },
  { name: 'links', method: 'GET', url: '/rag/identity/domains/corp/links', key: 'links' },
];
const ALL_VIEWS = [...MODULE_VIEWS, ...DIRECTORY_VIEWS];
/** Properties an answer carries; a refusal carries none of them. */
const ANSWER_KEYS = ['summary', 'nodes', 'audience', 'items', 'preview', 'links', 'users', 'groups', 'total'];

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Views Routes Test',
    slug: 'rag-views-routes-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
  otherProjectId = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'seed' } as never))._id);

  const make = async (who: keyof typeof users, role: 'admin' | 'user', servicePermissions?: Record<string, string>, member = true) => {
    users[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role,
      licenseId: 'FREE',
      features: [],
      ...(servicePermissions ? { servicePermissions } : {}),
    } as never);
    if (member) await db.upsertUserProject({ tenantId, userId: uid(who), projectId, role: 'member' } as never);
  };
  await make('admin', 'admin');
  await make('writer', 'user', { rag: 'write' });
  await make('reader', 'user', { rag: 'read' });
  await make('outsider', 'user', { rag: 'read' });
  await make('projectAdmin', 'admin');
  await make('dave', 'user', undefined, false);
  gate.notWorkspaceAdmin.add(uid('projectAdmin'));

  supportGroupId = String((await db.createGroup({ tenantId, name: 'Support', externalId: 'fin-readers', createdBy: 'seed' }))._id);
  await db.addGroupMember({ tenantId, groupId: supportGroupId, userId: uid('reader'), role: 'member' });

  ctx = { tenantDbName: TENANT_DB_NAME, tenantId, projectId, actor: uid('admin') };

  // The directory: three users, two groups. The default rules tie writer and outsider to E-100 and E-300 by e-mail;
  // dave is linked by hand to E-200.
  await putRagIdentityDomain(ctx, { key: 'corp', label: 'Corp directory' });
  await syncRagIdentityUsers(TENANT_DB_NAME, tenantId, {
    domain: 'corp',
    runId: 'run-1',
    users: [
      { extId: 'E-100', name: 'Willa Writer', email: 'writer@example.com', groups: ['partners'] },
      { extId: 'E-200', email: 'someone@corp.example', groups: ['partners', 'fin-readers'] },
      { extId: 'E-300', email: 'outsider@example.com' },
    ],
  });
  linkId = String((await createRagIdentityLinkFor(ctx, {
    domain: 'corp', externalKind: 'user', externalId: 'E-200', consoleKind: 'user', consoleId: uid('dave'),
  }))._id);

  // The knowledge base.
  await db.createRagModule({
    tenantId,
    projectId,
    key: MODULE_KEY,
    name: 'Handbook',
    embeddingModelKey: 'embed-model',
    vectorProviderKey: 'vec-provider',
    vectorIndexKey: 'vec-index',
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    access: { enabled: true },
    createdBy: uid('admin'),
  });
  // Another project's module: not this project's to look at.
  await db.createRagModule({
    tenantId,
    projectId: otherProjectId,
    key: 'kb-elsewhere',
    name: 'Elsewhere',
    embeddingModelKey: 'embed-model',
    vectorProviderKey: 'vec-provider',
    vectorIndexKey: 'vec-index',
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    access: { enabled: true },
    createdBy: uid('admin'),
  });

  const folder = async (name: string, parentId?: string) =>
    (await createRagModuleFolder(ctx, { ragModuleKey: MODULE_KEY, name, ...(parentId ? { parentId } : {}) }))._id;
  folders.public = await folder('Public');
  folders.finance = await folder('Finance');
  folders.q1 = await folder('Q1', folders.finance);
  folders.board = await folder('Board');
  folders.partners = await folder('Partners');

  const doc = async (fileName: string, folderId?: string) => String((await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: MODULE_KEY,
    fileName,
    status: 'indexed',
    ...(folderId ? { folderId } : {}),
    createdBy: uid('admin'),
  }))._id);
  docs.handbook = await doc('handbook.md', folders.public);
  docs.publicSecret = await doc('public-secret.md', folders.public);
  docs.budget = await doc('budget.md', folders.finance);
  docs.q1Plan = await doc('q1-plan.md', folders.q1);
  docs.top = await doc('top.md');
  docs.closed = await doc('closed.md');

  const own = (node: { type: 'folder' | 'document'; id: string }, entries: unknown[]) =>
    setRagNodeAclFromConsole(ctx, { ragModuleKey: MODULE_KEY, node, mode: 'own', entries });
  await own({ type: 'folder', id: folders.finance }, [`user:${uid('writer')}`]);
  await own({ type: 'folder', id: folders.q1 }, [`user:${uid('reader')}`]);
  await own({ type: 'folder', id: folders.board }, []);
  await own({ type: 'folder', id: folders.partners }, [{ principal: 'x:corp:g:partners', label: 'Partner staff' }]);
  await own({ type: 'document', id: docs.publicSecret }, [`user:${uid('writer')}`]);
  await own({ type: 'document', id: docs.closed }, []);

  tokenId = String((await db.createApiToken({
    userId: uid('writer'), tenantId, projectId, label: 'Reporting', tokenHash: 'secret-hash-1', tokenPrefix: 'cgp_ab12', createdBy: uid('writer'),
  } as never))._id);

  app = await createFastifyApiTestApp(both);
  rawApp = await createFastifyApiTestApp(both, { rawJsonBody: true });
}, 30_000);

afterAll(async () => {
  await app.close();
  await rawApp.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('who may ask', () => {
  it('answers the workspace\'s administrators every view', async () => {
    for (const view of ALL_VIEWS) {
      const res = await send('admin', view.method, view.url, view.payload);
      expect(res.statusCode, `${view.name}: ${res.body}`).toBe(200);
      expect(Object.keys(body(res)).includes(view.key), view.name).toBe(true);
    }
  });

  it('refuses everybody below Knowledge Engine admin, every view, and says nothing about the contents', async () => {
    for (const who of ['writer', 'reader', 'outsider'] as const) {
      for (const view of ALL_VIEWS) {
        const res = await send(who, view.method, view.url, view.payload);
        expect(res.statusCode, `${who} ${view.name}: ${res.body}`).toBe(403);
        for (const key of ANSWER_KEYS) expect(body(res), `${who} ${view.name}`).not.toHaveProperty(key);
        expect(res.body, `${who} ${view.name}`).not.toMatch(/example\.com|Willa|Reporting|cgp_/);
      }
    }
  });

  it('gives the admin of one project the views of its knowledge bases, and the directories only to the workspace\'s admins', async () => {
    for (const view of MODULE_VIEWS) {
      const res = await send('projectAdmin', view.method, view.url, view.payload);
      expect(res.statusCode, `${view.name}: ${res.body}`).toBe(200);
    }
    for (const view of DIRECTORY_VIEWS) {
      const res = await send('projectAdmin', view.method, view.url, view.payload);
      expect(res.statusCode, `${view.name}: ${res.body}`).toBe(403);
      expect(body(res)).toMatchObject({ code: 'access_denied' });
      for (const key of ANSWER_KEYS) expect(body(res), view.name).not.toHaveProperty(key);
    }
  });

  it('answers 401 where there is no session at all', async () => {
    for (const view of ALL_VIEWS) {
      const res = await send(null, view.method, view.url, view.payload);
      expect(res.statusCode, `${view.name}: ${res.body}`).toBe(401);
      expect(body(res)).toEqual({ error: 'Unauthorized' });
    }
  });
});

describe('what is not there', () => {
  it('answers 404 module_not_found for a knowledge base that does not exist, or belongs to another project', async () => {
    for (const view of MODULE_VIEWS) {
      const missing = await send('admin', view.method, view.url.replace(`/${MODULE_KEY}/`, '/missing-module/'), view.payload);
      expect(missing.statusCode, `${view.name}: ${missing.body}`).toBe(404);
      expect(body(missing)).toMatchObject({ code: 'module_not_found' });
      const elsewhere = await send('admin', view.method, view.url.replace(`/${MODULE_KEY}/`, '/kb-elsewhere/'), view.payload);
      expect(elsewhere.statusCode, `${view.name}: ${elsewhere.body}`).toBe(404);
      expect(body(elsewhere)).toMatchObject({ code: 'module_not_found' });
      // The same knowledge base is found where it lives, and only there.
      const there = await send('admin', view.method, view.url.replace(`/${MODULE_KEY}/`, '/kb-elsewhere/'), view.payload, otherProjectId);
      expect(there.statusCode, `${view.name}: ${there.body}`).toBe(200);
    }
    // The module of this project is not found from the other project.
    const summary = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/summary`, undefined, otherProjectId);
    expect(summary.statusCode).toBe(404);
  });

  it('answers 404 domain_not_found for a directory that does not exist', async () => {
    for (const view of DIRECTORY_VIEWS.filter((v) => v.url.includes('/domains/'))) {
      const res = await send('admin', view.method, view.url.replace('/domains/corp/', '/domains/nope/'), view.payload);
      expect(res.statusCode, `${view.name}: ${res.body}`).toBe(404);
      expect(body(res)).toMatchObject({ code: 'domain_not_found' });
    }
  });

  it('asks the workspace-level question before it looks for the directory', async () => {
    // An admin of one project learns nothing about which directories exist.
    const missing = await send('projectAdmin', 'GET', '/rag/identity/domains/nope/people');
    const present = await send('projectAdmin', 'GET', '/rag/identity/domains/corp/people');
    expect([missing.statusCode, missing.body]).toEqual([present.statusCode, present.body]);
    expect(present.statusCode).toBe(403);
  });
});

describe('what is asked', () => {
  it('nodes: takes lists of at most 500 folder and document ids, and nothing else', async () => {
    const url = `/rag/modules/${MODULE_KEY}/access/nodes`;
    const ok = (payload: unknown) => send('admin', 'POST', url, payload);
    expect((await ok({})).statusCode).toBe(200);
    expect((await ok({ folderIds: [] })).statusCode).toBe(200);
    expect((await ok({ folderIds: Array.from({ length: 500 }, (_, i) => `f-${i}`) })).statusCode).toBe(200);
    for (const payload of [
      { folderIds: Array.from({ length: 501 }, (_, i) => `f-${i}`) },
      { documentIds: Array.from({ length: 501 }, (_, i) => `d-${i}`) },
      { folderIds: 'f-1' },
      { folderIds: [1, 2] },
      { documentIds: { 0: 'd-1' } },
      { documentIds: [null] },
    ]) {
      const res = await ok(payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(body(res)).toHaveProperty('error');
      expect(body(res)).not.toHaveProperty('nodes');
    }
  });

  it('audience: needs the list of keys, of at most 1000', async () => {
    const url = `/rag/modules/${MODULE_KEY}/access/audience`;
    const ask = (payload: unknown) => send('admin', 'POST', url, payload);
    expect((await ask({ principals: [] })).statusCode).toBe(200);
    expect((await ask({ principals: Array.from({ length: 1000 }, (_, i) => `user:u-${i}`) })).statusCode).toBe(200);
    for (const payload of [
      {},
      { principals: null },
      { principals: 'everyone' },
      { principals: [1] },
      { principals: Array.from({ length: 1001 }, (_, i) => `user:u-${i}`) },
    ]) {
      const res = await ask(payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(body(res)).not.toHaveProperty('audience');
    }
  });

  it('principals and console people: need a known type, given once', async () => {
    for (const url of [
      `/rag/modules/${MODULE_KEY}/access/principals`,
      `/rag/modules/${MODULE_KEY}/access/principals?type=email`,
      `/rag/modules/${MODULE_KEY}/access/principals?type=`,
      `/rag/modules/${MODULE_KEY}/access/principals?type=user&type=group`,
      '/rag/identity/console-people',
      '/rag/identity/console-people?type=token',
      '/rag/identity/console-people?type=user&type=group',
    ]) {
      const res = await send('admin', 'GET', url);
      expect(res.statusCode, url).toBe(400);
      expect(body(res)).toHaveProperty('error');
      expect(body(res)).not.toHaveProperty('items');
    }
    // Tokens are for permissions only: a directory links people and groups.
    expect((await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/principals?type=token`)).statusCode).toBe(200);
  });

  it('people: takes the filters all, matched and unmatched; paging numbers that are none are ignored', async () => {
    const url = '/rag/identity/domains/corp/people';
    for (const filter of ['all', 'matched', 'unmatched']) {
      expect((await send('admin', 'GET', `${url}?filter=${filter}`)).statusCode, filter).toBe(200);
    }
    for (const filter of ['everyone', 'MATCHED', '']) {
      const res = await send('admin', 'GET', `${url}?filter=${filter}`);
      expect(res.statusCode, filter).toBe(400);
      expect(body(res)).toHaveProperty('error');
    }
    const junk = await send('admin', 'GET', `${url}?limit=many&offset=x`);
    expect(junk.statusCode).toBe(200);
    expect(body(junk)).toMatchObject({ total: 3 });
    expect(body(junk).users).toHaveLength(3);
  });

  it('preview: needs a JSON object with the rules; the group setting, when sent, is a boolean', async () => {
    const url = '/rag/identity/domains/corp/preview';
    const fail400 = async (res: { statusCode: number; body: string }, what: string) => {
      expect(res.statusCode, `${what}: ${res.body}`).toBe(400);
      expect(body(res)).toHaveProperty('error');
      expect(body(res)).not.toHaveProperty('preview');
    };
    // The production parser: nothing, broken JSON, JSON that is no object, all end as a 400.
    for (const text of ['', '{', 'null', '"rules"', '12', 'true']) {
      const res = await sendRaw('admin', url, text);
      await fail400(res, JSON.stringify(text));
      expect(body(res)).toEqual({ error: 'A JSON body is required' });
    }
    // Rules that are not valid are refused as a saved list would be.
    await fail400(await send('admin', 'POST', url, {}), 'no rules');
    expect(body(await send('admin', 'POST', url, {}))).toMatchObject({ code: 'domain_invalid' });
    for (const userMatch of ['email', null, [{ console: 'phone', external: 'email' }], [{ console: 'email', external: 'attr:' }]]) {
      const res = await send('admin', 'POST', url, { userMatch });
      await fail400(res, JSON.stringify(userMatch));
      expect(body(res)).toMatchObject({ code: 'domain_invalid' });
    }
    expect(body(await send('admin', 'POST', url, { userMatch: Array.from({ length: 9 }, () => ({ console: 'email', external: 'email' })) })))
      .toMatchObject({ code: 'domain_invalid' });
    const flag = await send('admin', 'POST', url, { userMatch: [], matchGroupsByExternalId: 'no' });
    await fail400(flag, 'flag');
    expect(body(flag)).toEqual({ error: 'matchGroupsByExternalId must be a boolean' });
    expect((await send('admin', 'POST', url, { userMatch: [], matchGroupsByExternalId: false })).statusCode).toBe(200);
  });

  it('nodes and audience through the production parser: an empty body is a 400, an empty object is not', async () => {
    for (const url of [`/rag/modules/${MODULE_KEY}/access/nodes`, `/rag/modules/${MODULE_KEY}/access/audience`]) {
      const empty = await sendRaw('admin', url, '');
      expect(empty.statusCode, url).toBe(400);
      expect(body(empty)).toEqual({ error: 'A JSON body is required' });
    }
    const nodes = await sendRaw('admin', `/rag/modules/${MODULE_KEY}/access/nodes`, '{}');
    expect(nodes.statusCode, nodes.body).toBe(200);
    expect(body(nodes)).toEqual({ nodes: {} });
    const audience = await sendRaw('admin', `/rag/modules/${MODULE_KEY}/access/audience`, JSON.stringify({ principals: ['everyone'] }));
    expect(audience.statusCode, audience.body).toBe(200);
    expect(body(audience).audience).toEqual({ everyone: { kind: 'everyone', exists: true, people: null } });
  });
});

describe('the summary', () => {
  it('counts the knowledge base and lists what nobody can read', async () => {
    const res = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/summary`);
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(body(res))).toEqual(['summary']);
    expect(body(res).summary).toEqual({
      enabled: true,
      adminBypass: true,
      root: { entries: 0, openToEveryone: true },
      folders: { total: 5, own: 4, synced: 0, closed: 1 },
      documents: { total: 6, own: 2, synced: 0, closed: 1 },
      closed: [
        { type: 'folder', id: folders.board, name: 'Board', path: 'Board' },
        { type: 'document', id: docs.closed, name: 'closed.md' },
      ],
      closedComplete: true,
      directories: [{ key: 'corp', label: 'Corp directory', documents: 0, folders: 1 }],
    });
  });

  it('is the same for an admin of this project alone', async () => {
    const [byAdmin, byProjectAdmin] = await Promise.all([
      send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/summary`),
      send('projectAdmin', 'GET', `/rag/modules/${MODULE_KEY}/access/summary`),
    ]);
    expect(body(byProjectAdmin)).toEqual(body(byAdmin));
  });
});

describe('the permission state of listed rows', () => {
  it('answers each listed folder and document, keyed by kind and id, and leaves out what is not in the knowledge base', async () => {
    const res = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/access/nodes`, {
      folderIds: [folders.public, folders.finance, folders.q1, folders.board, 'no-such-folder'],
      documentIds: [docs.top, docs.publicSecret, docs.closed, 'no-such-document'],
      ignored: 'field',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(body(res))).toEqual(['nodes']);
    expect(body(res).nodes).toEqual({
      [`folder:${folders.public}`]: { mode: 'inherit', entries: 0 },
      [`folder:${folders.finance}`]: { mode: 'own', entries: 1 },
      [`folder:${folders.q1}`]: { mode: 'own', entries: 1 },
      [`folder:${folders.board}`]: { mode: 'own', entries: 0 },
      [`document:${docs.top}`]: { mode: 'inherit', entries: 0 },
      [`document:${docs.publicSecret}`]: { mode: 'own', entries: 1 },
      [`document:${docs.closed}`]: { mode: 'own', entries: 0 },
    });
  });
});

describe('who a key stands for', () => {
  const principals = () => [
    'everyone',
    `user:${uid('writer')}`,
    `group:${supportGroupId}`,
    `token:${tokenId}`,
    'x:corp:all',
    'x:corp:g:partners',
    'x:corp:g:fin-readers',
    'x:corp:u:E-100',
    'x:other:all',
    'not a key',
  ];

  it('names them and counts the people, directory keys included, for the workspace\'s admins', async () => {
    const res = await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/access/audience`, { principals: principals() });
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(body(res))).toEqual(['audience']);
    const audience = body(res).audience;
    expect(Object.keys(audience).sort()).toEqual(principals().filter((p) => p !== 'not a key').sort());
    expect(audience.everyone).toEqual({ kind: 'everyone', exists: true, people: null });
    expect(audience[`user:${uid('writer')}`]).toEqual({ kind: 'user', label: 'writer', detail: 'writer@example.com', exists: true, people: 1 });
    expect(audience[`group:${supportGroupId}`]).toEqual({ kind: 'group', label: 'Support', exists: true, people: 1 });
    expect(audience[`token:${tokenId}`]).toEqual({ kind: 'token', label: 'Reporting', detail: 'cgp_ab12', exists: true, people: null });
    // writer, outsider (both by e-mail) and dave (by his link).
    expect(audience['x:corp:all']).toEqual({ kind: 'external_all', label: 'All members', detail: 'Corp directory', exists: true, people: 3 });
    // writer (E-100) and dave (E-200, by his link); the label is the one the Partners permission carries.
    expect(audience['x:corp:g:partners']).toEqual({ kind: 'external_group', label: 'Partner staff', detail: 'Corp directory', exists: true, people: 2 });
    // dave (through E-200) and the Support group, whose external id it is.
    expect(audience['x:corp:g:fin-readers']).toMatchObject({ kind: 'external_group', detail: 'Corp directory', exists: true, people: 2 });
    expect(audience['x:corp:u:E-100']).toEqual({ kind: 'external_user', label: 'Willa Writer', detail: 'Corp directory', exists: true, people: 1 });
    expect(audience['x:other:all']).toEqual({ kind: 'external_all', label: 'All members', exists: false, people: 0 });
    expect(res.body).not.toContain('secret-hash');
  });

  it('counts nothing of a directory for the admin of one project, and takes no name from it', async () => {
    const res = await send('projectAdmin', 'POST', `/rag/modules/${MODULE_KEY}/access/audience`, { principals: principals() });
    expect(res.statusCode, res.body).toBe(200);
    const audience = body(res).audience;
    expect(audience[`user:${uid('writer')}`]).toMatchObject({ label: 'writer', people: 1 });
    expect(audience[`group:${supportGroupId}`]).toMatchObject({ label: 'Support', people: 1 });
    expect(audience['x:corp:all']).toEqual({ kind: 'external_all', label: 'All members', detail: 'Corp directory', exists: true, people: null });
    expect(audience['x:corp:g:partners']).toEqual({ kind: 'external_group', label: 'Partner staff', detail: 'Corp directory', exists: true, people: null });
    expect(audience['x:corp:g:fin-readers']).toMatchObject({ people: null });
    expect(audience['x:corp:u:E-100']).toEqual({ kind: 'external_user', detail: 'Corp directory', exists: true, people: null });
    expect(res.body).not.toContain('Willa');
  });
});

describe('the pickers', () => {
  const items = async (url: string) => {
    const res = await send('admin', 'GET', url);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    expect(Object.keys(body(res))).toEqual(['items']);
    return body(res).items as Array<{ principal?: string; id?: string; kind: string; label: string; detail?: string }>;
  };

  it('offers the people who can open this project, searched and limited', async () => {
    const all = await items(`/rag/modules/${MODULE_KEY}/access/principals?type=user`);
    // dave is in no project and no group of one.
    expect(all.map((i) => i.label)).toEqual(['admin', 'outsider', 'projectAdmin', 'reader', 'writer']);
    expect(all[0]).toEqual({ principal: `user:${uid('admin')}`, kind: 'user', label: 'admin', detail: 'admin@example.com' });
    expect((await items(`/rag/modules/${MODULE_KEY}/access/principals?type=user&q=read`)).map((i) => i.label)).toEqual(['reader']);
    expect((await items(`/rag/modules/${MODULE_KEY}/access/principals?type=user&q=%20%20`)).map((i) => i.label)).toEqual(all.map((i) => i.label));
    expect((await items(`/rag/modules/${MODULE_KEY}/access/principals?type=user&limit=2`)).map((i) => i.label)).toEqual(['admin', 'outsider']);
    expect((await items(`/rag/modules/${MODULE_KEY}/access/principals?type=user&limit=0`))).toHaveLength(1);
    expect((await items(`/rag/modules/${MODULE_KEY}/access/principals?type=user&limit=abc`))).toHaveLength(5);
  });

  it('offers groups with how many people they hold, and the project\'s active tokens without their secrets', async () => {
    expect(await items(`/rag/modules/${MODULE_KEY}/access/principals?type=group`)).toEqual([
      { principal: `group:${supportGroupId}`, kind: 'group', label: 'Support', detail: '1 person' },
    ]);
    const res = await send('admin', 'GET', `/rag/modules/${MODULE_KEY}/access/principals?type=token`);
    expect(body(res).items).toEqual([{ principal: `token:${tokenId}`, kind: 'token', label: 'Reporting', detail: 'cgp_ab12' }]);
    expect(res.body).not.toContain('secret-hash');
  });

  it('offers every console person and group of the workspace to link to a directory', async () => {
    const people = await items('/rag/identity/console-people?type=user');
    expect(people.map((i) => i.label)).toEqual(['admin', 'dave', 'outsider', 'projectAdmin', 'reader', 'writer']);
    expect(people[1]).toEqual({ id: uid('dave'), kind: 'user', label: 'dave', detail: 'dave@example.com' });
    expect((await items('/rag/identity/console-people?type=user&q=DAV')).map((i) => i.label)).toEqual(['dave']);
    expect(await items('/rag/identity/console-people?type=group&q=sup')).toEqual([
      { id: supportGroupId, kind: 'group', label: 'Support', detail: '1 person' },
    ]);
  });
});

describe('the people of a directory', () => {
  it('shows each directory user with the console people it is tied to, and how', async () => {
    const res = await send('admin', 'GET', '/rag/identity/domains/corp/people');
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(body(res)).sort()).toEqual(['summary', 'total', 'users']);
    expect(body(res).total).toBe(3);
    const byId = Object.fromEntries((body(res).users as Array<{ extId: string; console: unknown[] }>).map((u) => [u.extId, u]));
    expect(byId['E-100']).toMatchObject({
      name: 'Willa Writer', email: 'writer@example.com', type: 'member', groups: 1,
      console: [{ userId: uid('writer'), name: 'writer', email: 'writer@example.com', via: 'rule', rule: 0 }],
    });
    expect(byId['E-200'].console).toEqual([{ userId: uid('dave'), name: 'dave', email: 'dave@example.com', via: 'link', linkId }]);
    expect(byId['E-300'].console).toEqual([{ userId: uid('outsider'), name: 'outsider', email: 'outsider@example.com', via: 'rule', rule: 0 }]);
    expect(body(res).summary).toMatchObject({
      directoryUsers: 3, matchedUsers: 3, consolePeople: 6, matchedPeople: 3, groups: 2, defaults: true, matchGroupsByExternalId: true,
    });
  });

  it('keeps the matched or unmatched users, searches, and pages', async () => {
    const people = async (query: string) => {
      const res = await send('admin', 'GET', `/rag/identity/domains/corp/people${query}`);
      expect(res.statusCode, `${query}: ${res.body}`).toBe(200);
      return body(res) as { total: number; users: Array<{ extId: string }> };
    };
    expect((await people('?filter=matched')).total).toBe(3);
    expect(await people('?filter=unmatched')).toMatchObject({ total: 0, users: [] });
    expect((await people('?search=someone')).users.map((u) => u.extId)).toEqual(['E-200']);
    const first = await people('?limit=2');
    const second = await people('?limit=2&offset=2');
    expect(first.users).toHaveLength(2);
    expect(second.users).toHaveLength(1);
    expect(first.total).toBe(3);
    expect([...first.users, ...second.users].map((u) => u.extId).sort()).toEqual(['E-100', 'E-200', 'E-300']);
  });
});

describe('what unsaved rules would match', () => {
  const preview = async (payload: unknown) => {
    const res = await send('admin', 'POST', '/rag/identity/domains/corp/preview', payload);
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(body(res))).toEqual(['preview']);
    return body(res).preview;
  };

  it('counts users and people for the rules as typed, and lists the users nobody matches', async () => {
    const byEmail = await preview({ userMatch: [{ console: 'email', external: 'email' }] });
    expect(byEmail).toMatchObject({
      rules: [{ console: 'email', external: 'email' }],
      directoryUsers: 3, matchedUsers: 3, consolePeople: 6, matchedPeople: 3, decidedByRule: [2], unmatchedUsers: [],
    });
    // No address is an alias: only the link keeps E-200.
    const byAlias = await preview({ userMatch: [{ console: 'email', external: 'attr:mailAlias' }] });
    expect(byAlias).toMatchObject({ matchedUsers: 1, matchedPeople: 1, decidedByRule: [0] });
    expect(byAlias.unmatchedUsers.map((u: { extId: string }) => u.extId).sort()).toEqual(['E-100', 'E-300']);
    expect(byAlias.unmatchedUsers[0]).toMatchObject({ type: 'member' });
  });

  it('previews the default rules for an empty list, and changes nothing that is stored', async () => {
    const defaults = await preview({ userMatch: [] });
    expect(defaults.rules).toHaveLength(2);
    expect(defaults).toMatchObject({ directoryUsers: 3, matchedUsers: 3 });
    await preview({ userMatch: [{ console: 'email', external: 'attr:mailAlias' }], matchGroupsByExternalId: false });
    const people = await send('admin', 'GET', '/rag/identity/domains/corp/people');
    expect(body(people).summary).toMatchObject({ matchedUsers: 3, defaults: true, matchGroupsByExternalId: true });
    expect((await (await getDatabase()).findRagIdentityDomain('corp'))?.userMatch).toEqual([]);
  });
});

describe('the groups and the links of a directory', () => {
  it('lists the groups with how many users are in them and which console groups stand for them', async () => {
    const res = await send('admin', 'GET', '/rag/identity/domains/corp/groups');
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(body(res)).sort()).toEqual(['groups', 'total']);
    expect(body(res)).toEqual({
      total: 2,
      groups: [
        { id: 'fin-readers', users: 1, console: [{ id: supportGroupId, name: 'Support', via: 'external_id' }] },
        { id: 'partners', name: 'Partner staff', users: 2, console: [] },
      ],
    });
  });

  it('searches and pages the groups', async () => {
    const page = async (query: string) => body(await send('admin', 'GET', `/rag/identity/domains/corp/groups${query}`));
    expect((await page('?search=PART')).groups.map((g: { id: string }) => g.id)).toEqual(['partners']);
    expect((await page('?search=nothing'))).toEqual({ groups: [], total: 0 });
    expect((await page('?limit=1')).groups.map((g: { id: string }) => g.id)).toEqual(['fin-readers']);
    expect((await page('?limit=1&offset=1')).groups.map((g: { id: string }) => g.id)).toEqual(['partners']);
    expect((await page('?limit=1&offset=1')).total).toBe(2);
  });

  it('lists the links with the names of both ends', async () => {
    const res = await send('admin', 'GET', '/rag/identity/domains/corp/links');
    expect(res.statusCode, res.body).toBe(200);
    expect(Object.keys(body(res))).toEqual(['links']);
    expect(body(res).links).toEqual([
      {
        _id: linkId,
        externalKind: 'user',
        externalId: 'E-200',
        externalName: 'someone@corp.example',
        consoleKind: 'user',
        consoleId: uid('dave'),
        consoleName: 'dave',
        consoleDetail: 'dave@example.com',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    ]);
  });

  it('follows the links that change: a new link counts at once, a removed one no more', async () => {
    const holders = async () => (body(await send('admin', 'POST', `/rag/modules/${MODULE_KEY}/access/audience`, { principals: ['x:corp:g:partners'] }))
      .audience['x:corp:g:partners'].people as number);
    const linkIdsOf = async () => (body(await send('admin', 'GET', '/rag/identity/domains/corp/links')).links as Array<{ _id: string }>)
      .map((l) => l._id);
    expect(await holders()).toBe(2);

    // The Support group now stands for "partners": its member, reader, holds the key.
    const created = await send('admin', 'POST', '/rag/identity/links', {
      domain: 'corp', externalKind: 'group', externalId: 'partners', consoleKind: 'group', consoleId: supportGroupId,
    });
    expect(created.statusCode, created.body).toBe(201);
    const newId = String(body(created).link._id);
    expect(await linkIdsOf()).toContain(newId);
    expect(await holders()).toBe(3);

    expect((await send('admin', 'DELETE', `/rag/identity/links/${newId}`)).statusCode).toBe(200);
    expect(await linkIdsOf()).not.toContain(newId);
    expect(await holders()).toBe(2);
  });
});

describe('the folder list carries the documents each folder holds', () => {
  const foldersOf = async (who: Who) => {
    const res = await send(who, 'GET', `/rag/modules/${MODULE_KEY}/folders`);
    expect(res.statusCode, res.body).toBe(200);
    return body(res).folders as Array<{ _id: string; path: string; documents?: number; pathOnly?: true }>;
  };
  const documentsIn = async (who: Who, folderId: string) => {
    const res = await send(who, 'GET', `/rag/modules/${MODULE_KEY}/documents?folderId=${folderId}`);
    expect(res.statusCode, res.body).toBe(200);
    return (body(res).documents as Array<{ _id: string }>).map((d) => String(d._id));
  };

  it('counts the documents directly in each folder for an administrator', async () => {
    const list = await foldersOf('admin');
    expect(list.map((f) => [f.path, f.documents])).toEqual([
      ['Board', 0], ['Finance', 1], ['Finance/Q1', 1], ['Partners', 0], ['Public', 2],
    ]);
    expect(list.some((f) => f.pathOnly)).toBe(false);
  });

  it('counts only the documents a person may read, and marks a folder they pass through to reach one', async () => {
    const summary = async (who: Who) => (await foldersOf(who)).map((f) => [f.path, f.documents, f.pathOnly ?? false]);
    // Public holds a document only the writer may read.
    expect(await summary('outsider')).toEqual([['Public', 1, false]]);
    // The reader is named on Q1 only: Finance is a way to it, with nothing of its own to show.
    expect(await summary('reader')).toEqual([['Finance', 0, true], ['Finance/Q1', 1, false], ['Public', 1, false]]);
    // The writer reads Finance and Public, and Partners through the directory; not Q1, which names the reader.
    expect(await summary('writer')).toEqual([['Finance', 1, false], ['Partners', 0, false], ['Public', 2, false]]);
  });

  it('is what the document list shows for each folder, whoever asks', async () => {
    for (const who of ['admin', 'writer', 'reader', 'outsider'] as const) {
      for (const folder of await foldersOf(who)) {
        if (folder.pathOnly) {
          expect(folder.documents, `${who} ${folder.path}`).toBe(0);
          continue;
        }
        expect((await documentsIn(who, folder._id)).length, `${who} ${folder.path}`).toBe(folder.documents);
      }
    }
  });

  it('still answers 404 for a knowledge base that is not there', async () => {
    expect((await send('writer', 'GET', '/rag/modules/missing-module/folders')).statusCode).toBe(404);
  });
});
