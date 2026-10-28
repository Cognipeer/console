/**
 * Knowledge Engine access control on the client API. A client call is never a
 * knowledge-base administrator: a token reads what is open to everyone and
 * what names the token (whoever owns it), a delegated call what the person it
 * acts for may read. Placement and permissions on ingest follow the same rules.
 *
 * Real gate, real authorization engine, real SQLite; only the token lookup and
 * the ingest queue are stubbed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-client-rag-access-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'client_rag_access_main';

const hoisted = vi.hoisted(() => ({ requireApiToken: vi.fn(), publishRagIngestJob: vi.fn(async () => undefined) }));

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));
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
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: hoisted.publishRagIngestJob }));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IUser } from '@/lib/database';
import { createRagModuleFolder, setRagNodeAclFromConsole } from '@/lib/services/rag/ragAccessService';
import { hashSourceText } from '@/lib/services/rag/ragSource';
import { clientRagApiPlugin } from '@/server/api/plugins/client-rag';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'client_rag_access_tenant';
const KB = 'kb';
const TOKEN_ID = 'tok-pipeline';

let db: DatabaseProvider;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId = 'pending';
let projectId = 'pending';
const people = {} as Record<'admin' | 'reader', IUser>;
const docs = {} as Record<'open' | 'finance' | 'forPipeline', string>;
let financeFolderId = 'pending';

/** The call as the token alone (its owner is a workspace admin), optionally with a scope. */
async function asToken(scope: Record<string, string> | null = null) {
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: TOKEN_ID, userId: String(people.admin._id), servicePermissions: scope },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'client-rag-access',
    tenantDbName: TENANT_DB_NAME,
    projectId,
    user: (await db.findUserById(String(people.admin._id)))!,
  });
}

