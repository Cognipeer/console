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
 *   - the run record itself is CLAIMED before a single document is touched, so
 *     of the N replicas that each sweep the same `running` record at boot,
 *     exactly one executes it (see `RagReindexClaimOps` below);
 *   - cancellation is read from the DB at every document boundary, so it works
 *     across nodes (the in-memory set only makes it instant on this node).
 */

import { randomUUID } from 'node:crypto';
import { getDatabase, runWithTenantScope, type DatabaseProvider } from '@/lib/database';
import type { IRagDocument, IRagModule } from '@/lib/database';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';
import { getThisNodeName } from '@/lib/core/cluster';
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
// twice concurrently. This is a FAST PATH ONLY — it says nothing about the
// other replicas, which is what `RagReindexClaimOps` is for.
const activeRuns = new Set<string>();

/**
 * Live state of ONE execution's claim. Per execution rather than a module-level
 * set keyed by run: a heartbeat still in flight when its job ends must not be
 * able to abort the next attempt at the same run.
 */
interface ClaimGuard {
  lost: boolean;
}

/**
 * Cross-process claim on a run record.
 *
 * Production runs three replicas with the in-process memory queue, so the
 * queue's dedup map and `activeRuns` above are per-pod: after a rolling
 * restart every pod's boot sweep re-drives the same `running` record and all
 * three would re-embed the same corpus, triple-charging the embedding provider
 * and racing each other's cursor. The run record is the only state all pods
 * share, so the claim lives there and must be taken atomically.
 *
 * Contract (implemented by both `mongodb/rag-reindex.mixin.ts` and
 * `sqlite/rag-reindex.mixin.ts`; behaviour must be identical on both):
 *
 * - `claimRagReindexRun(key, ownerId, staleBefore)` — ONE atomic statement
 *   (`findOneAndUpdate` / `UPDATE … WHERE`) that matches the run only when its
 *   status is `pending`/`queued`/`running` AND (`claimedBy` is unset, or it
 *   already equals `ownerId`, or `heartbeatAt` is unset or older than
 *   `staleBefore`). On a match it sets `status: 'running'`, `claimedBy`,
 *   `claimedAt` and `heartbeatAt` to now and returns the updated record;
 *   otherwise it returns `null` WITHOUT writing anything. Callers must treat
 *   `null` as "another worker owns this run — do not touch it".
 * - `touchRagReindexRunClaim(key, ownerId)` — refreshes `heartbeatAt` only
 *   while `claimedBy === ownerId` and the run is still `running`; returns
 *   whether the claim is still held, so a worker that lost it can stop.
 * - `releaseRagReindexRunClaim(key, ownerId)` — clears `claimedBy`/`claimedAt`/
 *   `heartbeatAt` only while still held by `ownerId`; a no-op otherwise.
 */
export interface RagReindexClaimOps {
  claimRagReindexRun(
    key: string,
    ownerId: string,
    staleBefore: Date,
  ): Promise<IRagReindexRun | null>;
  touchRagReindexRunClaim(key: string, ownerId: string): Promise<boolean>;
  releaseRagReindexRunClaim(key: string, ownerId: string): Promise<void>;
}

// How often the owner proves it is alive, and how long a silent owner keeps
// its claim. Three missed beats before another worker may take over: long
// enough that a slow embedding batch never loses a run it is still working on,
// short enough that a SIGKILLed pod's run resumes within a rolling update.
const CLAIM_HEARTBEAT_MS = 30_000;
const CLAIM_STALE_MS = CLAIM_HEARTBEAT_MS * 3;

let workerId: string | null = null;

/**
 * Identity of THIS worker process, stable for its lifetime.
 *
 * The random suffix matters: `getThisNodeName()` falls back to a configured
 * node name that a whole ReplicaSet can share, and a restarted container often
 * reuses both hostname and pid — two live processes must never be able to
 * present the same owner id, or the claim would hand the same run to both.
 *
 * Resolved on first use, not at module load: bootstrap.ts imports this module
 * before `ensureServerEnvLoaded()`, and `getThisNodeName()` reads (and caches)
 * config.
 */
function workerIdentity(): string {
  workerId ??= `${getThisNodeName()}#${randomUUID().slice(0, 8)}`;
  return workerId;
}

/**
 * The claim primitives, or `null` when the provider predates them.
 *
 * Without them there is no way to keep three replicas off the same corpus, so
 * the job refuses to run rather than silently re-embedding everything N times:
 * a re-index that never starts is visible and free, one that runs three times
 * is neither.
 */
