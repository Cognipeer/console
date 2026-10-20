/**
 * Deleting a bucket together with its files: starting it, and running it.
 *
 * `startBucketDeletion` marks the bucket (`metadata.deleting`, switched off so nothing new is written to it) and
 * queues the job; the answer to the request is "deleting". The job removes every file from the storage provider
 * (the object and its Markdown copy) with a few calls at a time, deletes each file's record right after its
 * objects, and the bucket once no record is left.
 *
 * A bucket whose storage location is shared with another bucket is not deleted with its files: the objects in a
 * shared location are not all its own. That is refused when the deletion is asked for, and checked again by the job
 * before it removes anything.
 *
 * It can be run again at any point: an object that is already gone is no failure, a record that is already gone is
 * skipped, and a bucket that is already gone ends the job. When something cannot be deleted the job stops after
 * the page it was on, leaves the bucket (switched off, `deleting` cleared) with `metadata.deleteError` saying why,
 * and the person deletes it again once the cause is fixed. What the job deleted stays deleted: a record is only
 * removed after its objects are.
 *
 * The bucket is looked at again before every page of records. A bucket removed with `force` (the way out of a
 * deletion that seems stuck, which keeps the files), removed and made again under the same key, or given up on by
 * another run of the same deletion is no longer this job's: it ends before it removes another file, so what the
 * person asked to keep is kept. A page already in hand is finished.
 */

import { getDatabase, type DatabaseProvider, type IFileBucketRecord } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { FileProviderRuntime } from '@/lib/providers';
import {
  BUCKET_DELETE_ERROR_KEY,
  BUCKET_DELETING_KEY,
  isBucketDeleting,
  withoutReservedBucketMetadata,
} from '../bucketRules';
import { mapLimit } from '../concurrency';
import { describeFailure, storageLocationSharedError } from '../errors';
import { findBucketsSharingStorage, removeStoredObjects, requireBucketContext, requireBucketRecord } from '../fileService';
import { publishDeleteBucketJob, type DeleteBucketJobPayload } from './filesQueue';

const logger = createLogger('files:bucket-deletion');

/** Records read, and objects removed in parallel, per step. */
const PAGE_SIZE = 100;
const DELETE_CONCURRENCY = 4;

/**
 * How many times the job goes through the bucket looking for files. An upload that began before the bucket was
 * switched off can still add a file after a pass has listed the bucket; the job lists it again until it is empty.
 */
const MAX_PASSES = 5;

/** Logged when a run finds the bucket removed, replaced or given up on by another run: it removes nothing more. */
const BUCKET_NO_LONGER_DELETED = 'Bucket deletion ended: the bucket was removed or changed while the job ran';

async function tenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function filesFailedMessage(failed: number, reason: string | undefined): string {
  const files = failed === 1 ? '1 file' : `${failed} files`;
  return `${files} could not be deleted from the storage provider${reason ? `: ${reason}` : '.'}`;
}

/**
 * Marks the bucket as being deleted and queues the job. Asking again for a bucket that is already being deleted
 * queues another run (the way back for a run the queue lost), which is harmless: the runs repeat nothing that matters.
 */
export async function startBucketDeletion(input: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  bucketKey: string;
  actor: string;
}): Promise<void> {
  const bucket = await requireBucketRecord(input.tenantDbName, input.tenantId, input.projectId, input.bucketKey);
  const bucketId = bucket._id?.toString();
  if (!bucketId) throw new Error('Bucket identifier missing.');

  const db = await tenantDb(input.tenantDbName);
  // Before anything is marked or queued: a location shared with another bucket cannot be emptied.
  if ((await findBucketsSharingStorage(db, input.tenantId, bucket)).length > 0) {
    throw storageLocationSharedError('delete');
  }
  const otherMetadata = withoutReservedBucketMetadata(bucket.metadata ?? {});
  await db.updateFileBucket(bucketId, {
    status: 'disabled',
    metadata: { ...otherMetadata, [BUCKET_DELETING_KEY]: true },
    updatedBy: input.actor,
  });

  try {
    await publishDeleteBucketJob({
      tenantDbName: input.tenantDbName,
      tenantId: input.tenantId,
      projectId: input.projectId,
      bucketKey: bucket.key,
      actor: input.actor,
    });
  } catch (error) {
    // Nothing started: the bucket goes back to what it was, with the reason on it.
    await db.updateFileBucket(bucketId, {
      status: bucket.status,
      metadata: { ...otherMetadata, [BUCKET_DELETE_ERROR_KEY]: describeFailure(error) },
      updatedBy: input.actor,
    }).catch(() => undefined);
    throw error;
  }
}

