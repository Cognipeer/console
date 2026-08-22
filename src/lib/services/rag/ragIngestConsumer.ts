/**
 * Knowledge Engine ingest queue consumer — registered on every node at
 * bootstrap.
 *
 * Mirrors the re-index consumer: on single-node (memory queue) deployments it
 * drains locally; on multi-node BullMQ deployments it indexes the documents
 * routed to this node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import {
  RAG_INGEST_JOB,
  RAG_INGEST_QUEUE,
  runRagIngestJob,
  type RagIngestJobPayload,
} from './ragIngestJob';

const log = createLogger('rag-ingest:consumer');
let started = false;

/**
 * Documents indexed concurrently on this node.
 *
 * Higher than the re-index default (1) because these are single documents
 * rather than whole corpora, but still modest: each one streams its chunks
 * through the embedding provider, and going wide mostly buys rate-limit errors.
 */
const CONCURRENCY = Math.max(1, Number(process.env.RAG_INGEST_CONCURRENCY ?? 2) || 2);

export async function startRagIngestQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    RAG_INGEST_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === RAG_INGEST_JOB) {
        await runRagIngestJob(ctx.data as unknown as RagIngestJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown Knowledge Engine ingest job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Knowledge Engine ingest queue consumer registered', { concurrency: CONCURRENCY });
}
