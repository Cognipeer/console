/**
 * Vector migration queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the snapshot consumer: on single-node (memory queue) deployments it
 * drains locally; on multi-node BullMQ deployments it executes migrations
 * routed to this node.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import {
  VECTOR_MIGRATION_JOB,
  VECTOR_MIGRATION_QUEUE,
  runVectorMigrationJob,
  type VectorMigrationJobPayload,
} from './vectorMigrationJob';

const log = createLogger('vector-migration:consumer');
let started = false;

/** How many index migrations may run concurrently on this node. */
const CONCURRENCY = Math.max(1, Number(process.env.VECTOR_MIGRATION_CONCURRENCY ?? 2) || 2);

export async function startVectorMigrationQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    VECTOR_MIGRATION_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === VECTOR_MIGRATION_JOB) {
        await runVectorMigrationJob(ctx.data as unknown as VectorMigrationJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown vector migration job: ${ctx.name}`);
    },
    { concurrency: CONCURRENCY },
  );
  started = true;
  log.info('Vector migration queue consumer registered', { concurrency: CONCURRENCY });
}