/** Leaves the bucket switched off and no longer `deleting`, with why on it. */
async function leaveBucketBecause(
  db: DatabaseProvider,
  bucket: IFileBucketRecord,
  bucketId: string,
  actor: string,
  reason: string,
): Promise<void> {
  await db.updateFileBucket(bucketId, {
    metadata: { ...withoutReservedBucketMetadata(bucket.metadata ?? {}), [BUCKET_DELETE_ERROR_KEY]: reason },
    updatedBy: actor,
  });
}

/**
 * Whether the bucket the run began with is still the one being deleted: it is there, it is the same bucket (one
 * removed and made again under the same key is another), and no other run of the deletion has given up on it. Asked
 * before every page of records.
 */
async function isStillBeingDeleted(
  db: DatabaseProvider,
  payload: DeleteBucketJobPayload,
  bucketId: string,
): Promise<boolean> {
  const current = await db.findFileBucketByKey(payload.tenantId, payload.bucketKey, payload.projectId);
  return current !== null && current._id?.toString() === bucketId && isBucketDeleting(current);
}

/** What one pass over the bucket's records came to. */
interface PassResult {
  failed: number;
  firstReason?: string;
  /** The bucket is no longer this run's to delete (see `isStillBeingDeleted`): nothing more is to be done to it. */
  ended: boolean;
}

/** One pass over the bucket's records: every file's objects, then its record. */
async function removeRecordsOnce(
  db: DatabaseProvider,
  bucket: IFileBucketRecord,
  bucketId: string,
  payload: DeleteBucketJobPayload,
  filesOnce: () => Promise<FileProviderRuntime>,
): Promise<PassResult> {
  const { projectId, bucketKey } = payload;
  let cursor: string | undefined;
  let failed = 0;
  let firstReason: string | undefined;

  do {
    // The pass can take long: a bucket removed (with `force`) or taken over since the last page keeps its files.
    if (!(await isStillBeingDeleted(db, payload, bucketId))) return { failed, ended: true };

    const page = await db.listFileRecords({
      providerKey: bucket.providerKey,
      bucketKey: bucket.key,
      projectId,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });

    if (page.items.length > 0) {
      const files = await filesOnce();
      const reasons = await mapLimit(page.items, DELETE_CONCURRENCY, async (listed): Promise<string | null> => {
        try {
          // The page was read a while ago: a Markdown conversion that has finished since has put its copy on the
          // record, and a copy the job does not know about stays in the provider when the record is gone.
          const record = await db.findFileRecordById(String(listed._id));
          if (!record) return null;
          await removeStoredObjects(files, bucket, record, { markdownCopy: 'strict' });
          await db.deleteFileRecord(String(record._id));
          return null;
        } catch (error) {
          logger.warn('A file could not be deleted with its bucket', {
            bucketKey,
            key: listed.key,
            error: error instanceof Error ? error.message : String(error),
          });
          return describeFailure(error);
        }
      });
      for (const reason of reasons) {
        if (reason === null) continue;
        failed += 1;
        firstReason ??= reason;
      }
    }

    cursor = page.nextCursor;
  } while (cursor);

  return { failed, ended: false, ...(firstReason !== undefined ? { firstReason } : {}) };
}

/**
 * Writes onto the bucket why a run stopped before it had found the bucket (the lookup itself failed): the bucket is
 * looked up again and, when it is still being deleted, left switched off with the reason on it.
 */
