/**
 * The Document Store's background jobs: what is queued, and how.
 *
 * Two jobs run on the `files` queue: converting one file to Markdown, and deleting a bucket together with its files.
 * Both are published from a request and run by the consumer (`filesConsumer.ts`) on whichever node picks them up,
 * in the tenant they name. This module is the queue's vocabulary and holds no logic of its own, so the file service
 * (which queues a conversion after an upload) and the job runners (which use the file service) can both import it.
 *
 * Jobs are published with a single attempt: a run that fails writes why onto the record or the bucket, where the
 * person sees it and retries from the screen. A driver-level retry would repeat work that has partly happened.
 */

import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { FileServiceError } from '../errors';

const logger = createLogger('files:queue');

export const FILES_QUEUE = 'files';
export const CONVERT_MARKDOWN_JOB = 'convert-markdown';
export const DELETE_BUCKET_JOB = 'delete-bucket';

export const QUEUE_UNAVAILABLE_MESSAGE = 'The background queue is not available. Try again in a moment.';

/** Where a job runs and for whom. */
export interface FilesJobScope extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  bucketKey: string;
  /** The user whose action queued the job: what the job writes as `updatedBy`. */
  actor: string;
}

export interface ConvertMarkdownJobPayload extends FilesJobScope {
  /** The file's key inside the bucket. */
  key: string;
  /**
   * The record the run settles. A key is not unique (a second upload under one whole key makes a second record), so
   * the job names the record it was queued for. A job queued without one (by an older node) finds the record by key.
   */
  recordId?: string;
}

export type DeleteBucketJobPayload = FilesJobScope;

async function publish(job: string, payload: FilesJobScope): Promise<void> {
  try {
    const queue = await getQueue();
    await queue.publish(FILES_QUEUE, job, payload, { attempts: 1 });
  } catch (error) {
    logger.error('Could not queue a files job', {
      job,
      bucketKey: payload.bucketKey,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new FileServiceError('queue_unavailable', 503, QUEUE_UNAVAILABLE_MESSAGE, { cause: error });
  }
}

export function publishConvertMarkdownJob(payload: ConvertMarkdownJobPayload): Promise<void> {
  return publish(CONVERT_MARKDOWN_JOB, payload);
}

export function publishDeleteBucketJob(payload: DeleteBucketJobPayload): Promise<void> {
  return publish(DELETE_BUCKET_JOB, payload);
}
