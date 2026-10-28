/**
 * Knowledge Engine access control: the reads that were left open.
 *
 *  - a search of a knowledge base without access control does not hand on what another one with it keeps on the same
 *    vector index, and no knowledge base is pointed at such an index afterwards
 *  - a document is judged by the knowledge base that owns it, not by the one the request's project happens to have
 *  - totals, re-index runs and exports tell a caller whose reads are checked nothing about documents they cannot read
 *  - an ingest of the text of a document the caller cannot read makes a new document instead of answering "already there"
 *  - the model's semantic cache stays out of answers drawn from a knowledge base with access control
 *  - switching access control off and on again keeps the admin exception the way it was
 *
 * Real gate, real authorization engine, real SQLite. The embedding model, the vector store, the ingest queue, the
 * re-index runner and the chat model are stubbed. The people:
 *   admin   workspace admin: administers the Knowledge Engine, reads everything unless a module turns the exception off
 *   member  Knowledge Engine write: manages nothing
 *   reader  Knowledge Engine read, named in the permissions of some documents
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-access-read-fixes-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_access_read_fixes_main';

const hoisted = vi.hoisted(() => ({
  chat: vi.fn(),
  queryVectors: vi.fn(),
  upsertVectors: vi.fn(),
  deleteVectors: vi.fn(),
  publishRagIngestJob: vi.fn(),
  /** The re-index run the stubbed service hands out: it counts documents and names the ones that failed. */
  run: (ragModuleKey: string) => ({
    key: `run-${ragModuleKey}`,
    tenantId: 'seed',
    ragModuleKey,
    status: 'running',
    reason: 'manual',
    attempt: 1,
    totalDocuments: 7,
    processedDocuments: 3,
    failedDocuments: 1,
    batchSize: 10,
    errorMessage: '1 document(s) failed to re-index.',
    progress: { lastDocumentId: 'doc-last', heartbeatAt: '2026-10-28T10:00:00.000Z' },
    metadata: {
      moduleFingerprint: 'fp-1',
      failures: [{ documentId: 'doc-x', fileName: 'secret-plan.pdf', error: 'boom' }],
    },
    createdBy: 'seed',
  }),
}));

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: async (params: { body: { input: string[] } }) => ({
    response: { data: params.body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) },
  }),
  handleChatCompletion: hoisted.chat,
}));
vi.mock('@/lib/services/vector/vectorService', () => ({
  queryVectorIndex: hoisted.queryVectors,
  upsertVectors: hoisted.upsertVectors,
  deleteVectors: hoisted.deleteVectors,
  vectorFilterOperatorsOf: () => [],
}));
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: hoisted.publishRagIngestJob }));
vi.mock('@/lib/services/rag/ragReindexService', () => ({
  startRagReindex: async (_db: string, _tenant: string, _project: string, request: { ragModuleKey: string }) =>
    hoisted.run(request.ragModuleKey),
  listRagReindexRuns: async (_db: string, ragModuleKey: string) => [hoisted.run(ragModuleKey)],
  getRagReindexRun: async (_db: string, runKey: string) => hoisted.run(runKey.replace(/^run-/, '')),
  cancelRagReindex: async (_db: string, runKey: string) => ({
    ...hoisted.run(runKey.replace(/^run-/, '')),
    status: 'cancelled',
  }),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IRagModule, type IUser } from '@/lib/database';
import { anonymousKbCaller } from '@/lib/services/rag/access';
import { answerWithRag } from '@/lib/services/rag/ragAnswerService';
import { ingestDocument, queryRag, reingestDocument } from '@/lib/services/rag/ragService';
import { hashSourceText } from '@/lib/services/rag/ragSource';
import { ragApiPlugin } from '@/server/api/plugins/rag';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_access_read_fixes_tenant';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 800, chunkOverlap: 100 };

let db: DatabaseProvider;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId = 'pending';
let projectA = 'pending';
let projectB = 'pending';
const users = {} as Record<'admin' | 'member' | 'reader', IUser>;
const docs = {} as Record<
  'kbOpen' | 'kbPrivate' | 'lockedOpen' | 'lockedPrivate' | 'lockedNobody' | 'plain'
  | 'legacyInB' | 'legacyFree' | 'lockedBPrivate' | 'sharedInB',
  string
>;

type Who = keyof typeof users;

function headersOf(who: Who, json: boolean, project: string) {
  return {
    'x-tenant-db-name': TENANT_DB_NAME,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'rag-access-read-fixes',
    'x-user-id': String(users[who]._id),
    'x-user-role': String(users[who].role),
    'x-user-email': String(users[who].email),
    'x-license-type': 'FREE',
    cookie: `active_project_id=${project}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: { body: string }) => parseJsonBody<any>(res.body);

const send = (
  who: Who,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  project = projectA,
) => app.inject({
  method,
  url: `/api${url}`,
  headers: headersOf(who, payload !== undefined, project),
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

async function addModule(
  key: string,
  project: string,
  index: string,
  extra: Partial<Pick<IRagModule, 'access'>> = {},
): Promise<IRagModule> {
  return db.createRagModule({
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
    ...extra,
  });
}

/** A stored document. `project: null` is a row written before rows named their project; `readers` gives it own permissions. */
async function addDocument(input: {
  key: string;
  fileName: string;
  project?: string | null;
  text?: string;
  readers?: string[];
}): Promise<string> {
  const project = input.project === undefined ? projectA : input.project;
  const text = input.text ?? `text of ${input.fileName}`;
  const row = await db.createRagDocument({
    tenantId,
    ...(project ? { projectId: project } : {}),
    ragModuleKey: input.key,
    fileName: input.fileName,
    status: 'indexed',
    sourceText: text,
    sourceHash: hashSourceText(text),
    createdBy: 'seed',
    ...(input.readers ? { aclMode: 'own' as const } : {}),
  });
  const id = String(row._id);
  if (input.readers) {
    await db.replaceRagAclEntries(
      input.key,
      { type: 'document', id },
      input.readers.map((principal) => ({ tenantId, ...(project ? { projectId: project } : {}), principal, createdBy: 'seed' })),
      project ?? undefined,
    );
  }
  return id;
}

async function moduleId(key: string, project = projectA): Promise<string> {
  return String((await db.findRagModuleByKey(key, project))!._id);
}

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Access Read Fixes',
    slug: 'rag-access-read-fixes',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectA = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
  projectB = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'seed' } as never))._id);

  const make = async (who: Who, role: 'admin' | 'user', servicePermissions?: Record<string, string>) => {
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
    await db.upsertUserProject({ tenantId, userId: String(users[who]._id), projectId: projectA, role: 'member' } as never);
  };
  await make('admin', 'admin');
  await make('member', 'user', { rag: 'write' });
  await make('reader', 'user', { rag: 'read' });
  const reader = `user:${String(users.reader._id)}`;

  // Project A
  await addModule('kb', projectA, 'idx', { access: { enabled: true } });
  await addModule('locked', projectA, 'idx-locked', { access: { enabled: true, adminBypass: false } });
  await addModule('plain', projectA, 'idx-plain');
  // Already on the index of `kb`: renaming it does not move it.
  await addModule('sharer', projectA, 'idx');
  await addModule('toggle', projectA, 'idx-toggle');
  // Four modules on one index (set up directly: the routes no longer let one be pointed at an index like this).
  await addModule('shareplain', projectA, 'idx-s');
  await addModule('shareacl', projectA, 'idx-s', { access: { enabled: true } });
  await addModule('shareacl2', projectA, 'idx-s', { access: { enabled: true } });
  await addModule('otherplain', projectA, 'idx-s');
  // `shared` has access control here and none in project B.
  await addModule('shared', projectA, 'idx-shared', { access: { enabled: true, adminBypass: false } });
  // Project B
  await addModule('bonly', projectB, 'idx-b', { access: { enabled: true } });
  await addModule('lockedb', projectB, 'idx-lb', { access: { enabled: true, adminBypass: false } });
  await addModule('shared', projectB, 'idx-shared-b');

  docs.kbOpen = await addDocument({ key: 'kb', fileName: 'open.md' });
  docs.kbPrivate = await addDocument({ key: 'kb', fileName: 'private.md', readers: [reader] });
  docs.lockedOpen = await addDocument({ key: 'locked', fileName: 'open.md' });
  docs.lockedPrivate = await addDocument({ key: 'locked', fileName: 'private.md', readers: [reader] });
  docs.lockedNobody = await addDocument({ key: 'locked', fileName: 'nobody.md', readers: [] });
  docs.plain = await addDocument({ key: 'plain', fileName: 'plain.md' });
  // Rows written before rows named their project.
  docs.legacyInB = await addDocument({ key: 'bonly', fileName: 'legacy.md', project: null });
  docs.legacyFree = await addDocument({ key: 'nokey', fileName: 'free.md', project: null });
  docs.lockedBPrivate = await addDocument({ key: 'lockedb', fileName: 'b-private.md', project: projectB, readers: [reader] });
  docs.sharedInB = await addDocument({ key: 'shared', fileName: 'b-shared.md', project: projectB, readers: [reader] });

  app = await createFastifyApiTestApp(ragApiPlugin);
}, 30_000);

beforeEach(() => {
  hoisted.chat.mockReset();
  hoisted.queryVectors.mockReset().mockResolvedValue({ matches: [] });
  hoisted.upsertVectors.mockReset().mockResolvedValue({ upserted: 1 });
  hoisted.deleteVectors.mockReset().mockResolvedValue({ deleted: 1 });
  hoisted.publishRagIngestJob.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a search of a knowledge base without access control', () => {
  const own = { id: 'shareplain:own1:0', score: 0.9, metadata: { _ragModule: 'shareplain', _documentId: 'own1' } };
  // Its stored chunk names the guarded module, whatever the vector says.
  const guardedByRow = { id: 'shareacl:g1:0', score: 0.8, metadata: { _ragModule: 'shareplain' } };
  // No stored chunk at all: only the vector's own metadata says whose it is.
  const guardedByVector = {
    id: 'shareacl2:g2:0',
    score: 0.7,
    metadata: { _ragModule: 'shareacl2', text: 'passage kept in the vector of the guarded module' },
  };
  const openOther = { id: 'otherplain:o1:0', score: 0.6, metadata: { _ragModule: 'otherplain' } };
  const unknownOwner = { id: 'ghost:x:0', score: 0.5, metadata: { _ragModule: 'ghost', text: 'passage of nobody known' } };

  beforeAll(async () => {
    const row = (ragModuleKey: string, vectorId: string, content: string) => ({
      tenantId,
      projectId: projectA,
      ragModuleKey,
      documentId: vectorId.split(':')[1],
      chunkIndex: 0,
      vectorId,
      content,
      metadata: {},
    });
    await db.bulkInsertRagChunks([
      row('shareplain', own.id, 'passage of the module itself'),
      row('shareacl', guardedByRow.id, 'passage that the guarded module keeps behind its checks'),
      row('otherplain', openOther.id, 'passage of a module without checks'),
    ]);
  });

  const search = (moduleKey: string, matches: unknown[]) => {
    hoisted.queryVectors.mockResolvedValue({ matches });
    return queryRag(TENANT_DB_NAME, tenantId, projectA, { ragModuleKey: moduleKey, query: 'passage', topK: 10 }, {
      caller: anonymousKbCaller('unknown'),
    });
  };

  it('leaves out the matches of another module with access control, found by its stored chunk or by the vector', async () => {
    const result = await search('shareplain', [own, guardedByRow, guardedByVector, openOther, unknownOwner]);

    expect(result.matches.map((m) => m.id)).toEqual([own.id, openOther.id, unknownOwner.id]);
    const text = JSON.stringify(result);
    expect(text).not.toContain('guarded module keeps behind');
    expect(text).not.toContain('kept in the vector of the guarded module');
  });

  it('leaves out every match of another module when it cannot tell which of them have access control', async () => {
    const lookup = vi.spyOn(db, 'listRagModules').mockRejectedValueOnce(new Error('module list unavailable'));
    try {
      const result = await search('shareplain', [own, guardedByRow, openOther, unknownOwner]);
      expect(result.matches.map((m) => m.id)).toEqual([own.id]);
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
  });

  it('asks nothing of the other modules when every match is its own', async () => {
    const lookup = vi.spyOn(db, 'listRagModules');
    try {
      const result = await search('shareplain', [own]);
      expect(result.matches.map((m) => m.id)).toEqual([own.id]);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it('does the same for a caller who skips the checks of the module they search', async () => {
    hoisted.queryVectors.mockResolvedValue({
      matches: [
        { id: 'shareacl:own2:0', score: 0.9, metadata: { _ragModule: 'shareacl' } },
        guardedByVector,
        openOther,
      ],
    });
    await db.bulkInsertRagChunks([{
      tenantId,
      projectId: projectA,
      ragModuleKey: 'shareacl',
      documentId: 'own2',
      chunkIndex: 0,
      vectorId: 'shareacl:own2:0',
      content: 'passage of the module the admin searches',
      metadata: {},
    }]);

    const res = await send('admin', 'POST', '/rag/modules/shareacl/query', { query: 'passage' });
    expect(res.statusCode, res.body).toBe(200);
    const ids = (body(res).result.matches as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['shareacl:own2:0', openOther.id]);
  });
});

describe('a search of a knowledge base without access control, beside modules of the same keys in another project', () => {
  const own = { id: 'shareplain:own9:0', score: 0.9, metadata: { _ragModule: 'shareplain' } };
  // Stored by project B's `shareplain`, which has access control, in the same physical index.
  const twin = { id: 'shareplain:b9:0', score: 0.85, metadata: { _ragModule: 'shareplain' } };
  // Stored by project A's `otherplain`, which has none; project B's `otherplain` has.
  const sibling = { id: 'otherplain:o9:0', score: 0.8, metadata: { _ragModule: 'otherplain' } };

  beforeAll(async () => {
    await addModule('shareplain', projectB, 'idx-s-b', { access: { enabled: true } });
    await addModule('otherplain', projectB, 'idx-o-b', { access: { enabled: true } });
    const row = (project: string, ragModuleKey: string, vectorId: string, content: string) => ({
      tenantId,
      projectId: project,
      ragModuleKey,
      documentId: vectorId.split(':')[1],
      chunkIndex: 0,
      vectorId,
      content,
      metadata: {},
    });
    await db.bulkInsertRagChunks([
      row(projectA, 'shareplain', own.id, 'passage of the module itself'),
      row(projectB, 'shareplain', twin.id, 'passage that project B keeps behind its checks'),
      row(projectA, 'otherplain', sibling.id, 'passage of a sibling without checks'),
    ]);
  });

  const searchIn = (ragModuleKey: string, matches: unknown[]) => {
    hoisted.queryVectors.mockResolvedValue({ matches });
    return queryRag(TENANT_DB_NAME, tenantId, projectA, { ragModuleKey, query: 'passage', topK: 10 }, {
      caller: anonymousKbCaller('unknown'),
    });
  };
  const search = (matches: unknown[]) => searchIn('shareplain', matches);

  it('leaves out what the module of the same key in another project stored, when that one has access control', async () => {
    const result = await search([own, twin]);
    expect(result.matches.map((m) => m.id)).toEqual([own.id]);
    expect(JSON.stringify(result)).not.toContain('project B keeps behind');
  });

  it('keeps a sibling of its own project that has no access control, whatever another project\'s module of that key has', async () => {
    const result = await search([own, sibling]);
    expect(result.matches.map((m) => m.id)).toEqual([own.id, sibling.id]);
  });

  it('judges a row written before rows carried a project by its key, as such documents are', async () => {
    const legacy = { id: 'shareplain:legacy9:0', score: 0.7, metadata: { _ragModule: 'shareplain' } };
    const openLegacy = { id: 'plain:legacy9:0', score: 0.6, metadata: { _ragModule: 'plain' } };
    await db.bulkInsertRagChunks([
      { tenantId, ragModuleKey: 'shareplain', documentId: 'legacy9', chunkIndex: 0, vectorId: legacy.id, content: 'legacy passage of a guarded key', metadata: {} },
      { tenantId, ragModuleKey: 'plain', documentId: 'legacy9', chunkIndex: 0, vectorId: openLegacy.id, content: 'legacy passage of an open key', metadata: {} },
    ] as never);
    // Another module of the key, project B's, has access control: the row may be its, so it is left out.
    const guarded = await search([own, legacy]);
    expect(guarded.matches.map((m) => m.id)).toEqual([own.id]);
    expect(JSON.stringify(guarded)).not.toContain('legacy passage of a guarded key');
    // No other module of the key has: the row is the module's own, as before.
    expect((await searchIn('plain', [openLegacy])).matches.map((m) => m.id)).toEqual([openLegacy.id]);
  });
});

describe('pointing a knowledge base at an index with access control', () => {
  const create = (who: Who, key: string, index: string) => send(who, 'POST', '/rag/modules', {
    name: key,
    key,
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: index,
    chunkConfig: CHUNK_CONFIG,
  });

  it('refuses a new knowledge base on the index of one whose checks the caller does not skip', async () => {
    const refused = await create('member', 'copy-of-kb', 'idx');
    expect(refused.statusCode, refused.body).toBe(403);
    expect(body(refused).code).toBe('kb_access_controlled');
    expect(await db.findRagModuleByKey('copy-of-kb', projectA)).toBeNull();

    // The admin exception is off in `locked`: the admin is held to it too.
    const adminRefused = await create('admin', 'copy-of-locked', 'idx-locked');
    expect(adminRefused.statusCode, adminRefused.body).toBe(403);
    expect(body(adminRefused).code).toBe('kb_access_controlled');
    expect(await db.findRagModuleByKey('copy-of-locked', projectA)).toBeNull();
  });

  it('lets through an index nobody guards, and a caller who skips the checks', async () => {
    const free = await create('member', 'on-a-free-index', 'idx-free');
    expect(free.statusCode, free.body).toBe(201);

    const byAdmin = await create('admin', 'admin-on-kb-index', 'idx');
    expect(byAdmin.statusCode, byAdmin.body).toBe(201);
  });

  it('refuses moving a knowledge base onto such an index, not editing one that is already there', async () => {
    const before = await db.findRagModuleByKey('plain', projectA);
    const moved = await send('member', 'PATCH', '/rag/modules/plain', { vectorIndexKey: 'idx' });
    expect(moved.statusCode, moved.body).toBe(403);
    expect(body(moved).code).toBe('kb_access_controlled');
    expect((await db.findRagModuleByKey('plain', projectA))?.vectorIndexKey).toBe(before?.vectorIndexKey);

    const renamed = await send('member', 'PATCH', '/rag/modules/sharer', { name: 'Sharer renamed' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(body(renamed).module.name).toBe('Sharer renamed');

    const sameIndex = await send('member', 'PATCH', '/rag/modules/plain', { name: 'Plain', vectorIndexKey: 'idx-plain' });
    expect(sameIndex.statusCode, sameIndex.body).toBe(200);
  });
});

describe('a document is judged by the knowledge base that owns it', () => {
  it('a row without a project is hidden when its knowledge base, in another project, has access control', async () => {
    const id = docs.legacyInB;
    for (const suffix of ['', '/content', '/lines']) {
      const res = await send('member', 'GET', `/rag/modules/bonly/documents/${id}${suffix}`);
      expect(res.statusCode, suffix).toBe(404);
      expect(body(res)).toEqual({ error: 'Document not found' });
    }
    const reingest = await send('member', 'POST', `/rag/modules/bonly/documents/${id}`, { content: 'overwritten' });
    expect(reingest.statusCode).toBe(404);
    const removed = await send('member', 'DELETE', `/rag/modules/bonly/documents/${id}`);
    expect(removed.statusCode).toBe(404);

    const row = await db.findRagDocumentById(id);
    expect(row?.sourceText).toBe('text of legacy.md');
  });

  it('is found from the project that has the knowledge base, by whoever manages it', async () => {
    const res = await send('admin', 'GET', `/rag/modules/bonly/documents/${docs.legacyInB}`, undefined, projectB);
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).document._id).toBe(docs.legacyInB);
  });

  it('a row of a key no knowledge base uses is served as before', async () => {
    const meta = await send('member', 'GET', `/rag/modules/nokey/documents/${docs.legacyFree}`);
    expect(meta.statusCode, meta.body).toBe(200);
    const text = await send('member', 'GET', `/rag/modules/nokey/documents/${docs.legacyFree}/content`);
    expect(text.statusCode, text.body).toBe(200);
    expect(body(text).text).toBe('text of free.md');
  });

  it('a manager who gave up the admin exception does not read the document text, in its own project or from another', async () => {
    const id = docs.lockedBPrivate;
    for (const project of [projectA, projectB]) {
      for (const suffix of ['/content', '/lines']) {
        const res = await send('admin', 'GET', `/rag/modules/lockedb/documents/${id}${suffix}`, undefined, project);
        expect(res.statusCode, `${suffix} from ${project}`).toBe(404);
      }
    }
    // The management view still shows it to them in its own project: they set its permissions.
    const meta = await send('admin', 'GET', `/rag/modules/lockedb/documents/${id}`, undefined, projectB);
    expect(meta.statusCode, meta.body).toBe(200);
    // Another project does not reach it by id at all (detail pages follow the active project).
    const elsewhere = await send('admin', 'GET', `/rag/modules/lockedb/documents/${id}`);
    expect(elsewhere.statusCode, elsewhere.body).toBe(404);
  });

  it('the knowledge base that owns the document decides, not the same key in the request project', async () => {
    // `shared` is closed to the admin in project A (no exception), but the document lives in project B, where it has
    // no access control at all: it is read there, and project A does not reach it by id.
    const own = await send('admin', 'GET', `/rag/modules/shared/documents/${docs.sharedInB}/content`, undefined, projectB);
    expect(own.statusCode, own.body).toBe(200);
    expect(body(own).text).toBe('text of b-shared.md');
    const elsewhere = await send('admin', 'GET', `/rag/modules/shared/documents/${docs.sharedInB}/content`);
    expect(elsewhere.statusCode, elsewhere.body).toBe(404);
  });
});

describe('what a total or a run tells', () => {
  beforeAll(async () => {
    for (const key of ['kb', 'locked', 'plain']) {
      await db.incrementRagModuleTotals(await moduleId(key), { documents: 4, chunks: 9 });
    }
  });

  const totalsOf = (module: Record<string, unknown>) => ({
    documents: module.totalDocuments,
    chunks: module.totalChunks,
  });

  it('a module with access control comes without totals for a caller whose reads are checked', async () => {
    const reader = await send('reader', 'GET', '/rag/modules/kb');
    expect(reader.statusCode, reader.body).toBe(200);
    expect(body(reader).module).not.toHaveProperty('totalDocuments');
    expect(body(reader).module).not.toHaveProperty('totalChunks');

    // A manager who gave up the exception is checked too.
    const locked = await send('admin', 'GET', '/rag/modules/locked');
    expect(body(locked).module).not.toHaveProperty('totalDocuments');
    expect(body(locked).module).not.toHaveProperty('totalChunks');
  });

  it('a manager who skips the checks, and a module without access control, keep their totals', async () => {
    const admin = await send('admin', 'GET', '/rag/modules/kb');
    expect(totalsOf(body(admin).module)).toEqual({ documents: 4, chunks: 9 });
    const plain = await send('reader', 'GET', '/rag/modules/plain');
    expect(totalsOf(body(plain).module)).toEqual({ documents: 4, chunks: 9 });
  });

  it('the list and an edit follow the same rule', async () => {
    const asReader = body(await send('reader', 'GET', '/rag/modules')).modules as Array<Record<string, unknown>>;
    expect(asReader.find((m) => m.key === 'kb')).not.toHaveProperty('totalDocuments');
    expect(totalsOf(asReader.find((m) => m.key === 'plain')!)).toEqual({ documents: 4, chunks: 9 });

    const asAdmin = body(await send('admin', 'GET', '/rag/modules')).modules as Array<Record<string, unknown>>;
    expect(totalsOf(asAdmin.find((m) => m.key === 'kb')!)).toEqual({ documents: 4, chunks: 9 });
    expect(asAdmin.find((m) => m.key === 'locked')).not.toHaveProperty('totalChunks');

    const edited = await send('admin', 'PATCH', '/rag/modules/locked', { description: 'The locked one' });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(body(edited).module.description).toBe('The locked one');
    expect(body(edited).module).not.toHaveProperty('totalDocuments');
    const editedPlain = await send('member', 'PATCH', '/rag/modules/plain', { description: 'The plain one' });
    expect(totalsOf(body(editedPlain).module)).toEqual({ documents: 4, chunks: 9 });
  });

  describe('re-index runs', () => {
    const detailKeys = ['totalDocuments', 'processedDocuments', 'failedDocuments', 'errorMessage'] as const;

    it('show a reader who does not manage the knowledge base no total, no counts and no document names', async () => {
      const res = await send('reader', 'GET', '/rag/modules/kb/reindex');
      expect(res.statusCode, res.body).toBe(200);
      const [run] = body(res).runs;
      for (const key of detailKeys) expect(run, key).not.toHaveProperty(key);
      expect(run.progress).not.toHaveProperty('lastDocumentId');
      expect(run.metadata).not.toHaveProperty('failures');
      expect(res.body).not.toContain('secret-plan.pdf');
      // What says where the run stands stays.
      expect(run.status).toBe('running');
      expect(run.metadata.moduleFingerprint).toBe('fp-1');
    });

    it('starting and cancelling one answers with the same view', async () => {
      const started = await send('member', 'POST', '/rag/modules/kb/reindex', {});
      expect(started.statusCode, started.body).toBe(201);
      for (const key of detailKeys) expect(body(started).run, key).not.toHaveProperty(key);
      expect(started.body).not.toContain('secret-plan.pdf');

      const cancelled = await send('member', 'POST', '/rag/modules/kb/reindex/run-kb/cancel', {});
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(body(cancelled).run.status).toBe('cancelled');
      for (const key of detailKeys) expect(body(cancelled).run, key).not.toHaveProperty(key);
    });

    it('show a manager who skips the checks the whole run', async () => {
      const [run] = body(await send('admin', 'GET', '/rag/modules/kb/reindex')).runs;
      expect(run.totalDocuments).toBe(7);
      expect(run.processedDocuments).toBe(3);
      expect(run.metadata.failures).toHaveLength(1);
    });

    it('show a manager whose own reads are checked everything but the total', async () => {
      const [run] = body(await send('admin', 'GET', '/rag/modules/locked/reindex')).runs;
      expect(run).not.toHaveProperty('totalDocuments');
      expect(run.processedDocuments).toBe(3);
      expect(run.failedDocuments).toBe(1);
      expect(run.metadata.failures).toHaveLength(1);
    });

    it('are the run as it was for a knowledge base without access control', async () => {
      const [run] = body(await send('reader', 'GET', '/rag/modules/plain/reindex')).runs;
      expect(run).toEqual(hoisted.run('plain'));
    });
  });
});

describe('an export', () => {
  const exported = async (who: Who, key: string) => {
    const res = await send(who, 'GET', `/rag/modules/${key}/export`);
    expect(res.statusCode, res.body).toBe(200);
    const [header, ...lines] = res.body.trim().split('\n').map((line) => JSON.parse(line));
    return { raw: res.body, header, names: lines.map((line: { fileName: string }) => line.fileName).sort() };
  };

  it('holds only the documents a manager whose own reads are checked may read, and does not say how many were left out', async () => {
    const { raw, header, names } = await exported('admin', 'locked');
    expect(names).toEqual(['open.md']);
    expect(header.documentCount).toBe(1);
    expect(header.skippedDocuments).toBe(0);
    expect(raw).not.toContain('private.md');
    expect(raw).not.toContain('nobody.md');
    expect(raw).not.toContain('text of nobody.md');
  });

  it('holds every document for a manager who skips the checks, and for a knowledge base without access control', async () => {
    expect((await exported('admin', 'kb')).names).toEqual(expect.arrayContaining(['open.md', 'private.md']));
    expect((await exported('admin', 'plain')).names).toEqual(['plain.md']);
  });

  it('is still for managers only when access control is on', async () => {
    for (const who of ['member', 'reader'] as const) {
      const res = await send(who, 'GET', '/rag/modules/kb/export');
      expect(res.statusCode, who).toBe(403);
      expect(body(res).code).toBe('access_denied');
    }
  });
});

describe('an ingest of the text of a document the caller cannot read', () => {
  const ingest = (who: Who, fileName: string, content: string) =>
    send(who, 'POST', '/rag/modules/kb/documents', { fileName, content });

  it('makes a new document and leaves the hidden one as it was', async () => {
    const text = 'quarterly numbers of the finance team';
    const hidden = await addDocument({ key: 'kb', fileName: 'twin.md', text, readers: [`user:${String(users.reader._id)}`] });
    const before = await db.findRagDocumentById(hidden);

    const res = await ingest('member', 'twin.md', text);
    expect(res.statusCode, res.body).toBe(201);
    const created = body(res).document;
    expect(created._id).not.toBe(hidden);
    expect(created.status).toBe('indexed');
    expect(created.aclMode).toBeUndefined();

    const after = await db.findRagDocumentById(hidden);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(after?.aclMode).toBe('own');
    expect(after?.folderId).toBe(before?.folderId);
    expect(hoisted.upsertVectors).toHaveBeenCalledTimes(1);
  });

  it('still answers "already there" for a document the caller may read', async () => {
    const text = 'handbook chapter that everybody reads';
    const open = await addDocument({ key: 'kb', fileName: 'open-twin.md', text });

    const res = await ingest('member', 'open-twin.md', text);
    expect(res.statusCode, res.body).toBe(201);
    expect(body(res).document._id).toBe(open);
    expect(hoisted.upsertVectors).not.toHaveBeenCalled();
  });

  it('answers "already there" for a manager, who sees every document anyway', async () => {
    const text = 'a document only the reader is named on';
    const hidden = await addDocument({ key: 'kb', fileName: 'managed-twin.md', text, readers: [`user:${String(users.reader._id)}`] });

    const res = await ingest('admin', 'managed-twin.md', text);
    expect(res.statusCode, res.body).toBe(201);
    expect(body(res).document._id).toBe(hidden);
    expect(hoisted.upsertVectors).not.toHaveBeenCalled();
  });
});

describe('an answer drawn from a knowledge base', () => {
  const ask = (ragModuleKey: string) => answerWithRag(
    TENANT_DB_NAME,
    tenantId,
    projectA,
    {
      ragModuleKey,
      question: 'What is the policy?',
      answerModelKey: 'chat',
      // Expanding the question is the one model call that needs no passages.
      retrieval: { multiQuery: true },
    },
    { caller: anonymousKbCaller('unknown') },
  );

  beforeEach(() => {
    hoisted.chat.mockResolvedValue({
      response: { choices: [{ message: { content: 'what is the rule\nwhich policy applies' } }] },
      usage: {},
    });
  });

  it('does not use the semantic cache of the model when the knowledge base has access control', async () => {
    await ask('kb');

    expect(hoisted.chat).toHaveBeenCalled();
    for (const [params] of hoisted.chat.mock.calls) {
      expect(params).not.toHaveProperty('tenantId');
      expect(params.modelKey).toBe('chat');
    }
  });

  it('keeps using it for a knowledge base without', async () => {
    await ask('plain');

    expect(hoisted.chat).toHaveBeenCalled();
    for (const [params] of hoisted.chat.mock.calls) expect(params.tenantId).toBe(tenantId);
  });
});

describe('switching access control off and on again', () => {
  const accessOf = async () => (await db.findRagModuleByKey('toggle', projectA))?.access;
  const patch = async (access: unknown) => {
    const res = await send('admin', 'PATCH', '/rag/modules/toggle', { access });
    expect(res.statusCode, res.body).toBe(200);
  };

  it('keeps the admin exception the way the module set it', async () => {
    await patch({ enabled: true, adminBypass: false });
    expect(await accessOf()).toEqual({ enabled: true, adminBypass: false });

    await patch({ enabled: false });
    expect(await accessOf()).toEqual({ enabled: false, adminBypass: false });

    await patch({ enabled: true });
    expect(await accessOf()).toEqual({ enabled: true, adminBypass: false });
  });

  it('gives it back only when asked, and a clear starts over', async () => {
    await patch({ enabled: true, adminBypass: true });
    expect(await accessOf()).toEqual({ enabled: true });

    await patch({ enabled: true, adminBypass: false });
    await patch(null);
    expect(await accessOf()).toBeFalsy();

    await patch({ enabled: true });
    expect(await accessOf()).toEqual({ enabled: true });
  });
});

describe('the mark of a crawled page', () => {
  const docMetadata = async (id: string) => (await db.findRagDocumentById(id))?.metadata ?? {};

  it('is set by the crawler\'s own ingest only; the same key in anyone else\'s metadata is dropped', async () => {
    const res = await send('member', 'POST', '/rag/modules/plain/documents', {
      fileName: 'https://intranet.example/claimed',
      content: 'uploaded text',
      metadata: { _crawlerKey: 'site', source: 'crawler', team: 'x' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const uploaded = String(body(res).document._id);
    expect(await docMetadata(uploaded)).toMatchObject({ team: 'x', source: 'crawler' });
    expect(await docMetadata(uploaded)).not.toHaveProperty('_crawlerKey');

    const crawled = String((await ingestDocument(TENANT_DB_NAME, tenantId, projectA, {
      ragModuleKey: 'plain',
      fileName: 'https://intranet.example/page',
      content: 'crawled text',
      metadata: { source: 'crawler', _crawlerKey: 'forged' },
      sentByCrawler: { crawlerKey: 'site' },
      createdBy: 'crawler',
    }))._id);
    expect(await docMetadata(crawled)).toMatchObject({ source: 'crawler', _crawlerKey: 'site' });

    // Someone's re-ingest neither sets the mark nor changes it.
    await reingestDocument(TENANT_DB_NAME, tenantId, projectA, {
      ragModuleKey: 'plain', documentId: crawled, content: 'edited text', metadata: { _crawlerKey: 'other', note: 'y' }, updatedBy: 'member',
    });
    expect(await docMetadata(crawled)).toMatchObject({ _crawlerKey: 'site', note: 'y' });
    await reingestDocument(TENANT_DB_NAME, tenantId, projectA, {
      ragModuleKey: 'plain', documentId: uploaded, content: 'edited upload', metadata: { _crawlerKey: 'site' }, updatedBy: 'member',
    });
    expect(await docMetadata(uploaded)).not.toHaveProperty('_crawlerKey');
  });
});