function claimOps(db: DatabaseProvider): RagReindexClaimOps | null {
  const provider = db as DatabaseProvider & Partial<RagReindexClaimOps>;
  if (
    typeof provider.claimRagReindexRun !== 'function'
    || typeof provider.touchRagReindexRunClaim !== 'function'
    || typeof provider.releaseRagReindexRunClaim !== 'function'
  ) {
    return null;
  }
  return provider as RagReindexClaimOps;
}

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

/** Whether this worker has been dispossessed of the run it is walking. */
function claimLost(
  guard: ClaimGuard,
  runKey: string,
  processed: number,
  failed: number,
): boolean {
  if (!guard.lost) return false;
  logger.warn('Re-index claim lost to another worker, stopping', { runKey, processed, failed });
  return true;
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
  guard: ClaimGuard,
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

    // Another worker decided this run was orphaned and took it over. It is now
    // walking the same cursor, so this one stops WITHOUT writing status or
    // counters — those belong to the new owner.
    if (claimLost(guard, runKey, processed, failed)) return;

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
        // Carried over explicitly: the rebuilt chunks are only searchable by
        // the same filters as before if the document's metadata goes back in
        // with them.
        metadata: document.metadata,
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

  // Re-checked after the last document too: that is where a slow worker is
  // most likely to have been declared dead, and stamping `completed` on a run
  // someone else is still rebuilding would clear the module's flags early.
  if (claimLost(guard, runKey, processed, failed)) return;

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

/**
 * Keep proving this worker is alive while it grinds through the corpus.
 *
 * Re-enters the tenant scope per beat instead of relying on the enclosing one:
 * the timer fires long after the call that created it returned into an await,
 * and a background timer that queried the process-global tenant handle would
 * be exactly the cross-tenant race `runWithTenantScope` exists to prevent.
 */
function startClaimHeartbeat(
  tenantDbName: string,
  runKey: string,
  guard: ClaimGuard,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void runWithTenantScope(tenantDbName, async (db) => {
      const ops = claimOps(db);
      if (!ops) return;
      const held = await ops.touchRagReindexRunClaim(runKey, workerIdentity());
      if (!held) guard.lost = true;
    }).catch((error) => {
      // A missed beat is survivable (the claim only expires after three);
      // losing the run to a false positive would not be.
      logger.warn('Re-index heartbeat failed', {
        runKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, CLAIM_HEARTBEAT_MS);
  // A re-index must never be the reason the process refuses to exit.
  timer.unref();
  return timer;
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
      const ops = claimOps(db);
      if (!ops) {
        logger.error(
          'Database provider has no re-index claim support; refusing to run the job',
          { runKey },
        );
        return;
      }

      const existing = await db.findRagReindexRunByKey(runKey);
      if (!existing) {
        logger.error('Re-index run not found, aborting job', { runKey });
        return;
      }
      if (existing.status === 'completed' || existing.status === 'cancelled') {
        return;
      }

      // The claim, not the status read above, is what makes this exclusive:
      // every replica's boot sweep reaches this line for the same record and
      // only the one that wins the atomic update gets a run back.
      const run = await ops.claimRagReindexRun(
        runKey,
        workerIdentity(),
        new Date(Date.now() - CLAIM_STALE_MS),
      );
      if (!run) {
        logger.info('Re-index is claimed by another worker, skipping', { runKey });
        return;
      }

      await db.updateRagReindexRun(runKey, {
        startedAt: run.startedAt ?? new Date(),
        errorMessage: undefined,
      });

      const guard: ClaimGuard = { lost: false };
      const heartbeat = startClaimHeartbeat(tenantDbName, runKey, guard);
      try {
        await reindexDocuments(db, payload, run, guard);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Re-index failed', { runKey, error: errorMessage });
        // A worker that no longer owns the run must not write its verdict onto
        // it: the failure it hit may be the new owner rebuilding underneath it.
        if (!guard.lost) {
          await db.updateRagReindexRun(runKey, {
            status: 'failed',
            completedAt: new Date(),
            errorMessage,
          });
          // The module keeps `reindexRequired`: its vectors are still mixed.
          await finalizeModule(db, run, payload.projectId, false);
        }
      } finally {
        clearInterval(heartbeat);
        // Released even on failure so the next attempt claims it immediately
        // instead of waiting out the stale window. Held claims of a worker
        // that died are what the stale window is for.
        await ops.releaseRagReindexRunClaim(runKey, workerIdentity());
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
