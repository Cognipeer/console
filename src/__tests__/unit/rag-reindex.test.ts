/**
 * Unit tests — Knowledge Engine re-index job.
 * Covers the queue contract (attempts + dedupKey), resuming from a persisted
 * cursor, cross-node cancellation, a failing document not aborting the run,
 * and the module counters being recomputed rather than incremented.
 * DB, queue and the re-ingest pipeline are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';

const reingestDocument = vi.fn();
vi.mock('@/lib/services/rag/ragService', () => ({
  reingestDocument: (...a: unknown[]) => reingestDocument(...a),
}));

const publish = vi.fn().mockResolvedValue('job-1');
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish })),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
  runWithTenantScope: vi.fn(
    async (_tenantDbName: string, fn: (provider: unknown) => unknown) => fn(db),
  ),
}));

import {
  enqueueRagReindex,
  runRagReindexJob,
  resumeInterruptedRagReindexRuns,
  RAG_REINDEX_QUEUE,
  RAG_REINDEX_JOB,
} from '@/lib/services/rag/ragReindexJob';

interface TestDocument {
  _id: string;
  fileName: string;
  chunkCount?: number;
}

interface TestModule {
  _id: string;
  key: string;
  status: 'active' | 'disabled';
  totalDocuments: number;
  totalChunks: number;
  reindexRequired?: boolean;
  activeReindexRunKey?: string;
  lastReindexAt?: Date;
}

let run: IRagReindexRun;
let documents: TestDocument[];
let ragModule: TestModule;
let tenants: Array<{ slug: string; dbName: string }>;
let pendingRuns: IRagReindexRun[];

const updateRagReindexRun = vi.fn(async (_key: string, data: Partial<IRagReindexRun>) => {
  Object.assign(run, data);
  return run;
});
const updateRagModule = vi.fn(async (_id: string, data: Partial<TestModule>) => ({
  ...ragModule,
  ...data,
}));

const db = {
  findRagReindexRunByKey: vi.fn(async () => run),
  updateRagReindexRun,
  listRagReindexRuns: vi.fn(async () => pendingRuns),
  findRagModuleByKey: vi.fn(async () => ragModule),
  updateRagModule,
  listRagDocuments: vi.fn(async () => documents),
  listTenants: vi.fn(async () => tenants),
};

function makeRun(overrides: Partial<IRagReindexRun> = {}): IRagReindexRun {
  return {
    tenantId: 'tid',
    projectId: 'p1',
    key: 'kb-reindex-1',
    ragModuleKey: 'kb',
    status: 'queued',
    attempt: 1,
    totalDocuments: 3,
    processedDocuments: 0,
    failedDocuments: 0,
    batchSize: 1,
    createdBy: 'u1',
    ...overrides,
  };
}

const payload = {
  tenantDbName: 't-db',
  tenantId: 'tid',
  projectId: 'p1',
  runKey: 'kb-reindex-1',
};

/** The last patch handed to `updateRagModule`. */
function lastModulePatch(): Partial<TestModule> {
  return updateRagModule.mock.calls[updateRagModule.mock.calls.length - 1][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  reingestDocument.mockResolvedValue({ status: 'indexed' });
  run = makeRun();
  documents = [
    { _id: 'doc-1', fileName: 'a.pdf', chunkCount: 2 },
    { _id: 'doc-2', fileName: 'b.pdf', chunkCount: 3 },
    { _id: 'doc-3', fileName: 'c.pdf', chunkCount: 5 },
  ];
  // Deliberately stale: the run must recompute these, not adjust them.
  ragModule = {
    _id: 'mod-1',
    key: 'kb',
    status: 'active',
    totalDocuments: 99,
    totalChunks: 999,
    reindexRequired: true,
    activeReindexRunKey: 'kb-reindex-1',
  };
  tenants = [{ slug: 'acme', dbName: 't-db' }];
  pendingRuns = [];
});

describe('enqueueRagReindex', () => {
  it('publishes with a single attempt and a tenant-scoped dedup key', async () => {
    await enqueueRagReindex(payload);

    expect(publish).toHaveBeenCalledWith(
      RAG_REINDEX_QUEUE,
      RAG_REINDEX_JOB,
      payload,
      { attempts: 1, dedupKey: 't-db:kb-reindex-1' },
    );
  });
});

