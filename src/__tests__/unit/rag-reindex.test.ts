/**
 * Unit tests — Knowledge Engine re-index job.
 * Covers the queue contract (attempts + dedupKey), resuming from a persisted
 * cursor, cross-node cancellation, a failing document not aborting the run,
 * the module counters being recomputed rather than incremented, the
 * cross-process claim that keeps several replicas off the same corpus, and
 * bootstrap's refusal to serve on an invalid production config.
 * DB, queue and the re-ingest pipeline are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';

const reingestDocument = vi.fn();
vi.mock('@/lib/services/rag/ragService', () => ({
  reingestDocument: (...a: unknown[]) => reingestDocument(...a),
}));

const publish = vi.fn().mockResolvedValue('job-1');
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish })),
}));

vi.mock('@/lib/core/cluster', () => ({
  getThisNodeName: () => 'node-a',
}));

/**
 * Bootstrap's two inputs, per test. Hoisted so the `vi.mock` factories below —
 * which vitest lifts above the imports — can close over them.
 */
const boot = vi.hoisted(() => ({
  config: {
    nodeEnv: 'production',
    cache: { provider: 'memory' },
    cors: { enabled: false },
    logging: { level: 'info' },
    rateLimit: { provider: 'memory' },
  },
  configErrors: [] as Array<{ key: string; message: string }>,
  logged: [] as string[],
}));

vi.mock('@/lib/core/config', () => ({
  getConfig: () => boot.config,
  validateConfig: () => boot.configErrors,
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string) => { boot.logged.push(message); },
  }),
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

/**
 * The shared claim the three replicas fight over, modelled the way both
 * mixins must implement it: one atomic compare-and-set on the run record.
 */
interface ClaimState {
  owner?: string;
  heartbeatAt?: number;
}
let claim: ClaimState;
const CLAIMABLE: IRagReindexRun['status'][] = ['pending', 'queued', 'running'];

const claimRagReindexRun = vi.fn(async (_key: string, ownerId: string, staleBefore: Date) => {
  if (!CLAIMABLE.includes(run.status)) return null;
  const heldByAnother = claim.owner !== undefined
    && claim.owner !== ownerId
    && claim.heartbeatAt !== undefined
    && claim.heartbeatAt >= staleBefore.getTime();
  if (heldByAnother) return null;
  claim = { owner: ownerId, heartbeatAt: Date.now() };
  run.status = 'running';
  return run;
});
const touchRagReindexRunClaim = vi.fn(async (_key: string, ownerId: string) => {
  if (claim.owner !== ownerId) return false;
  claim.heartbeatAt = Date.now();
  return true;
});
const releaseRagReindexRunClaim = vi.fn(async (_key: string, ownerId: string) => {
  if (claim.owner === ownerId) claim = {};
});

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
  claimRagReindexRun,
  touchRagReindexRunClaim,
  releaseRagReindexRunClaim,
};

/**
 * A second worker process: a fresh module instance has its own in-process
 * guards and its own worker id, but talks to the same (mocked) database — the
 * only state three replicas share.
 */
async function loadWorker(): Promise<typeof import('@/lib/services/rag/ragReindexJob')> {
  vi.resetModules();
  return import('@/lib/services/rag/ragReindexJob');
}

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
  claim = {};
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

