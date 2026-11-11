/**
 * A knowledge base's totals through the dashboard routes, when requests on one document overlap: a re-index held right
 * after its indexed write has landed (before anything it does after that write) while a second re-index or a delete of
 * the same document runs to the end. Both requests answer, and the totals end up equal to what the rows hold.
 *
 * Real routes, real gate, real SQLite. The embedding model, the vector store and the ingest queue are stubbed; the hold
 * sits on the provider's document write and calls through to it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-rag-totals-overlap-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'rag_totals_overlap_main';

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => (typeof input === 'string' ? input : input.toString('utf8')),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: async (params: { body: { input: string[] } }) => ({
    response: { data: params.body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) },
  }),
  handleChatCompletion: vi.fn(),
}));
vi.mock('@/lib/services/vector/vectorService', () => ({
  queryVectorIndex: vi.fn(async () => ({ matches: [] })),
  upsertVectors: vi.fn(async () => ({ upserted: 1 })),
  deleteVectors: vi.fn(async () => ({ deleted: 0 })),
  vectorFilterOperatorsOf: () => [],
}));
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: vi.fn(async () => undefined) }));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type DatabaseProvider, type IUser } from '@/lib/database';
import { ragApiPlugin } from '@/server/api/plugins/rag';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'rag_totals_overlap_tenant';
const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 200, chunkOverlap: 20 };

let db: DatabaseProvider;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let tenantId = 'pending';
let projectId = 'pending';
let admin: IUser;
let kbCounter = 0;
const spies: Array<{ mockRestore(): void }> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: { body: string }) => parseJsonBody<any>(res.body);

const send = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({
  method,
  url: `/api${url}`,
  headers: {
    'x-tenant-db-name': TENANT_DB_NAME,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'rag-totals-overlap',
    'x-user-id': String(admin._id),
    'x-user-role': String(admin.role),
    'x-user-email': String(admin.email),
    'x-license-type': 'FREE',
    cookie: `active_project_id=${projectId}`,
    ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
  },
  ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
});

/** Text that splits into about `n` chunks of CHUNK_CONFIG. */
function textOf(n: number, word: string): string {
  return Array.from({ length: n }, (_, i) => `${word} paragraph ${i + 1}. ${`${word} `.repeat(25).trim()}.`).join('\n\n');
}

/** Hold the first document write that sets `status`, right after it has landed. */
function holdAfterWrite(status: string): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const real = db.updateRagDocumentReturningPrevious.bind(db);
  let armed = true;
  spies.push(vi.spyOn(db, 'updateRagDocumentReturningPrevious').mockImplementation(async (id, data) => {
    const before = await real(id, data);
    if (armed && data.status === status) {
      armed = false;
      reached();
      await released;
    }
    return before;
  }));
  return { reached: reachedPromise, release };
}

async function makeKb(): Promise<string> {
  kbCounter += 1;
  const key = `kb-${kbCounter}`;
  await db.createRagModule({
    tenantId,
    projectId,
    key,
    name: key,
    embeddingModelKey: 'embed',
    vectorProviderKey: 'vec',
    vectorIndexKey: `idx-${kbCounter}`,
    chunkConfig: CHUNK_CONFIG,
    status: 'active',
    totalDocuments: 0,
    totalChunks: 0,
    createdBy: 'seed',
  });
  return key;
}

async function indexedDocument(kb: string): Promise<string> {
  const res = await send('POST', `/rag/modules/${kb}/documents`, { fileName: 'handbook.txt', content: textOf(1, 'policy') });
  expect(res.statusCode, res.body).toBe(201);
  return String(body(res).document._id);
}

async function totalsOf(kb: string) {
  const ragModule = (await db.findRagModuleByKey(kb, projectId))!;
  return { documents: ragModule.totalDocuments ?? 0, chunks: ragModule.totalChunks ?? 0 };
}

beforeAll(async () => {
  reloadConfig();
  db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'Rag Totals Overlap',
    slug: 'rag-totals-overlap',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
  projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
  admin = await db.createUser({
    tenantId,
    email: 'admin@example.com',
    name: 'admin',
    password: '$2b$10$x',
    role: 'admin',
    licenseId: 'FREE',
    features: [],
  } as never);
  await db.upsertUserProject({ tenantId, userId: String(admin._id), projectId, role: 'member' } as never);
  app = await createFastifyApiTestApp(ragApiPlugin);
}, 30_000);

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a re-index request held right after its indexed write landed', () => {
  it('a second re-index of the document in the gap: both answer 200, the document is counted once', async () => {
    const kb = await makeKb();
    const id = await indexedDocument(kb);
    expect(await totalsOf(kb)).toMatchObject({ documents: 1 });

    const held = holdAfterWrite('indexed');
    const first = send('POST', `/rag/modules/${kb}/documents/${id}`, { content: textOf(2, 'alpha') });
    await held.reached;
    const second = await send('POST', `/rag/modules/${kb}/documents/${id}`, { content: textOf(3, 'beta') });
    expect(second.statusCode, second.body).toBe(200);
    held.release();
    const firstDone = await first;
    expect(firstDone.statusCode, firstDone.body).toBe(200);

    const row = (await db.findRagDocumentById(id))!;
    expect(row.status).toBe('indexed');
    expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
  });

  it('a delete of the document in the gap: both answer 200, nothing is counted', async () => {
    const kb = await makeKb();
    const id = await indexedDocument(kb);

    const held = holdAfterWrite('indexed');
    const reindex = send('POST', `/rag/modules/${kb}/documents/${id}`, { content: textOf(2, 'alpha') });
    await held.reached;
    const deleted = await send('DELETE', `/rag/modules/${kb}/documents/${id}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    held.release();
    const done = await reindex;
    expect(done.statusCode, done.body).toBe(200);

    expect(await db.findRagDocumentById(id)).toBeNull();
    expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
  });
});
