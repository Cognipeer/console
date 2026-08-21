/**
 * Knowledge Engine re-index queue consumer — registered on every node at
 * bootstrap.
 *
 * Mirrors the vector migration consumer: on single-node (memory queue)
 * deployments it drains locally; on multi-node BullMQ deployments it executes
 * the runs routed to this node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import {
  RAG_REINDEX_JOB,
  RAG_REINDEX_QUEUE,
  runRagReindexJob,
  type RagReindexJobPayload,
} from './ragReindexJob';

const log = createLogger('rag-reindex:consumer');
let started = false;

/**
 * How many module re-indexes may run concurrently on this node. Defaults to
 * one: a single run already streams the whole corpus through the embedding
 * provider, so parallel runs mostly buy rate-limit errors.
 */
const CONCURRENCY = Math.max(1, Number(process.env.RAG_REINDEX_CONCURRENCY ?? 1) || 1);

export async function startRagReindexQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    RAG_REINDEX_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === RAG_REINDEX_JOB) {
        await runRagReindexJob(ctx.data as unknown as RagReindexJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown Knowledge Engine re-index job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Knowledge Engine re-index queue consumer registered', { concurrency: CONCURRENCY });
}