async function recordStoppedRun(payload: DeleteBucketJobPayload, reason: string): Promise<void> {
  const { tenantDbName, tenantId, projectId, bucketKey, actor } = payload;
  try {
    const db = await tenantDb(tenantDbName);
    const bucket = await db.findFileBucketByKey(tenantId, bucketKey, projectId);
    const bucketId = bucket?._id?.toString();
    if (!bucket || !bucketId || !isBucketDeleting(bucket)) return;
    await leaveBucketBecause(db, bucket, bucketId, actor, reason);
  } catch (writeError) {
    logger.error('Could not record why a bucket deletion stopped', {
      bucketKey,
      error: writeError instanceof Error ? writeError.message : String(writeError),
    });
  }
}

/**
 * Runs the deletion of a bucket and its files. Runs in the tenant the payload names (the consumer sets that up).
 *
 * The lookups that find the bucket are inside the same guard as the deletion: a database that fails there leaves
 * the bucket with a reason on it (when that can still be written), not `deleting` for good.
 */
export async function runBucketDeletionJob(payload: DeleteBucketJobPayload): Promise<void> {
  const { tenantDbName, tenantId, projectId, bucketKey, actor } = payload;

  // Set once the bucket is found: from then on a stop is written onto the bucket in hand.
  let leaveBecause: ((reason: string) => Promise<void>) | undefined;

  try {
    const db = await tenantDb(tenantDbName);
    const bucket = await db.findFileBucketByKey(tenantId, bucketKey, projectId);
    const bucketId = bucket?._id?.toString();
    // Gone, or not (any more) to be deleted: an earlier run of the same request ended it.
    if (!bucket || !bucketId || !isBucketDeleting(bucket)) return;

    leaveBecause = (reason) => leaveBucketBecause(db, bucket, bucketId, actor, reason);

    // Built when the first file needs it: a bucket with no files is deleted even when its provider is gone.
    let runtime: FileProviderRuntime | undefined;
    const filesOnce = async (): Promise<FileProviderRuntime> => {
      runtime ??= (await requireBucketContext(tenantDbName, tenantId, projectId, bucketKey, 'read')).runtime;
      return runtime;
    };

    for (let pass = 1; ; pass += 1) {
      // Asked again before every pass: a bucket added since the deletion was asked for may share the location.
      if ((await findBucketsSharingStorage(db, tenantId, bucket)).length > 0) {
        await leaveBecause(storageLocationSharedError('delete').message);
        return;
      }

      const { failed, firstReason, ended } = await removeRecordsOnce(db, bucket, bucketId, payload, filesOnce);
      if (ended) {
        logger.info(BUCKET_NO_LONGER_DELETED, { bucketKey });
        return;
      }
      if (failed > 0) {
        await leaveBecause(filesFailedMessage(failed, firstReason));
        return;
      }

      const remaining = await db.listFileRecords({ providerKey: bucket.providerKey, bucketKey: bucket.key, projectId, limit: 1 });
      if (remaining.items.length === 0) break;
      if (pass >= MAX_PASSES) {
        await leaveBecause('Files were still being added to the bucket while it was deleted. Delete it again.');
        return;
      }
    }

    // `false`: the bucket was removed (with `force`) after the last page was read, which is where this run was going.
    if (await db.deleteFileBucket(bucketId)) logger.info('Bucket deleted with its files', { bucketKey });
    else logger.info(BUCKET_NO_LONGER_DELETED, { bucketKey });
  } catch (error) {
    logger.warn('Deleting a bucket with its files stopped', {
      bucketKey,
      error: error instanceof Error ? error.message : String(error),
    });
    const reason = `The deletion stopped: ${describeFailure(error)}`;
    if (leaveBecause) {
      await leaveBecause(reason).catch((writeError: unknown) => {
        logger.error('Could not record why a bucket deletion stopped', {
          bucketKey,
          error: writeError instanceof Error ? writeError.message : String(writeError),
        });
      });
    } else {
      await recordStoppedRun(payload, reason);
    }
  }
}
