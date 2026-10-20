/**
 * The consumer of the Document Store's background jobs (`filesQueue.ts`), registered on every node at bootstrap.
 *
 * On a single node (the memory queue) it drains the jobs published in this process; with BullMQ it runs the ones
 * routed to this node. Every job runs inside the tenant its payload names.
 */

import { runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type JobContext, type QueuePayload } from '@/lib/core/queue';
import { runBucketDeletionJob } from './bucketDeletion';
import {
  CONVERT_MARKDOWN_JOB,
  DELETE_BUCKET_JOB,
  FILES_QUEUE,
  type ConvertMarkdownJobPayload,
  type DeleteBucketJobPayload,
} from './filesQueue';
import { runMarkdownConversionJob } from './markdownConversion';

const logger = createLogger('files:consumer');

/**
 * Jobs a node runs at once. A conversion parses a whole document in this process and a deletion talks to the storage
 * provider for as long as the bucket has files, so a couple at a time is enough and keeps one tenant's backlog from
 * taking the node.
 */
const CONCURRENCY = 2;

export async function startFilesQueueConsumer(): Promise<void> {
  const queue = await getQueue();
  if (queue.hasLocalConsumer(FILES_QUEUE)) return;

  queue.consume(
    FILES_QUEUE,
    async (ctx: JobContext<QueuePayload>) => {
      switch (ctx.name) {
        case CONVERT_MARKDOWN_JOB: {
          const payload = ctx.data as unknown as ConvertMarkdownJobPayload;
          await runWithTenantScope(payload.tenantDbName, () => runMarkdownConversionJob(payload));
          return { ok: true };
        }
        case DELETE_BUCKET_JOB: {
          const payload = ctx.data as unknown as DeleteBucketJobPayload;
          await runWithTenantScope(payload.tenantDbName, () => runBucketDeletionJob(payload));
          return { ok: true };
        }
        default:
          throw new Error(`Unknown files job: ${ctx.name}`);
      }
    },
    { concurrency: CONCURRENCY },
  );
  logger.info('Files queue consumer registered', { concurrency: CONCURRENCY });
}
