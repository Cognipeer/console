/**
 * The background Markdown conversion of one file: asking for it, and doing it.
 *
 * A dashboard upload (and the "Convert" action of a file's page) does not wait for the converter: the record says
 * `markdownStatus: 'pending'`, a job is queued, and the job moves the record to `succeeded`, `skipped` or `failed`
 * (with `markdownError`). The job only runs a record that is still `pending`, so a second run of a finished job, or
 * a file deleted in the meantime, is a no-op.
 *
 * A job that is lost (the memory queue forgets what was queued when the process restarts) leaves a record
 * `pending`; asking for the conversion again queues a new job, whatever the record's status is.
 *
 * The copy is written before the record says so, and anything may have happened since: the file may have been
 * replaced or deleted, another run may have settled the record, the bucket may have been switched off or be deleting.
 * The run reads the record and the bucket again before it settles anything, and a copy that nothing will carry is
 * removed. Runs for one record in this process take turns, so the second finds the record settled and has nothing
 * to do; across nodes that read is what decides, and only the time between it and the write of the record is open.
 */

import { getDatabase, type DatabaseProvider, type FileRecordPatch, type IFileBucketRecord, type IFileRecord } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  applyMarkdownConversion,
  composeProviderObjectKey,
  ensureFileBucketActive,
  findFileRecord,
  oneAtATime,
  readStoredObject,
  requireBucketContext,
  requireBucketRecord,
  serializeFileRecord,
} from '../fileService';
import { bucketClosedError } from '../bucketRules';
import { describeFailure, FileServiceError } from '../errors';
import {
  assertMarkdownConvertible,
  assertMarkdownSize,
  isMarkdownConvertible,
  markdownConversionTooLarge,
} from '../markdownSupport';
import type { FileRecordView, UpdateFileConversionPayload } from '../types';
import { publishConvertMarkdownJob, type ConvertMarkdownJobPayload } from './filesQueue';

const logger = createLogger('files:markdown-job');

async function tenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

/** The record's conversion fields for a finished run: only what the run decided, an error cleared when there is none. */
function conversionPatch(conversion: UpdateFileConversionPayload, actor: string): FileRecordPatch {
  return {
    markdownStatus: conversion.markdownStatus,
    markdownError: conversion.markdownError ?? null,
    ...(conversion.markdownKey !== undefined ? { markdownKey: conversion.markdownKey } : {}),
    ...(conversion.markdownSize !== undefined ? { markdownSize: conversion.markdownSize } : {}),
    ...(conversion.markdownContentType !== undefined ? { markdownContentType: conversion.markdownContentType } : {}),
    updatedBy: actor,
  };
}

/**
 * Marks a file `pending` and queues its conversion. The file must be convertible and within the size limit, and its
 * bucket must take writes (the copy is a new object). Throws `queue_unavailable` (and leaves the record `failed`,
 * with why) when no job can be queued.
 */
export async function queueMarkdownConversion(input: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  bucketKey: string;
  key: string;
  actor: string;
}): Promise<FileRecordView> {
  const bucket = await requireBucketRecord(input.tenantDbName, input.tenantId, input.projectId, input.bucketKey);
  ensureFileBucketActive(bucket);

  const record = await findFileRecord(input.tenantDbName, input.projectId, bucket, input.key);
  assertMarkdownConvertible(record.name);
  assertMarkdownSize(record.size);

  const recordId = record._id?.toString();
  if (!recordId) throw new FileServiceError('file_not_found', 404, 'File record not found.');

  // The status moves first: the answer shows the file as waiting, and the job only runs a record that is.
  const db = await tenantDb(input.tenantDbName);
  const pending = await db.updateFileRecord(recordId, {
    markdownStatus: 'pending',
    markdownError: null,
    updatedBy: input.actor,
  });
  if (!pending) throw new FileServiceError('file_not_found', 404, 'File record not found.');

  try {
    await publishConvertMarkdownJob({
      tenantDbName: input.tenantDbName,
      tenantId: input.tenantId,
      projectId: input.projectId,
      bucketKey: bucket.key,
      key: record.key,
      recordId,
      actor: input.actor,
    });
  } catch (error) {
    await db.updateFileRecord(recordId, {
      markdownStatus: 'failed',
      markdownError: describeFailure(error),
      updatedBy: input.actor,
    }).catch(() => undefined);
    throw error;
  }

  return serializeFileRecord(pending);
}

