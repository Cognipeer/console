/**
 * Knowledge Engine re-index background job.
 *
 * Changing a module's chunk strategy or embedding model only affects documents
 * ingested afterwards, so the module silently ends up holding two generations
 * of vectors. A re-index run rebuilds every document in the module against the
 * current config. Re-embedding a whole corpus takes minutes to hours, so it
 * never runs inside the HTTP request: `startRagReindex` marks the run `queued`
 * and publishes a job here, which the consumer (`ragReindexConsumer.ts`)
 * executes on whichever node picks it up:
 *
 *   - the cursor (last completed document) and the counters are written in the
 *     SAME update after every document, so a crash between them cannot make a
 *     resumed run count the same document twice;
 *   - `resumeInterruptedRagReindexRuns` re-enqueues `queued`/`running` records
 *     at boot, which is what makes the memory queue driver survive a restart;
 *   - cancellation is read from the DB at every document boundary, so it works
 *     across nodes (the in-memory set only makes it instant on this node).
 */

import { getDatabase, runWithTenantScope, type DatabaseProvider } from '@/lib/database';
import type { IRagDocument, IRagModule } from '@/lib/database';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { reingestDocument } from './ragService';

const logger = createLogger('rag-reindex-job');

export const RAG_REINDEX_QUEUE = 'rag-reindex';
export const RAG_REINDEX_JOB = 'rag-reindex.run';

export interface RagReindexJobPayload extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  runKey: string;
}

/** Resume checkpoint kept in `run.progress`. */
interface ReindexProgress {
  lastDocumentId?: string;
  heartbeatAt?: string;
}

/** Per-document failures kept in `run.metadata.failures`, newest last. */
interface ReindexFailure {
  documentId: string;
  fileName: string;
  error: string;
}

// A run whose failure list grows with the corpus would eventually blow up the
// record itself; the UI only ever shows the last few anyway.
const MAX_RECORDED_FAILURES = 20;

// Cancellation requested on THIS node — lets a running loop stop before its
// next DB read. The persisted run status is the cross-node source of truth.
const cancelRequests = new Set<string>();

// Runs currently executing in this process, so a duplicate delivery (or a
// resume sweep racing an in-flight job) cannot re-ingest the same document
// twice concurrently.
const activeRuns = new Set<string>();

export function requestRagReindexCancel(key: string): void {
  cancelRequests.add(key);
}

export async function enqueueRagReindex(payload: RagReindexJobPayload): Promise<void> {
  cancelRequests.delete(payload.runKey);
  const queue = await getQueue();
  await queue.publish(RAG_REINDEX_QUEUE, RAG_REINDEX_JOB, payload, {
    // Retries are handled by the job itself (it resumes from its persisted
    // cursor); a driver-level retry would re-run the same job against a cursor
    // the first attempt already advanced and double-count the progress.
    attempts: 1,
    dedupKey: `${payload.tenantDbName}:${payload.runKey}`,
  });
}

function readProgress(run: IRagReindexRun): ReindexProgress {
  const progress = (run.progress ?? {}) as ReindexProgress;
  return {
    lastDocumentId:
      typeof progress.lastDocumentId === 'string' ? progress.lastDocumentId : undefined,
    heartbeatAt: typeof progress.heartbeatAt === 'string' ? progress.heartbeatAt : undefined,
  };
}

function readFailures(run: IRagReindexRun): ReindexFailure[] {
  const failures = (run.metadata ?? {}).failures;
  return Array.isArray(failures) ? (failures as ReindexFailure[]) : [];
}

async function isCancelled(db: DatabaseProvider, runKey: string): Promise<boolean> {
  if (cancelRequests.has(runKey)) return true;
  const current = await db.findRagReindexRunByKey(runKey);
  return current?.status === 'cancelled';
}

/**
 * Release the module from the run and, when the rebuild actually finished,
 * refresh what the run invalidated.
 *
 * The totals are RECOMPUTED from the documents rather than adjusted by the
 * deltas this run produced: `ingestDocument` maintains them with a
 * read-modify-write and no atomic increment, so an ingest landing while the
 * re-index runs would otherwise leave the counters permanently wrong.
 */
async function finalizeModule(
  db: DatabaseProvider,
  run: IRagReindexRun,
  projectId: string | undefined,
  completed: boolean,
): Promise<void> {
  const ragModule = await db.findRagModuleByKey(run.ragModuleKey, projectId);
  if (!ragModule?._id) return;

  // The key must be PRESENT and undefined: both providers' partial update
  // decide by presence, so leaving the field out would keep the module
  // pointing at a run that is over.
  const patch: Partial<IRagModule> = { activeReindexRunKey: undefined };

  if (completed) {
    const documents = await db.listRagDocuments(run.ragModuleKey, { projectId });
    patch.totalDocuments = documents.length;
    patch.totalChunks = documents.reduce((sum, doc) => sum + (doc.chunkCount ?? 0), 0);
    patch.reindexRequired = false;
    patch.lastReindexAt = new Date();
  }

  await db.updateRagModule(String(ragModule._id), patch);
}

/**
 * Documents in the order the run walks them.
 *
 * Sorted by id rather than left in list order because the cursor is "every
 * document up to this id is done": the two DB backends do not agree on a
 * default order, and a resumed run that walked a different order would skip
 * documents it never touched. A document created mid-run below the cursor is
 * skipped, which is correct — an ingest that just ran already used the new
 * config.
 */
function orderDocuments(documents: IRagDocument[]): IRagDocument[] {
  // Raw code-unit comparison, not localeCompare: the cursor test below is a
  // plain `<=`, and a collator that treats punctuation or case differently
  // would order the walk differently from the resume check.
  return [...documents].sort((a, b) => {
    const left = String(a._id);
    const right = String(b._id);
    if (left < right) return -1;
    return left > right ? 1 : 0;
  });
}

