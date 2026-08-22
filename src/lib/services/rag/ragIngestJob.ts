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

import { getDatabase, runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
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

export async function runRagIngestJob(
  payload: RagIngestJobPayload,
): Promise<void> {
  await indexPendingRagDocument(
    payload.tenantDbName,
    payload.tenantId,
    payload.projectId,
    payload.ragModuleKey,
    payload.documentId,
  );
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

  for (const tenant of tenants) {
    if (!tenant.dbName) continue;
    if (resumed >= BOOT_RESUME_MAX) break;

    try {
      const pending = await runWithTenantScope(tenant.dbName, async (db) => {
        const modules = await db.listRagModules();
        const documents = [];
        for (const ragModule of modules) {
          const stuck = await db.listRagDocuments(ragModule.key, { status: 'pending' });
          for (const doc of stuck) {
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
  return resumed;
}