/**
 * The record a job was queued for: by its id when the payload has one (and only when it is still that bucket's file
 * of that key), otherwise the first record of the key, as a job queued by an older node asks.
 */
async function recordOfJob(
  db: DatabaseProvider,
  bucket: IFileBucketRecord,
  payload: ConvertMarkdownJobPayload,
): Promise<IFileRecord | null> {
  if (!payload.recordId) {
    return db.findFileRecordByKey(bucket.providerKey, bucket.key, payload.key, payload.projectId);
  }
  const record = await db.findFileRecordById(payload.recordId);
  const stillThere = record
    && record.providerKey === bucket.providerKey
    && record.bucketKey === bucket.key
    && record.key === payload.key
    && (!record.projectId || record.projectId === payload.projectId);
  return stillThere ? record : null;
}

/** Whether two reads of a file's record describe the same bytes (a replacement changes the size, the checksum or the etag). */
function sameBytes(a: IFileRecord, b: IFileRecord): boolean {
  return a.size === b.size && (a.checksum ?? null) === (b.checksum ?? null) && (a.etag ?? null) === (b.etag ?? null);
}

/**
 * Why the bucket takes no more files now, or `null` when it does. A bucket that cannot be read is no reason to drop
 * a conversion that is done: not knowing is taken as open, as an upload does.
 */
