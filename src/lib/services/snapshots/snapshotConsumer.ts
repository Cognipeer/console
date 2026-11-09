/**
 * Snapshot queue consumer — registered on every node at bootstrap.
 *
 * Mirrors the dataset generation consumer: on single-node (memory queue)
 * deployments it drains locally; on multi-node BullMQ deployments it executes
 * jobs routed to this node.
 */

import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import {
  SNAPSHOT_JOB,
  SNAPSHOT_QUEUE,
  runSnapshotJob,
  type SnapshotJobPayload,
} from './snapshotJob';

const log = createLogger('snapshots:consumer');
let started = false;

/** How many snapshot jobs may run concurrently on this node. */
const concurrency = () => getConfig().queues.snapshotJobConcurrency;

export async function startSnapshotQueueConsumer(): Promise<void> {
  if (started) return;
  const queue = await getQueue();
  queue.consume(
    SNAPSHOT_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      if (ctx.name === SNAPSHOT_JOB) {
        await runSnapshotJob(ctx.data as unknown as SnapshotJobPayload);
        return { ok: true };
      }
      throw new Error(`Unknown snapshot job: ${ctx.name}`);
    },
    { concurrency: concurrency() },
  );
  started = true;
  log.info('Snapshot queue consumer registered', { concurrency: concurrency() });
}