describe('run claim', () => {
  it('lets exactly one of two racing workers execute the run', async () => {
    // Two processes, each with its own in-process guards and worker id, both
    // reached by the boot resume sweep — production's three replicas.
    const workerA = await loadWorker();
    const workerB = await loadWorker();

    let inFlight = 0;
    let maxInFlight = 0;
    reingestDocument.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { status: 'indexed' };
    });

    await Promise.all([
      workerA.runRagReindexJob(payload),
      workerB.runRagReindexJob(payload),
    ]);

    expect(claimRagReindexRun).toHaveBeenCalledTimes(2);
    expect(reingestDocument).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    expect(run).toMatchObject({ status: 'completed', processedDocuments: 3 });
  });

  it('refuses to touch a run another worker is actively holding', async () => {
    run = makeRun({ status: 'running' });
    claim = { owner: 'node-b#live', heartbeatAt: Date.now() };

    await runRagReindexJob(payload);

    expect(reingestDocument).not.toHaveBeenCalled();
    expect(updateRagReindexRun).not.toHaveBeenCalled();
    expect(claim.owner).toBe('node-b#live');
  });

  it('reclaims a run whose owner stopped heartbeating', async () => {
    run = makeRun({ status: 'running', processedDocuments: 2, progress: { lastDocumentId: 'doc-2' } });
    claim = { owner: 'node-b#gone', heartbeatAt: Date.now() - 10 * 60_000 };

    await runRagReindexJob(payload);

    // Resumes from the dead worker's cursor rather than starting over.
    expect(reingestDocument).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ status: 'completed', processedDocuments: 3 });
    expect(claim.owner).toBeUndefined();
  });

  it('stops without finalizing when the claim is taken away mid-run', async () => {
    vi.useFakeTimers();
    try {
      reingestDocument.mockImplementationOnce(async () => {
        // A worker that considered this one dead takes the run over; the
        // heartbeat is how this one finds out.
        claim = { owner: 'node-b#new', heartbeatAt: Date.now() };
        await vi.advanceTimersByTimeAsync(31_000);
        return { status: 'indexed' };
      });

      await runRagReindexJob(payload);
    } finally {
      vi.useRealTimers();
    }

    expect(reingestDocument).toHaveBeenCalledTimes(1);
    // Status, counters and the module belong to the new owner now.
    expect(run.status).toBe('running');
    expect(updateRagModule).not.toHaveBeenCalled();
    expect(claim.owner).toBe('node-b#new');
  });

  it('releases the claim when the run fails, so a retry need not wait it out', async () => {
    ragModule.status = 'disabled';

    await runRagReindexJob(payload);

    expect(run.status).toBe('failed');
    expect(claim.owner).toBeUndefined();
  });

  it('refuses to run at all when the provider has no claim primitive', async () => {
    const provider = db as unknown as Record<string, unknown>;
    const saved = provider.claimRagReindexRun;
    delete provider.claimRagReindexRun;

    try {
      await runRagReindexJob(payload);
    } finally {
      provider.claimRagReindexRun = saved;
    }

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

/**
 * The boot resume sweep above only runs on a process that finished bootstrap,
 * which is why a bootstrap that fails has to take the process with it.
 */
describe('bootstrapApplication', () => {
  afterEach(() => {
    boot.configErrors = [];
    boot.logged = [];
    vi.useRealTimers();
  });

  it('kills the process when the production config is invalid', async () => {
    boot.config.nodeEnv = 'production';
    boot.configErrors = [{ key: 'AUTH_SECRET', message: 'must be set' }];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      vi.resetModules();
      const { bootstrapApplication, isApplicationReady } = await import('@/server/bootstrap');

      // The fake clock goes in AFTER the import, not before it. It exists for
      // bootstrap's own `setTimeout(() => process.exit(1))`, and holding a
      // frozen clock across the import above would hang this test forever the
      // day any module in that graph awaits a real timer while loading.
      vi.useFakeTimers();

      // The only unawaited caller (app.ts) swallows this rejection, so the
      // rejection alone would leave a live process that answers 503 forever
      // while the liveness probe keeps passing.
      await expect(bootstrapApplication()).rejects.toThrow(/AUTH_SECRET/);
      expect(isApplicationReady()).toBe(false);
      expect(boot.logged.some((line) => line.includes('FATAL'))).toBe(true);

      await vi.advanceTimersByTimeAsync(2000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
    // `@/server/bootstrap` is the widest import graph in the app — a cold
    // resetModules + import of it measures ~4s on an idle machine, which is
    // almost the whole of vitest's 5s default before an assertion has run. It
    // fitted only while the suite was small enough to leave the transform pool
    // idle; under a full parallel run it intermittently timed out. The budget
    // below covers the import, not the behaviour: the hang this test guards
    // against (a bootstrap that neither resolves nor exits) still blows it.
  }, 60_000);
});