async function closedBucketError(
  db: DatabaseProvider,
  tenantId: string,
  bucketKey: string,
  projectId: string,
): Promise<FileServiceError | null> {
  try {
    return bucketClosedError(await db.findFileBucketByKey(tenantId, bucketKey, projectId));
  } catch (error) {
    logger.warn('Could not check that a bucket still takes files after a Markdown conversion', {
      bucketKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The conversion itself, for a record that is waiting for it. Throws what stops it; the caller records that. */
async function convertWaitingRecord(
  db: DatabaseProvider,
  bucket: IFileBucketRecord,
  record: IFileRecord,
  recordId: string,
  payload: ConvertMarkdownJobPayload,
): Promise<void> {
  const { tenantDbName, tenantId, projectId, bucketKey, key, actor } = payload;
  const settle = (conversion: UpdateFileConversionPayload) => db.updateFileRecord(recordId, conversionPatch(conversion, actor));

  if (!isMarkdownConvertible(record.name)) {
    await settle({ markdownStatus: 'skipped' });
    return;
  }
  if (markdownConversionTooLarge(record.size)) {
    await settle({ markdownStatus: 'skipped', markdownError: 'The file is larger than the limit for Markdown conversion.' });
    return;
  }

  // A switched-off bucket takes nothing new, and the copy is new.
  const { runtime } = await requireBucketContext(tenantDbName, tenantId, projectId, bucketKey, 'write');
  const original = await readStoredObject(runtime, composeProviderObjectKey(bucket, record.key), {
    tenantId,
    providerKey: bucket.providerKey,
    size: record.size,
  });
  if (markdownConversionTooLarge(original.data.length)) {
    await settle({ markdownStatus: 'skipped', markdownError: 'The file is larger than the limit for Markdown conversion.' });
    return;
  }

  const conversion = await applyMarkdownConversion(runtime, bucket, record, { fileName: record.name }, original.data, db);
  // The copy this run wrote, unless it is the one the record carries: the copy of a file that is converted again
  // takes the place of the first, and that object is the record's.
  const discardCopy = async (carried?: string | null) => {
    if (!conversion.markdownKey || conversion.markdownKey === carried) return;
    await runtime.deleteFile(composeProviderObjectKey(bucket, conversion.markdownKey)).catch(() => undefined);
  };

  // An upload to the same key may have replaced the bytes while they were converted. This copy is of bytes that are
  // gone, and that upload queued a conversion of its own, which finds the record still waiting: this run settles
  // nothing, and the copy (its name was free when it was written, so nobody else holds it) is removed.
  const current = await db.findFileRecordById(recordId);
  if (current && !sameBytes(record, current)) {
    await discardCopy(current.markdownKey);
    logger.debug('Markdown conversion dropped: the file was replaced while it was converted', { bucketKey, key });
    return;
  }

  // Another run of the same request settled the record while this one converted (the convert action queues a job
  // whatever the status is, and a stalled job runs again), or asked for the conversion again: what that run decided
  // stands, and the record is left as it is. This copy would be the second one for a record that has room for one.
  if (current && (current.markdownStatus !== 'pending' || (current.markdownKey ?? null) !== (record.markdownKey ?? null))) {
    await discardCopy(current.markdownKey);
    logger.debug('Markdown conversion dropped: the record was settled while it was converted', { bucketKey, key });
    return;
  }

  // The bucket was switched off or began to be deleted: the deletion lists its files once, and a copy written after
  // that is a file nobody would see. The run stops with the reason, as one that found the bucket closed at its start.
  const closed = await closedBucketError(db, tenantId, bucketKey, projectId);
  if (closed) {
    await discardCopy(current?.markdownKey);
    throw closed;
  }

  const updated = await settle(conversion);

  // The file was deleted while it was converted: its copy has no record to carry it.
  if (!updated) await discardCopy();
  logger.debug('Markdown conversion finished', { bucketKey, key, status: conversion.markdownStatus });
}

/**
 * Writes onto the record why a run stopped, when the record is still waiting for it. Looks the record up again: the
 * run may have stopped before it had found it, and a record that has been settled meanwhile is left as it is.
 */
async function recordFailedRun(payload: ConvertMarkdownJobPayload, error: unknown): Promise<void> {
  const { tenantDbName, tenantId, projectId, bucketKey, actor } = payload;
  try {
    const db = await tenantDb(tenantDbName);
    const bucket = await db.findFileBucketByKey(tenantId, bucketKey, projectId);
    const record = bucket ? await recordOfJob(db, bucket, payload) : null;
    const recordId = record?._id?.toString();
    if (!record || !recordId || record.markdownStatus !== 'pending') return;
    await db.updateFileRecord(
      recordId,
      conversionPatch({ markdownStatus: 'failed', markdownError: describeFailure(error) }, actor),
    );
  } catch (writeError) {
    logger.error('Could not record a failed Markdown conversion', {
      bucketKey,
      key: payload.key,
      error: writeError instanceof Error ? writeError.message : String(writeError),
    });
  }
}

/**
 * Runs one queued conversion. Never throws for a conversion that cannot be done: that is the record's `failed`
 * status and its `markdownError`. Runs in the tenant the payload names (the consumer sets that up).
 *
 * The lookups that find the bucket and the record are inside the same guard as the conversion: a database that fails
 * there leaves the record `failed` with why (when it can still be written), not `pending` for good.
 */
export async function runMarkdownConversionJob(payload: ConvertMarkdownJobPayload): Promise<void> {
  const { tenantDbName, tenantId, projectId, bucketKey, key } = payload;
  // Runs for one record take turns: the second reads what the first settled. A job queued by an older node has no
  // record id, and takes its turn by the key.
  const lane = `convert:${tenantId}:${projectId}:${bucketKey}:${payload.recordId ?? key}`;
  await oneAtATime(lane, async () => {
    try {
      const db = await tenantDb(tenantDbName);
      const bucket = await db.findFileBucketByKey(tenantId, bucketKey, projectId);
      if (!bucket) return;
      const record = await recordOfJob(db, bucket, payload);
      const recordId = record?._id?.toString();
      // Deleted since, or converted by an earlier run of the same request: nothing is waiting.
      if (!record || !recordId || record.markdownStatus !== 'pending') return;

      await convertWaitingRecord(db, bucket, record, recordId, payload);
    } catch (error) {
      logger.warn('Markdown conversion could not run', {
        bucketKey,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      await recordFailedRun(payload, error);
    }
  });
}
