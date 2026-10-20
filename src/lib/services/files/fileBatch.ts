/**
 * Several files of one bucket at once: finding them by key, and deleting them.
 *
 * The routes check what the caller may do with each file (a session file is its session's) between the two, so the
 * lookup hands back the records and the delete works on the ones the route let through.
 */

import { getDatabase, type DatabaseProvider, type IFileRecord } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { mapLimit } from './concurrency';
import { describeFailure } from './errors';
import { removeStoredObjects, requireBucketContext, requireBucketRecord, serializeFileRecord } from './fileService';
import type { BatchDeleteResult, FileRecordView } from './types';

const logger = createLogger('files:batch');

/** Files whose objects are removed from the provider at once. */
const DELETE_CONCURRENCY = 4;

/** The most keys one batch names. */
export const BATCH_MAX_KEYS = 100;

async function tenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

/**
 * The records of these keys in one read, in the order the keys were named (a key named twice counts once), and the
 * keys that have none. Reads the database only: a switched-off bucket and a provider that is down do not matter.
 *
 * Nothing stops two records from carrying one key (rows written before an upload replaced the record of its key,
 * or two nodes uploading a new key at the same moment): the first one stands for the key in `found`, and the rest are
 * in `duplicates`. They describe the same object, so a check on who may act on the file (a session's files are its
 * session's) has to cover them too: the one `found` holds is not always the one that says it is a session's.
 */
export async function findFileRecordsByKeys(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  bucketKey: string,
  keys: readonly string[],
): Promise<{ found: FileRecordView[]; missing: string[]; duplicates: FileRecordView[] }> {
  const bucket = await requireBucketRecord(tenantDbName, tenantId, projectId, bucketKey);
  const wanted = [...new Set(keys)];
  const db = await tenantDb(tenantDbName);
  const records = await db.listFileRecordsByKeys({
    providerKey: bucket.providerKey,
    bucketKey: bucket.key,
    projectId,
    keys: wanted,
  });

  const byKey = new Map<string, IFileRecord>();
  const duplicates: FileRecordView[] = [];
  for (const record of records) {
    if (byKey.has(record.key)) duplicates.push(serializeFileRecord(record));
    else byKey.set(record.key, record);
  }
  const found: FileRecordView[] = [];
  const missing: string[] = [];
  for (const key of wanted) {
    const record = byKey.get(key);
    if (record) found.push(serializeFileRecord(record));
    else missing.push(key);
  }
  return { found, missing, duplicates };
}

/**
 * Deletes these files of a bucket: their objects, then their records, a few at a time. A file that cannot be deleted
 * is reported with why and does not stop the others. The bucket must take writes and its provider must be usable;
 * when it is not, the whole call fails with the reason, as the delete of one file does.
 */
export async function deleteFileRecords(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  bucketKey: string,
  records: readonly FileRecordView[],
  deletedBy: string,
): Promise<BatchDeleteResult> {
  const { bucket, runtime } = await requireBucketContext(tenantDbName, tenantId, projectId, bucketKey, 'write');
  const db = await tenantDb(tenantDbName);

  const outcomes = await mapLimit(records, DELETE_CONCURRENCY, async (record): Promise<{ key: string; error?: string }> => {
    try {
      await removeStoredObjects(runtime, bucket, record);
      await db.deleteFileRecord(record.id);
      logger.debug('Deleted file record', { bucketKey: bucket.key, key: record.key, deletedBy });
      return { key: record.key };
    } catch (error) {
      logger.warn('A file of a batch could not be deleted', {
        bucketKey: bucket.key,
        key: record.key,
        error: error instanceof Error ? error.message : String(error),
      });
      return { key: record.key, error: describeFailure(error) };
    }
  });

  return {
    deleted: outcomes.filter((outcome) => outcome.error === undefined).map((outcome) => outcome.key),
    failed: outcomes.flatMap((outcome) => (outcome.error === undefined ? [] : [{ key: outcome.key, error: outcome.error }])),
  };
}