async function reindexDocuments(
  db: DatabaseProvider,
  payload: RagReindexJobPayload,
  run: IRagReindexRun,
): Promise<void> {
  const { runKey, tenantDbName, tenantId, projectId } = payload;

  const ragModule = await db.findRagModuleByKey(run.ragModuleKey, projectId);
  if (!ragModule) {
    throw new Error(`Knowledge Engine module "${run.ragModuleKey}" not found.`);
  }
  // Checked here and not only at start time: a module disabled while the run
  // sat in the queue would otherwise fail once per document instead of once.
  if (ragModule.status !== 'active') {
    throw new Error('Knowledge Engine module is not active.');
  }

  const documents = orderDocuments(await db.listRagDocuments(run.ragModuleKey, { projectId }));

  const resumed = readProgress(run);
  const failures = readFailures(run);
  let processed = run.processedDocuments;
  let failed = run.failedDocuments;

  // `totalDocuments` is refreshed on every pass: documents may have been added
  // or deleted since the run was created, and a stale total makes the progress
  // bar lie.
  await db.updateRagReindexRun(runKey, { totalDocuments: documents.length });

  for (const document of documents) {
    const documentId = String(document._id);
    if (resumed.lastDocumentId && documentId <= resumed.lastDocumentId) continue;

    if (await isCancelled(db, runKey)) {
      cancelRequests.delete(runKey);
      await db.updateRagReindexRun(runKey, {
        status: 'cancelled',
        completedAt: new Date(),
        processedDocuments: processed,
        failedDocuments: failed,
      });
      await finalizeModule(db, run, projectId, false);
      logger.info('Re-index cancelled', { runKey, processed, failed });
      return;
    }

    let failure: ReindexFailure | undefined;
    try {
      await reingestDocument(tenantDbName, tenantId, projectId, {
        ragModuleKey: run.ragModuleKey,
        documentId,
        updatedBy: run.createdBy,
      });
      processed += 1;
    } catch (error) {
      // One unreadable document must not cost the other thousand their rebuild.
      failed += 1;
      failure = {
        documentId,
        fileName: document.fileName,
        error: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      if (failures.length > MAX_RECORDED_FAILURES) failures.shift();
      logger.warn('Re-index document failed', { runKey, documentId, error: failure.error });
    }

    // Checkpoint: the cursor and both counters land in ONE write, so a crash
    // immediately after it resumes at exactly the next document.
    await db.updateRagReindexRun(runKey, {
      processedDocuments: processed,
      failedDocuments: failed,
      progress: { lastDocumentId: documentId, heartbeatAt: new Date().toISOString() },
      ...(failure ? { metadata: { ...(run.metadata ?? {}), failures } } : {}),
    });
  }

  await db.updateRagReindexRun(runKey, {
    status: 'completed',
    completedAt: new Date(),
    processedDocuments: processed,
    failedDocuments: failed,
    errorMessage: failed > 0 ? `${failed} document(s) failed to re-index.` : undefined,
    progress: { heartbeatAt: new Date().toISOString() },
  });

  await finalizeModule(db, run, projectId, true);

  logger.info('Re-index completed', { runKey, module: run.ragModuleKey, processed, failed });
}

/** Queue handler. Binds the tenant DB for the whole (async) execution. */
export async function runRagReindexJob(payload: RagReindexJobPayload): Promise<void> {
  const { runKey, tenantDbName } = payload;
  const guardKey = `${tenantDbName}:${runKey}`;

  if (activeRuns.has(guardKey)) {
    logger.warn('Re-index already running on this node, ignoring duplicate job', { runKey });
    return;
  }
  activeRuns.add(guardKey);

  try {
    await runWithTenantScope(tenantDbName, async (db) => {
      const run = await db.findRagReindexRunByKey(runKey);
      if (!run) {
        logger.error('Re-index run not found, aborting job', { runKey });
        return;
      }
      if (run.status === 'completed' || run.status === 'cancelled') {
        return;
      }

      await db.updateRagReindexRun(runKey, {
        status: 'running',
        startedAt: run.startedAt ?? new Date(),
        errorMessage: undefined,
      });

      try {
        await reindexDocuments(db, payload, run);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Re-index failed', { runKey, error: errorMessage });
        await db.updateRagReindexRun(runKey, {
          status: 'failed',
          completedAt: new Date(),
          errorMessage,
        });
        // The module keeps `reindexRequired`: its vectors are still mixed.
        await finalizeModule(db, run, payload.projectId, false);
      }
    });
  } finally {
    activeRuns.delete(guardKey);
  }
}

/**
 * Re-enqueue runs left `queued`/`running` by a crash or restart.
 * Called from bootstrap after the consumer is registered; each job resumes
 * from its persisted cursor, so already-rebuilt documents are not re-embedded.
 */
export async function resumeInterruptedRagReindexRuns(): Promise<number> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  let resumed = 0;

  for (const tenant of tenants) {
    if (!tenant.dbName) continue;
    try {
      const pending = await runWithTenantScope(tenant.dbName, (db) =>
        db.listRagReindexRuns({ statuses: ['queued', 'running'] }),
      );

      for (const run of pending) {
        await enqueueRagReindex({
          tenantDbName: tenant.dbName,
          tenantId: run.tenantId,
          projectId: run.projectId,
          runKey: run.key,
        });
        resumed += 1;
      }
    } catch (error) {
      logger.warn('Failed to resume re-index runs for tenant', {
        tenant: tenant.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (resumed > 0) logger.info('Resumed interrupted re-index runs', { resumed });
  return resumed;
}
