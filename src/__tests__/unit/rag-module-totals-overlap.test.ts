/**
 * A knowledge base's totals (`totalDocuments`, `totalChunks`) count its indexed documents and their chunks. Ingests,
 * deferred ingests, re-ingests and deletes of ONE document can overlap (two people press re-index, a job runs while
 * someone re-indexes, a delete lands mid-way), and whatever order their writes land in, the totals have to end up
 * equal to what the rows say: every indexed row counted once, with its chunk count, and nothing else.
 *
 * The overlaps are made deterministic without sleeps: an operation is held at a chosen point while the other one runs,
 * then released. The points are its first embedding call (after it has claimed the row, before it writes the result),
 * and right after one of its row writes has landed (before anything that follows that write, such as the totals). While
 * an operation is held, the totals must not be below what the rows hold: a later write could otherwise take off a
 * share that is not on yet, and the clamp at zero would swallow it for good.
 *
 * Real services over the real providers (SQLite, and MongoDB when mongodb-memory-server runs: PARITY_SKIP_MONGODB=1
 * skips it). Only what leaves the process is replaced: the embedding model, the vector store, the file store and the
 * job queue.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  embed: vi.fn(),
  publish: vi.fn(),
  /** Embedding calls to hold, in order: the next call takes the first one. */
  holds: [] as Array<{ reached: () => void; released: Promise<void> }>,
  /** Embedding calls to fail, after the holds are taken. */
  failures: 0,
  /** Row writes to hold right after they land: the first write a hold matches takes it. */
  writeHolds: [] as Array<{
    match: (write: { method: 'update' | 'delete'; id: string; data?: Record<string, unknown> }) => boolean;
    reached: () => void;
    released: Promise<void>;
  }>,
}));

vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: vi.fn() }));
vi.mock('@/lib/services/extraction/engine', () => ({
  extractDocument: vi.fn(),
  convertGuarded: vi.fn(),
  DocumentConversionRefused: class extends Error {},
  removePowerPointWorkingFiles: vi.fn(),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: h.embed,
}));
vi.mock('@/lib/services/vector/vectorService', () => ({
  upsertVectors: vi.fn().mockResolvedValue({ upserted: 1 }),
  queryVectorIndex: vi.fn().mockResolvedValue({ matches: [] }),
  deleteVectors: vi.fn().mockResolvedValue({ deleted: 0 }),
  vectorFilterOperatorsOf: vi.fn(() => []),
}));
vi.mock('@/lib/services/reranker', () => ({ runReranker: vi.fn() }));
vi.mock('@/lib/services/rag/ragIngestJob', () => ({ publishRagIngestJob: h.publish }));
vi.mock('@/lib/services/files/fileService', () => ({
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: h.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db = (await h.getDatabase()) as DatabaseProvider;
      return db.runWithTenant!(tenantDbName, () => fn(db));
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { DatabaseProvider, IRagDocument } from '@/lib/database';
import {
  deleteRagDocument,
  indexPendingRagDocument,
  ingestDocument,
  reingestDocument,
} from '@/lib/services/rag/ragService';
import { describeForEachProvider } from '../integration/db-parity.helper';

const CHUNK_CONFIG = { strategy: 'recursive_character' as const, chunkSize: 200, chunkOverlap: 20 };

/** Text that splits into about `n` chunks of CHUNK_CONFIG. */
function textOf(n: number, word: string): string {
  return Array.from({ length: n }, (_, i) => `${word} paragraph ${i + 1}. ${`${word} `.repeat(25).trim()}.`).join('\n\n');
}

/** Hold the first row write `match` accepts, right after it has landed: the operation making it waits there. */
function holdAfterWrite(match: (typeof h.writeHolds)[number]['match']): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  h.writeHolds.push({ match, reached, released });
  return { reached: reachedPromise, release };
}

/** Hold the next embedding call that is not already held: the operation making it waits after its claim. */
function holdNextEmbedding(): { reached: Promise<void>; release: () => void } {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  h.holds.push({ reached, released });
  return { reached: reachedPromise, release };
}

describeForEachProvider('Knowledge base totals when operations on one document overlap', (getDb) => {
  let tenantDbName = '';
  let tenantId = '';
  let projectId = '';
  let kbCounter = 0;
  const spies: Array<{ mockRestore(): void }> = [];

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => getDb().runWithTenant!(tenantDbName, fn);

  beforeAll(async () => {
    h.getDatabase.mockImplementation(async () => getDb());
    const db = getDb();
    const slug = `kb-totals-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Acme', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' }))._id);
    await inTenant(async () => {
      projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'seed' } as never))._id);
    });
  });

  afterAll(async () => {
    await drainPendingTasks();
    h.getDatabase.mockReset();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.holds.length = 0;
    h.failures = 0;
    h.writeHolds.length = 0;
    // Row writes call through to the provider; one a hold matches waits after it has landed.
    const db = getDb();
    const real = {
      update: db.updateRagDocumentReturningPrevious.bind(db),
      remove: db.deleteRagDocumentReturningPrevious.bind(db),
    };
    const afterWrite = async (write: { method: 'update' | 'delete'; id: string; data?: Record<string, unknown> }) => {
      const at = h.writeHolds.findIndex((hold) => hold.match(write));
      if (at < 0) return;
      const [hold] = h.writeHolds.splice(at, 1);
      hold.reached();
      await hold.released;
    };
    spies.push(
      vi.spyOn(db, 'updateRagDocumentReturningPrevious').mockImplementation(async (id, data) => {
        const before = await real.update(id, data);
        await afterWrite({ method: 'update', id: String(id), data: data as Record<string, unknown> });
        return before;
      }),
      vi.spyOn(db, 'deleteRagDocumentReturningPrevious').mockImplementation(async (id) => {
        const removed = await real.remove(id);
        await afterWrite({ method: 'delete', id: String(id) });
        return removed;
      }),
    );
    h.publish.mockResolvedValue(undefined);
    h.embed.mockImplementation(async (input: { body: { input: string[] } }) => {
      const hold = h.holds.shift();
      if (hold) {
        hold.reached();
        await hold.released;
      } else if (h.failures > 0) {
        h.failures -= 1;
        throw new Error('Embedding service unavailable');
      }
      return { response: { data: input.body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) } };
    });
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  async function makeKb(): Promise<string> {
    kbCounter += 1;
    const key = `kb-${kbCounter}`;
    await inTenant(() => getDb().createRagModule({
      tenantId,
      projectId,
      key,
      name: key,
      embeddingModelKey: 'embed',
      vectorProviderKey: 'vec',
      vectorIndexKey: 'idx',
      chunkConfig: CHUNK_CONFIG,
      status: 'active',
      // Same starting counters as createRagModule in the service.
      totalDocuments: 0,
      totalChunks: 0,
      createdBy: 'seed',
    }));
    return key;
  }

  const ingest = (kb: string, content: string, extra: { deferIndexing?: boolean } = {}) => inTenant(() => ingestDocument(
    tenantDbName, tenantId, projectId, { ragModuleKey: kb, fileName: 'handbook.txt', content, createdBy: 'admin', ...extra },
  ));
  const reingest = (kb: string, documentId: string, content: string) => inTenant(() => reingestDocument(
    tenantDbName, tenantId, projectId, { ragModuleKey: kb, documentId, content, updatedBy: 'admin' },
  ));
  const remove = (kb: string, documentId: string) => inTenant(() => deleteRagDocument(
    tenantDbName, tenantId, projectId, { ragModuleKey: kb, documentId },
  ));
  const runJob = (kb: string, documentId: string) => inTenant(() => indexPendingRagDocument(
    tenantDbName, tenantId, projectId, kb, documentId,
  ));
  const rowsOf = (kb: string) => inTenant(() => getDb().listRagDocuments(kb, { projectId }));

  async function totalsOf(kb: string) {
    const ragModule = (await inTenant(() => getDb().findRagModuleByKey(kb, projectId)))!;
    return { documents: ragModule.totalDocuments ?? 0, chunks: ragModule.totalChunks ?? 0 };
  }

  /** What the totals must say: the indexed rows, once each, with their chunk counts. */
  async function totalsFromRows(kb: string) {
    const indexed = (await rowsOf(kb)).filter((row) => row.status === 'indexed');
    return { documents: indexed.length, chunks: indexed.reduce((sum, row) => sum + (row.chunkCount ?? 0), 0) };
  }

  /** While writes are in flight the totals may count more than the rows hold, never less. */
  async function expectNotBelowRows(kb: string) {
    const totals = await totalsOf(kb);
    const rows = await totalsFromRows(kb);
    expect(totals.documents).toBeGreaterThanOrEqual(rows.documents);
    expect(totals.chunks).toBeGreaterThanOrEqual(rows.chunks);
  }

  const statusOf = (write: { data?: Record<string, unknown> }) => (write.data as Partial<IRagDocument> | undefined)?.status;

  /** An indexed document, and the totals it starts with. */
  async function indexedDocument(kb: string, chunks = 1): Promise<string> {
    const id = String((await ingest(kb, textOf(chunks, 'policy')))._id);
    const row = (await rowsOf(kb)).find((r) => String(r._id) === id)!;
    expect(row.status).toBe('indexed');
    expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
    return id;
  }

  describe('two re-ingests of one indexed document', () => {
    it('count it once when the second starts while the first is indexing, and finishes first', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb);

      const first = holdNextEmbedding();
      const a = reingest(kb, id, textOf(4, 'alpha'));
      await first.reached;
      await reingest(kb, id, textOf(2, 'beta'));
      first.release();
      await a;

      const [row] = await rowsOf(kb);
      expect(row.status).toBe('indexed');
      expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
      expect(await totalsOf(kb)).toEqual(await totalsFromRows(kb));
    });

    it('count it once when both are indexing at the same time, whichever finishes first', async () => {
      for (const order of ['first-finishes-first', 'second-finishes-first'] as const) {
        const kb = await makeKb();
        const id = await indexedDocument(kb, 2);

        const first = holdNextEmbedding();
        const second = holdNextEmbedding();
        const a = reingest(kb, id, textOf(3, 'alpha'));
        await first.reached;
        const b = reingest(kb, id, textOf(1, 'beta'));
        await second.reached;
        if (order === 'first-finishes-first') {
          first.release();
          await a;
          second.release();
          await b;
        } else {
          second.release();
          await b;
          first.release();
          await a;
        }

        const [row] = await rowsOf(kb);
        expect(row.status, order).toBe('indexed');
        expect(await totalsOf(kb), order).toEqual({ documents: 1, chunks: row.chunkCount });
      }
    });

    it('leave the totals agreeing with the row when one of them fails', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb, 2);

      const first = holdNextEmbedding();
      const a = reingest(kb, id, textOf(3, 'alpha'));
      await first.reached;
      h.failures = 1;
      await expect(reingest(kb, id, textOf(1, 'beta'))).rejects.toThrow('Embedding service unavailable');
      expect((await rowsOf(kb))[0].status).toBe('failed');
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });

      first.release();
      await a;

      const [row] = await rowsOf(kb);
      expect(row.status).toBe('indexed');
      expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
    });
  });

  describe('a delete that lands while the document is being indexed', () => {
    it('during a re-ingest: the document is no longer counted, and the re-ingest answers that it is gone', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb, 2);

      const held = holdNextEmbedding();
      const a = reingest(kb, id, textOf(3, 'alpha'));
      await held.reached;
      expect(await remove(kb, id)).toBe(true);
      held.release();

      await expect(a).rejects.toMatchObject({ statusCode: 404 });
      expect(await rowsOf(kb)).toEqual([]);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
    });

    it('during its first ingest: the document is never counted', async () => {
      const kb = await makeKb();

      const held = holdNextEmbedding();
      const a = ingest(kb, textOf(2, 'alpha'));
      await held.reached;
      const [pending] = await rowsOf(kb);
      expect(await remove(kb, String(pending._id))).toBe(true);
      held.release();
      await a;

      expect(await rowsOf(kb)).toEqual([]);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
    });

    it('during a deferred ingest: the document is never counted', async () => {
      const kb = await makeKb();
      const id = String((await ingest(kb, textOf(2, 'alpha'), { deferIndexing: true }))._id);

      const held = holdNextEmbedding();
      const job = runJob(kb, id);
      await held.reached;
      expect(await remove(kb, id)).toBe(true);
      held.release();
      await job;

      expect(await rowsOf(kb)).toEqual([]);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
    });
  });

  describe('a re-ingest that overlaps the document\'s first indexing', () => {
    it('during its first ingest: counted once', async () => {
      const kb = await makeKb();

      const held = holdNextEmbedding();
      const a = ingest(kb, textOf(2, 'alpha'));
      await held.reached;
      const [processing] = await rowsOf(kb);
      await reingest(kb, String(processing._id), textOf(3, 'beta'));
      held.release();
      await a;

      const [row] = await rowsOf(kb);
      expect(row.status).toBe('indexed');
      expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
    });

    it('during a deferred ingest: counted once', async () => {
      const kb = await makeKb();
      const id = String((await ingest(kb, textOf(2, 'alpha'), { deferIndexing: true }))._id);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });

      const held = holdNextEmbedding();
      const job = runJob(kb, id);
      await held.reached;
      await reingest(kb, id, textOf(3, 'beta'));
      held.release();
      await job;

      const [row] = await rowsOf(kb);
      expect(row.status).toBe('indexed');
      expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
    });
  });

  describe('an operation held right after one of its row writes landed', () => {
    it('re-ingest held after its indexed write: a second re-ingest in the gap leaves the document counted once', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb);

      const held = holdAfterWrite((write) => write.method === 'update' && statusOf(write) === 'indexed');
      const a = reingest(kb, id, textOf(2, 'alpha'));
      await held.reached;
      await expectNotBelowRows(kb);
      await reingest(kb, id, textOf(3, 'beta'));
      await expectNotBelowRows(kb);
      held.release();
      await a;

      const [row] = await rowsOf(kb);
      expect(row.status).toBe('indexed');
      expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
    });

    it('re-ingest held after its indexed write: a delete in the gap leaves nothing counted', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb, 2);

      const held = holdAfterWrite((write) => write.method === 'update' && statusOf(write) === 'indexed');
      const a = reingest(kb, id, textOf(1, 'alpha'));
      await held.reached;
      expect(await remove(kb, id)).toBe(true);
      await expectNotBelowRows(kb);
      held.release();
      await a;

      expect(await rowsOf(kb)).toEqual([]);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
    });

    it('re-ingest held after it took the document out of indexed: a second re-ingest in the gap', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb, 2);

      const held = holdAfterWrite((write) => write.method === 'update' && statusOf(write) === 'processing');
      const a = reingest(kb, id, textOf(1, 'alpha'));
      await held.reached;
      await expectNotBelowRows(kb);
      await reingest(kb, id, textOf(3, 'beta'));
      await expectNotBelowRows(kb);
      held.release();
      await a;

      const [row] = await rowsOf(kb);
      expect(row.status).toBe('indexed');
      expect(await totalsOf(kb)).toEqual({ documents: 1, chunks: row.chunkCount });
    });

    it('re-ingest held after it took the document out of indexed: a delete in the gap', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb, 2);

      const held = holdAfterWrite((write) => write.method === 'update' && statusOf(write) === 'processing');
      const a = reingest(kb, id, textOf(1, 'alpha'));
      await held.reached;
      expect(await remove(kb, id)).toBe(true);
      await expectNotBelowRows(kb);
      held.release();

      await expect(a).rejects.toMatchObject({ statusCode: 404 });
      expect(await rowsOf(kb)).toEqual([]);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
    });

    it('delete held after the row is gone: a re-ingest that finishes in the gap', async () => {
      const kb = await makeKb();
      const id = await indexedDocument(kb, 2);

      const first = holdNextEmbedding();
      const a = reingest(kb, id, textOf(3, 'alpha'));
      await first.reached;
      const held = holdAfterWrite((write) => write.method === 'delete');
      const d = remove(kb, id);
      await held.reached;
      first.release();
      await expect(a).rejects.toMatchObject({ statusCode: 404 });
      await expectNotBelowRows(kb);
      held.release();
      expect(await d).toBe(true);

      expect(await rowsOf(kb)).toEqual([]);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
    });

    it('first ingest held after its indexed write: a re-ingest and then a delete in the gap', async () => {
      const kb = await makeKb();

      const held = holdAfterWrite((write) => write.method === 'update' && statusOf(write) === 'indexed');
      const a = ingest(kb, textOf(2, 'alpha'));
      await held.reached;
      const [row] = await rowsOf(kb);
      await reingest(kb, String(row._id), textOf(1, 'beta'));
      await expectNotBelowRows(kb);
      expect(await remove(kb, String(row._id))).toBe(true);
      held.release();
      await a;

      expect(await rowsOf(kb)).toEqual([]);
      expect(await totalsOf(kb)).toEqual({ documents: 0, chunks: 0 });
    });
  });

  it('counts every document of a knowledge base once after a mix of overlapping operations', async () => {
    const kb = await makeKb();
    const kept = await indexedDocument(kb, 2);
    const gone = String((await ingest(kb, textOf(1, 'gamma')))._id);

    const first = holdNextEmbedding();
    const second = holdNextEmbedding();
    const a = reingest(kb, kept, textOf(3, 'alpha'));
    await first.reached;
    const b = reingest(kb, gone, textOf(2, 'beta'));
    await second.reached;
    await reingest(kb, kept, textOf(1, 'delta'));
    expect(await remove(kb, gone)).toBe(true);
    second.release();
    await expect(b).rejects.toMatchObject({ statusCode: 404 });
    first.release();
    await a;

    expect((await rowsOf(kb)).map((row) => String(row._id))).toEqual([kept]);
    expect(await totalsOf(kb)).toEqual(await totalsFromRows(kb));
    expect((await totalsOf(kb)).documents).toBe(1);
  });
});