describe('runRagReindexJob', () => {
  it('re-ingests every document and completes the run', async () => {
    await runRagReindexJob(payload);

    expect(reingestDocument.mock.calls.map((call) => call[3].documentId)).toEqual([
      'doc-1',
      'doc-2',
      'doc-3',
    ]);
    expect(reingestDocument.mock.calls[0][3]).toMatchObject({
      ragModuleKey: 'kb',
      updatedBy: 'u1',
    });
    expect(run).toMatchObject({
      status: 'completed',
      processedDocuments: 3,
      failedDocuments: 0,
    });
  });

  it('walks documents in id order whatever order the DB returned them', async () => {
    documents = [documents[2], documents[0], documents[1]];

    await runRagReindexJob(payload);

    expect(reingestDocument.mock.calls.map((call) => call[3].documentId)).toEqual([
      'doc-1',
      'doc-2',
      'doc-3',
    ]);
  });

  it('writes the cursor and the counters in the same update', async () => {
    await runRagReindexJob(payload);

    const checkpoints = updateRagReindexRun.mock.calls
      .map((call) => call[1])
      .filter((data) => data.progress !== undefined && data.status === undefined);

    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[0]).toMatchObject({
      processedDocuments: 1,
      failedDocuments: 0,
      progress: expect.objectContaining({ lastDocumentId: 'doc-1' }),
    });
  });

  it('resumes after the persisted cursor without re-ingesting earlier documents', async () => {
    run = makeRun({ status: 'running', processedDocuments: 2, progress: { lastDocumentId: 'doc-2' } });

    await runRagReindexJob(payload);

    expect(reingestDocument).toHaveBeenCalledTimes(1);
    expect(reingestDocument.mock.calls[0][3].documentId).toBe('doc-3');
    expect(run).toMatchObject({ status: 'completed', processedDocuments: 3 });
  });

  it('stops at the next document boundary when the run is cancelled elsewhere', async () => {
    // Another node (or the API) flips the record while document 1 is running.
    reingestDocument.mockImplementationOnce(async () => {
      run.status = 'cancelled';
      return { status: 'indexed' };
    });

    await runRagReindexJob(payload);

    expect(reingestDocument).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ status: 'cancelled', processedDocuments: 1 });
    // Vectors are still mixed, so the module keeps its re-index flag — only
    // the pointer at this run is dropped, and it has to be dropped by a
    // present-but-undefined key for the providers to see it at all.
    const patch = lastModulePatch();
    expect(Object.hasOwn(patch, 'activeReindexRunKey')).toBe(true);
    expect(patch).toStrictEqual({ activeReindexRunKey: undefined });
  });

  it('records a failing document and keeps going', async () => {
    reingestDocument.mockRejectedValueOnce(new Error('unreadable pdf'));

    await runRagReindexJob(payload);

    expect(reingestDocument).toHaveBeenCalledTimes(3);
    expect(run).toMatchObject({
      status: 'completed',
      processedDocuments: 2,
      failedDocuments: 1,
      errorMessage: '1 document(s) failed to re-index.',
    });
    expect(run.metadata?.failures).toEqual([
      { documentId: 'doc-1', fileName: 'a.pdf', error: 'unreadable pdf' },
    ]);
  });

  it('recomputes the module counters and clears the re-index flags', async () => {
    await runRagReindexJob(payload);

    const patch = lastModulePatch();
    expect(patch).toMatchObject({
      totalDocuments: 3,
      totalChunks: 10,
      reindexRequired: false,
      activeReindexRunKey: undefined,
    });
    expect(patch.lastReindexAt).toBeInstanceOf(Date);
  });

  it('marks the run failed and releases the module when the module is gone', async () => {
    db.findRagModuleByKey.mockResolvedValueOnce(null as unknown as TestModule);

    await runRagReindexJob(payload);

    expect(run).toMatchObject({ status: 'failed' });
    expect(run.errorMessage).toContain('not found');
    expect(reingestDocument).not.toHaveBeenCalled();
    expect(lastModulePatch()).toStrictEqual({ activeReindexRunKey: undefined });
  });

  it('fails the run once when the module was disabled while it was queued', async () => {
    ragModule.status = 'disabled';

    await runRagReindexJob(payload);

    expect(reingestDocument).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: 'failed', failedDocuments: 0 });
  });

  it('ignores a duplicate delivery of a run already finished', async () => {
    run = makeRun({ status: 'completed' });

    await runRagReindexJob(payload);

    expect(reingestDocument).not.toHaveBeenCalled();
    expect(updateRagReindexRun).not.toHaveBeenCalled();
  });
});

describe('resumeInterruptedRagReindexRuns', () => {
  it('re-enqueues every unfinished run of every tenant', async () => {
    pendingRuns = [makeRun({ key: 'kb-reindex-1', status: 'running' })];

    const resumed = await resumeInterruptedRagReindexRuns();

    expect(resumed).toBe(1);
    expect(publish).toHaveBeenCalledWith(
      RAG_REINDEX_QUEUE,
      RAG_REINDEX_JOB,
      expect.objectContaining({ tenantDbName: 't-db', runKey: 'kb-reindex-1' }),
      expect.objectContaining({ dedupKey: 't-db:kb-reindex-1' }),
    );
  });
});