/** The same token acting for the reader. */
async function asDelegatedReader() {
  hoisted.requireApiToken.mockResolvedValue({
    token: 'tok',
    tokenRecord: { _id: TOKEN_ID, userId: String(people.reader._id), servicePermissions: null },
    tenant: { licenseType: 'FREE' },
    tenantId,
    tenantSlug: 'client-rag-access',
    tenantDbName: TENANT_DB_NAME,
    projectId,
    user: (await db.findUserById(String(people.reader._id)))!,
    delegation: {
      state: 'active',
      issuer: 'https://idp.example.com',
      subject: 'reader-subject',
      kind: 'person',
      appOwnerId: String(people.admin._id),
      created: false,
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: { body: string }) => parseJsonBody<any>(res.body);
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({
  method,
  url: `/api/client/v1${url}`,
  headers: { authorization: 'Bearer tok', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

async function listed(): Promise<string[]> {
  const res = await call('GET', `/rag/modules/${KB}/documents`);
  expect(res.statusCode, res.body).toBe(200);
  return (body(res).documents as Array<{ _id: string }>).map((d) => String(d._id)).sort();
}

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Client Rag Access',
    slug: 'client-rag-access',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
  const make = async (who: keyof typeof people, role: 'admin' | 'user', servicePermissions?: Record<string, string>) => {
    people[who] = await db.createUser({
      tenantId,
      email: `${who}@example.com`,
      name: who,
      password: '$2b$10$x',
      role,
      licenseId: 'FREE',
      features: [],
      ...(servicePermissions ? { servicePermissions } : {}),
    } as never);
    await db.upsertUserProject({ tenantId, userId: String(people[who]._id), projectId, role: 'member' } as never);
  };
  await make('admin', 'admin');
  await make('reader', 'user', { rag: 'write' });

  await db.createRagModule({
    tenantId,
    projectId,
    key: KB,
    name: 'Handbook',
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: 'idx',
    chunkConfig: { strategy: 'recursive_character', chunkSize: 800, chunkOverlap: 100 },
    status: 'active',
    access: { enabled: true },
    createdBy: 'seed',
  });
  const ctx = { tenantDbName: TENANT_DB_NAME, tenantId, projectId, actor: String(people.admin._id) };
  financeFolderId = (await createRagModuleFolder(ctx, { ragModuleKey: KB, name: 'Finance' }))._id;
  await setRagNodeAclFromConsole(ctx, {
    ragModuleKey: KB,
    node: { type: 'folder', id: financeFolderId },
    mode: 'own',
    entries: [`user:${String(people.reader._id)}`],
  });
  const doc = async (fileName: string, folderId?: string) => String((await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: KB,
    fileName,
    status: 'indexed',
    sourceText: `text of ${fileName}`,
    createdBy: 'seed',
    ...(folderId ? { folderId } : {}),
  }))._id);
  docs.open = await doc('open.md');
  docs.finance = await doc('finance.md', financeFolderId);
  docs.forPipeline = await doc('pipeline.md', financeFolderId);
  // Named for the token alone (as a sync that knows its token would write it).
  await db.updateRagDocument(docs.forPipeline, { aclMode: 'own' });
  await db.replaceRagAclEntries(KB, { type: 'document', id: docs.forPipeline }, [
    { tenantId, projectId, principal: `token:${TOKEN_ID}`, createdBy: 'seed' },
  ], projectId);

  app = await createFastifyApiTestApp(clientRagApiPlugin);
}, 30_000);

beforeEach(() => {
  hoisted.publishRagIngestJob.mockClear();
});

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('what a client call reads', () => {
  it('a token reads what is open to everyone and what names it — not what its admin owner could', async () => {
    await asToken();
    expect(await listed()).toEqual([docs.open, docs.forPipeline].sort());
  });

  it('a delegated call reads what the person it acts for may read, not what names the token', async () => {
    await asDelegatedReader();
    expect(await listed()).toEqual([docs.open, docs.finance].sort());
  });

  it('answers an unreadable document like a missing one, on every document route', async () => {
    await asToken();
    for (const url of [
      `/rag/modules/${KB}/documents/${docs.finance}`,
      `/rag/modules/${KB}/documents/${docs.finance}/content`,
      `/rag/modules/${KB}/documents/${docs.finance}/lines`,
    ]) {
      const res = await call('GET', url);
      expect(res.statusCode, url).toBe(404);
      expect(body(res)).toEqual({ error: 'Document not found' });
    }
    const reingest = await call('POST', `/rag/modules/${KB}/documents/${docs.finance}`, {});
    expect(reingest.statusCode).toBe(404);
    const removed = await call('DELETE', `/rag/modules/${KB}/documents/${docs.finance}`);
    expect(removed.statusCode).toBe(404);
    expect(await db.findRagDocumentById(docs.finance)).not.toBeNull();

    const readable = await call('GET', `/rag/modules/${KB}/documents/${docs.forPipeline}/content`);
    expect(readable.statusCode, readable.body).toBe(200);
  });
});

describe('placement and permissions on ingest', () => {
  it('places a document by the path of a folder the caller may read, and makes no folder for a path that is not there', async () => {
    await asDelegatedReader();
    const res = await call('POST', `/rag/modules/${KB}/ingest`, {
      fileName: 'budget-2027.md',
      content: 'budget',
      async: true,
      folderPath: 'Finance',
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(body(res).document.folderId).toBe(financeFolderId);
    expect(hoisted.publishRagIngestJob).toHaveBeenCalledTimes(1);

    // Folders of a knowledge base with access control are for Knowledge Engine admins.
    const missing = await call('POST', `/rag/modules/${KB}/ingest`, {
      fileName: 'budget-2028.md',
      content: 'budget',
      async: true,
      folderPath: 'Finance/2028',
    });
    expect(missing.statusCode).toBe(404);
    expect(body(missing).code).toBe('folder_not_found');
    expect((await db.listRagFolders(KB, { projectId })).some((f) => f.name === '2028')).toBe(false);
  });

  it('does not let a caller place documents in a folder they cannot read', async () => {
    // A token held to write; one that passes the admin check counts as a manager for folders.
    await asToken({ rag: 'write' });
    const res = await call('POST', `/rag/modules/${KB}/ingest`, {
      fileName: 'sneaky.md',
      content: 'x',
      async: true,
      folderId: financeFolderId,
    });
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('folder_not_found');
    expect(await db.findRagDocumentByFileName(KB, 'sneaky.md', projectId)).toBeNull();
    expect(hoisted.publishRagIngestJob).not.toHaveBeenCalled();
  });

  it('permissions on ingest need Knowledge Engine admin on the token', async () => {
    await asToken({ rag: 'write' });
    const refused = await call('POST', `/rag/modules/${KB}/ingest`, {
      fileName: 'restricted.md',
      content: 'x',
      async: true,
      acl: { mode: 'own', entries: [`user:${String(people.reader._id)}`] },
    });
    expect(refused.statusCode).toBe(403);
    expect(body(refused).code).toBe('access_denied');

    await asToken();
    const stored = await call('POST', `/rag/modules/${KB}/ingest`, {
      fileName: 'restricted.md',
      content: 'x',
      async: true,
      acl: { mode: 'own', entries: [`user:${String(people.reader._id)}`] },
    });
    expect(stored.statusCode, stored.body).toBe(202);
    const id = String(body(stored).document._id);
    expect((await db.findRagDocumentById(id))?.aclMode).toBe('own');
    expect((await db.listRagAclEntries(KB, { projectId, nodeType: 'document', nodeId: id })).map((e) => e.principal))
      .toEqual([`user:${String(people.reader._id)}`]);
    // A token that does not exist is not a principal anyone can be given.
    const unknownToken = await call('POST', `/rag/modules/${KB}/ingest`, {
      fileName: 'unknown-token.md',
      content: 'x',
      async: true,
      acl: { mode: 'own', entries: ['token:no-such-token'] },
    });
    expect(unknownToken.statusCode).toBe(400);
    expect(body(unknownToken).code).toBe('principal_unknown');
  });

  it('refuses an invalid entry before anything is stored', async () => {
    await asToken();
    const res = await call('POST', `/rag/modules/${KB}/ingest`, {
      fileName: 'broken-acl.md',
      content: 'x',
      async: true,
      acl: { mode: 'own', entries: ['not a principal'] },
    });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('principal_invalid');
    expect(await db.findRagDocumentByFileName(KB, 'broken-acl.md', projectId)).toBeNull();
  });
});

describe('switching access control', () => {
  it('needs Knowledge Engine admin on the token', async () => {
    await asToken({ rag: 'write' });
    const refused = await call('PATCH', `/rag/modules/${KB}`, { access: { enabled: false } });
    expect(refused.statusCode).toBe(403);
    expect(body(refused).code).toBe('access_denied');
    expect((await db.findRagModuleByKey(KB, projectId))?.access?.enabled).toBe(true);
  });
});

describe('reads that follow the knowledge base that owns the data', () => {
  const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };
  const docIds = {} as Record<'legacyInOtherProject' | 'legacyFree', string>;

  const addModule = (key: string, project: string, index: string, access?: { enabled: boolean }) => db.createRagModule({
    tenantId,
    projectId: project,
    key,
    name: key,
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: index,
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    createdBy: 'seed',
    ...(access ? { access } : {}),
  });

  /** A document of `kb` in the finance folder (the reader may read it, the token may not) or at the top level. */
  const addTwin = async (fileName: string, text: string, folderId?: string) => String((await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: KB,
    fileName,
    status: 'indexed',
    sourceText: text,
    sourceHash: hashSourceText(text),
    createdBy: 'seed',
    ...(folderId ? { folderId } : {}),
  }))._id);

  beforeAll(async () => {
    const otherProjectId = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'seed' } as never))._id);
    await addModule('bonly', otherProjectId, 'idx-b', { enabled: true });
    // Rows written before rows named their project: any project's token reaches them by key.
    const legacy = async (key: string, fileName: string) => String((await db.createRagDocument({
      tenantId,
      ragModuleKey: key,
      fileName,
      status: 'indexed',
      sourceText: `text of ${fileName}`,
      createdBy: 'seed',
    }))._id);
    docIds.legacyInOtherProject = await legacy('bonly', 'legacy.md');
    docIds.legacyFree = await legacy('nokey', 'free.md');

    const plain = await addModule('plain', projectId, 'idx-plain');
    await db.incrementRagModuleTotals(String(plain._id), { documents: 3, chunks: 8 });
    await db.incrementRagModuleTotals(String((await db.findRagModuleByKey(KB, projectId))!._id), { documents: 2, chunks: 5 });
  });

  describe('a document judged by the knowledge base that owns it', () => {
    it('a row without a project is not found when its knowledge base, in another project, has access control', async () => {
      await asToken();
      const id = docIds.legacyInOtherProject;
      for (const suffix of ['', '/content', '/lines']) {
        const res = await call('GET', `/rag/modules/bonly/documents/${id}${suffix}`);
        expect(res.statusCode, suffix).toBe(404);
        expect(body(res)).toEqual({ error: 'Document not found' });
      }
      const reingest = await call('POST', `/rag/modules/bonly/documents/${id}`, { content: 'overwritten' });
      expect(reingest.statusCode).toBe(404);
      const removed = await call('DELETE', `/rag/modules/bonly/documents/${id}`);
      expect(removed.statusCode).toBe(404);
      expect((await db.findRagDocumentById(id))?.sourceText).toBe('text of legacy.md');
    });

    it('a row of a key no knowledge base uses is served as before', async () => {
      await asToken();
      const res = await call('GET', `/rag/modules/nokey/documents/${docIds.legacyFree}/content`);
      expect(res.statusCode, res.body).toBe(200);
      expect(body(res).text).toBe('text of free.md');
    });
  });

  describe('the totals of a knowledge base', () => {
    const totalsOf = (module: Record<string, unknown>) => ({ documents: module.totalDocuments, chunks: module.totalChunks });

    it('are left out of a knowledge base with access control, whoever the call acts for', async () => {
      for (const as of [asToken, asDelegatedReader]) {
        await as();
        const res = await call('GET', `/rag/modules/${KB}`);
        expect(res.statusCode, res.body).toBe(200);
        expect(body(res).module).not.toHaveProperty('totalDocuments');
        expect(body(res).module).not.toHaveProperty('totalChunks');
      }
    });

    it('stay in the list and in an edit for a knowledge base without', async () => {
      await asToken();
      const modules = body(await call('GET', '/rag/modules')).modules as Array<Record<string, unknown>>;
      expect(modules.find((m) => m.key === KB)).not.toHaveProperty('totalDocuments');
      expect(totalsOf(modules.find((m) => m.key === 'plain')!)).toEqual({ documents: 3, chunks: 8 });

      const edited = await call('PATCH', '/rag/modules/plain', { description: 'Plain' });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(totalsOf(body(edited).module)).toEqual({ documents: 3, chunks: 8 });
      const editedKb = await call('PATCH', `/rag/modules/${KB}`, { description: 'Handbook' });
      expect(editedKb.statusCode, editedKb.body).toBe(200);
      expect(body(editedKb).module).not.toHaveProperty('totalChunks');
    });
  });

  describe('an ingest of the text of a document the caller cannot read', () => {
    const ingest = (fileName: string, content: string) => call('POST', `/rag/modules/${KB}/ingest`, {
      fileName,
      content,
      async: true,
    });

    it('makes a new document for a token and leaves the hidden one as it was', async () => {
      const hidden = await addTwin('twin.md', 'finance forecast', financeFolderId);
      const before = await db.findRagDocumentById(hidden);

      await asToken();
      const res = await ingest('twin.md', 'finance forecast');
      expect(res.statusCode, res.body).toBe(202);
      expect(body(res).document._id).not.toBe(hidden);
      expect(body(res).document.folderId).toBeUndefined();
      expect(hoisted.publishRagIngestJob).toHaveBeenCalledTimes(1);

      const after = await db.findRagDocumentById(hidden);
      expect(after?.folderId).toBe(financeFolderId);
      expect(after?.updatedAt).toEqual(before?.updatedAt);
    });

    it('answers "already there" to a caller who may read it, and for a document open to everyone', async () => {
      const hidden = await addTwin('twin-2.md', 'finance outlook', financeFolderId);
      await asDelegatedReader();
      const delegated = await ingest('twin-2.md', 'finance outlook');
      expect(delegated.statusCode, delegated.body).toBe(202);
      expect(body(delegated).document._id).toBe(hidden);

      const open = await addTwin('open-twin.md', 'holiday calendar');
      await asToken();
      const token = await ingest('open-twin.md', 'holiday calendar');
      expect(token.statusCode, token.body).toBe(202);
      expect(body(token).document._id).toBe(open);
      expect(hoisted.publishRagIngestJob).not.toHaveBeenCalled();
    });
  });

  describe('pointing a knowledge base at an index with access control', () => {
    const create = (key: string, index: string) => call('POST', '/rag/modules', {
      name: key,
      key,
      embeddingModelKey: 'embed',
      vectorProviderKey: 'vec',
      vectorIndexKey: index,
      chunkConfig: CHUNK_CONFIG,
    });

    it('is refused for a new knowledge base and for moving one, for a token', async () => {
      await asToken();
      const created = await create('copy-of-kb', 'idx');
      expect(created.statusCode, created.body).toBe(403);
      expect(body(created).code).toBe('kb_access_controlled');
      expect(await db.findRagModuleByKey('copy-of-kb', projectId)).toBeNull();

      const moved = await call('PATCH', '/rag/modules/plain', { vectorIndexKey: 'idx' });
      expect(moved.statusCode, moved.body).toBe(403);
      expect(body(moved).code).toBe('kb_access_controlled');
      expect((await db.findRagModuleByKey('plain', projectId))?.vectorIndexKey).toBe('idx-plain');
    });

    it('does not stand in the way of an index nobody guards, or of an edit that leaves the index where it is', async () => {
      await asToken();
      const created = await create('on-a-free-index', 'idx-free');
      expect(created.statusCode, created.body).toBe(201);

      const edited = await call('PATCH', '/rag/modules/plain', { name: 'Plain again', vectorIndexKey: 'idx-plain' });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(body(edited).module.name).toBe('Plain again');
    });
  });
});
