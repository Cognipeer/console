/**
 * Knowledge Engine ingest background job.
 *
 * Ingesting a document means chunking it, embedding every chunk against the
 * provider and upserting the vectors — work measured in seconds to minutes for
 * anything larger than a FAQ. Running that inside the HTTP request held a
 * worker (and the client's socket) open for the whole run, with no request
 * timeout to bound it, so a handful of concurrent ingests could occupy every
 * connection the node had.
 *
 * Deferred ingestion instead persists the document's source, writes the record
 * as `pending`, and publishes a job here. The consumer
 * (`ragIngestConsumer.ts`) indexes it on whichever node picks it up and moves
 * the record to `indexed` or `failed`; callers follow the document's `status`.
 *
 * The source is stored BEFORE the job is published, so a crash between the two
 * loses the indexing, never the content: `resumePendingRagIngests` re-publishes
 * every `pending` document at boot, which is what makes this survive a restart
 * on the memory queue driver.
 */

import { isServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { EXTRACTION_HEARTBEAT_MS } from './ragExtraction';
import { indexPendingRagDocument } from './ragService';

const logger = createLogger('rag-ingest-job');

export const RAG_INGEST_QUEUE = 'rag-ingest';
export const RAG_INGEST_JOB = 'rag-ingest.document';

export interface RagIngestJobPayload extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  documentId: string;
}

/**
 * Cap on documents re-published by one boot sweep.
 *
 * A tenant that queued thousands of documents before a crash would otherwise
 * turn every startup into a full re-publish storm competing with the readiness
 * probe. What the cap skips stays `pending` and is picked up by the next sweep.
 */
const BOOT_RESUME_MAX = Math.max(
  1,
  Number(process.env.RAG_INGEST_BOOT_RESUME_MAX ?? 500) || 500,
);

/**
 * A deferred extraction whose document was touched this recently is being read by a node that is still alive (it
 * writes a heartbeat every `EXTRACTION_HEARTBEAT_MS`). A boot sweep on a multi-node deployment leaves it alone: a
 * second job would read, and pay for, the same pages again.
 */
const LIVE_EXTRACTION_MS = EXTRACTION_HEARTBEAT_MS * 4;

let recheckScheduled = false;

export async function publishRagIngestJob(
  payload: RagIngestJobPayload,
): Promise<void> {
  const queue = await getQueue();
  await queue.publish(RAG_INGEST_QUEUE, RAG_INGEST_JOB, payload, {
    // No driver-level retry: a run that dies part-way has already written some
    // of the document's chunks, and re-running it would embed those a second
    // time. A failure lands on the record as `failed` + `errorMessage`, exactly
    // as it does on the synchronous path, and re-ingesting is the operator's
    // call (the same way a failed upload is re-uploaded).
    attempts: 1,
    // The boot sweep re-publishes every `pending` document, which can race a
    // job still sitting in the queue from before the restart.
    dedupKey: `${payload.tenantDbName}:${payload.documentId}`,
  });
}

/**
 * Queue handler. Binds the tenant DB for the whole (async) run: a deferred extraction can spend minutes on OCR
 * between queries, and a `switchToTenant` binding does not survive those awaits, so without a scope every later
 * query would read whichever tenant another job last bound.
 */
export async function runRagIngestJob(
  payload: RagIngestJobPayload,
): Promise<void> {
  await runWithTenantScope(payload.tenantDbName, () =>
    indexPendingRagDocument(
      payload.tenantDbName,
      payload.tenantId,
      payload.projectId,
      payload.ragModuleKey,
      payload.documentId,
    ),
  );
}

function isLiveExtraction(doc: { extraction?: { stage?: string }; updatedAt?: Date | string }): boolean {
  if (doc.extraction?.stage !== 'running' || !doc.updatedAt) return false;
  const touched = new Date(doc.updatedAt).getTime();
  return Number.isFinite(touched) && Date.now() - touched < LIVE_EXTRACTION_MS;
}

/**
 * Re-publish documents left `pending` by a restart.
 *
 * Runs after the consumer is registered, mirroring the re-index job's contract.
 * `indexPendingRagDocument` is idempotent, so a document that a surviving job
 * already indexed is a no-op here rather than a double-embed.
 */
export async function resumePendingRagIngests(): Promise<number> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  let resumed = 0;
  let skippedLive = 0;
  // With a single node (the memory queue) nobody else can be reading a document: a `running` stage is a lost run.
  const othersRunExtraction = (await getQueue()).name !== 'memory';

  for (const tenant of tenants) {
    if (!tenant.dbName) continue;
    if (resumed >= BOOT_RESUME_MAX) break;
    // Its documents stay pending until the service is back on.
    if (!(await isServiceEnabled({ tenantDbName: tenant.dbName, tenantId: String(tenant._id) }, 'rag'))) continue;

    try {
      const pending = await runWithTenantScope(tenant.dbName, async (db) => {
        const modules = await db.listRagModules();
        const documents = [];
        for (const ragModule of modules) {
          const stuck = await db.listRagDocuments(ragModule.key, { status: 'pending' });
          for (const doc of stuck) {
            if (othersRunExtraction && isLiveExtraction(doc)) {
              skippedLive += 1;
              continue;
            }
            documents.push({
              tenantId: doc.tenantId,
              projectId: doc.projectId,
              ragModuleKey: ragModule.key,
              documentId: String(doc._id),
            });
          }
        }
        return documents;
      });

      for (const doc of pending) {
        if (resumed >= BOOT_RESUME_MAX) break;
        await publishRagIngestJob({ tenantDbName: tenant.dbName, ...doc });
        resumed += 1;
      }
    } catch (error) {
      logger.warn('Failed to resume pending ingests for tenant', {
        tenant: tenant.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (resumed > 0) logger.info('Resumed pending Knowledge Engine ingests', { resumed });
  if (skippedLive > 0 && !recheckScheduled) {
    // What was left alone may be abandoned after all (its node went down too): look again once it would show.
    recheckScheduled = true;
    const timer = setTimeout(() => {
      recheckScheduled = false;
      void resumePendingRagIngests().catch(() => undefined);
    }, LIVE_EXTRACTION_MS + 5_000);
    timer.unref?.();
  }
  return resumed;
}
