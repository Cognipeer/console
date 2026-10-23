/**
 * "Import from storage": registers the objects that are already in a bucket's folder of the storage provider (put
 * there by another tool, or by this console before its records were lost) as files of the bucket.
 *
 * An import reads one page of the provider's listing at a time and answers with where to continue, so a folder of any
 * size is imported by repeating the call. It only ever adds records: no object is changed, moved or deleted, and
 * running it again skips what it already registered. Imported records say `origin: 'import'`, were uploaded by the
 * person who ran the import, and have no Markdown copy (`skipped`; a file can be converted from its page).
 *
 * Left alone, and counted as skipped: an object that already has a record, an object that is the Markdown copy of a
 * record, a driver's own files (the connection test's folder, the local disk's `.meta.json` companions), a "folder"
 * placeholder, anything the listing returns that is not inside the bucket's folder (the listing matches a prefix
 * as text, so `docs` also lists `docs-archive/...`), and an object whose key the drivers would not address as it
 * stands (a backslash, a `..`, an empty or `.` segment, a control character or a very long key): a record under such
 * a key would read, convert or delete another object.
 *
 * A location shared with another bucket cannot be imported from: the objects in it are not all this bucket's. The
 * import is refused (`storage_location_shared`) before anything is listed.
 */

import mime from 'mime-types';
import { getDatabase, type DatabaseProvider, type IFileBucketRecord, type IFileRecord } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { checkResourceQuota, resolveEffectiveLimits, type QuotaContext } from '@/lib/quota/quotaGuard';
import { bucketClosedError } from './bucketRules';
import { mapLimit } from './concurrency';
import { FileServiceError, storageLocationSharedError } from './errors';
import { fileResilience, findBucketsSharingStorage, requireBucketContext, resolveBucketPrefix } from './fileService';
import type { ImportFromStorageResult } from './types';

export const IMPORT_DEFAULT_LIMIT = 200;
export const IMPORT_MAX_LIMIT = 500;

/** The folder the drivers' connection test writes to; never a file of anybody. */
const CONNECTION_TEST_FOLDER = '.cognipeer-connection-test/';

/** The drivers that keep a `<key>.meta.json` companion beside every object they store. */
const COMPANION_FILE_DRIVERS: ReadonlySet<string> = new Set(['local-filesystem']);

/** Records created at once. */
const CREATE_CONCURRENCY = 4;

/** The longest key the Files routes accept. */
const MAX_OBJECT_KEY_LENGTH = 1024;

const logger = createLogger('files:import');

/** Imports running in this process: a second one for the same bucket would register the same objects twice. */
const running = new Set<string>();

/** The types a store holds for an object it was given none for: they say nothing about what the file is. */
const GENERIC_CONTENT_TYPES: ReadonlySet<string> = new Set(['application/octet-stream', 'binary/octet-stream']);

/**
 * The content type an imported record carries. A listing reports the type the store holds, and some stores hold a
 * generic one for an object that was written without a type (Azure Blob reports `application/octet-stream`): the
 * name is asked before such a type is believed, so a PDF imported from there previews like the same file imported
 * from a store that reports nothing. The generic type is kept when the name does not say better.
 */
function importedContentType(listed: string | undefined, name: string): string | undefined {
  const type = listed?.trim() || undefined;
  const generic = type !== undefined && GENERIC_CONTENT_TYPES.has((type.split(';')[0] ?? '').trim().toLowerCase());
  if (type && !generic) return type;
  return mime.lookup(name) || type || undefined;
}

/**
 * Whether a key can be used as a record's key. Every later read, conversion and delete addresses the object through the
 * driver, and the drivers rewrite some keys on the way (a backslash becomes `/`, a run of dots becomes one dot, `//`
 * collapses); a record under such a key would act on a different object than the one it was made for. The routes
 * trim a key and refuse a long one, so those could not reach the record either.
 */
export function isAddressableObjectKey(key: string): boolean {
  if (key === '' || key !== key.trim() || key.length > MAX_OBJECT_KEY_LENGTH) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return false;
  if (key.includes('..')) return false;
  return key.split('/').every((segment) => segment !== '' && segment !== '.');
}

export interface ImportFromStorageInput {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  bucketKey: string;
  /** The person who ran the import: the uploader of the files it registers. */
  importedBy: string;
  /** Where the previous page ended (`nextCursor` of its answer). */
  cursor?: string;
  /** Objects looked at per call; 1 to `IMPORT_MAX_LIMIT`. */
  limit?: number;
}

async function tenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

/**
 * Whether the project has room for these files: the same limits an upload is held to (the number of files, and the
 * bytes they take). Throws `quota_exceeded` (429) when it has not; nothing is registered then.
 */
async function assertRoomFor(
  context: QuotaContext,
  db: DatabaseProvider,
  incoming: { files: number; bytes: number },
): Promise<void> {
  const used = await db.countFileRecords({ projectId: context.projectId });
  // `checkResourceQuota` asks whether ONE more file fits; the last of these is the one that must.
  const count = await checkResourceQuota(context, 'filesTotal', used + incoming.files - 1);
  if (!count.allowed) {
    const limit = count.effectiveLimits.quotas?.maxFilesTotal;
    throw new FileServiceError(
      'quota_exceeded',
      429,
      `Importing ${incoming.files} files would pass the limit of ${limit} files for this project (${used} in use).`,
    );
  }

  const byteLimit = (await resolveEffectiveLimits(context)).quotas?.maxStorageBytes;
  if (byteLimit !== undefined && byteLimit !== -1) {
    const usedBytes = await db.sumFileRecordBytes({ projectId: context.projectId });
    if (usedBytes + incoming.bytes > byteLimit) {
      throw new FileServiceError(
        'quota_exceeded',
        429,
        `Importing these files would pass the storage limit of this project (${usedBytes + incoming.bytes}/${byteLimit} bytes).`,
      );
    }
  }
}

/**
 * An import checks its bucket once, at the start, and then registers records for as long as a page takes. A bucket
 * that began to be deleted (or was switched off) in between must keep none of them: the deletion lists the bucket's
 * files once and would never see them, and nothing could list or remove them afterwards. Called once the records
 * exist, this reads the bucket again and, when it no longer takes files, removes the records this call made and
 * refuses the import as a write to that bucket would have been refused. An import never touches objects, so there
 * are none to remove. A bucket that cannot be read again leaves the import as it is.
 */
async function withdrawIfBucketClosed(
  db: DatabaseProvider,
  bucket: Pick<IFileBucketRecord, 'tenantId' | 'key'>,
  projectId: string,
  createdIds: string[],
): Promise<void> {
  let current: IFileBucketRecord | null;
  try {
    current = await db.findFileBucketByKey(bucket.tenantId, bucket.key, projectId);
  } catch (error) {
    logger.warn('Could not check that a bucket still takes files after an import', {
      bucketKey: bucket.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const closed = bucketClosedError(current);
  if (!closed) return;

  await Promise.all(createdIds.map((id) => db.deleteFileRecord(id).catch(() => undefined)));
  throw closed;
}

export async function importFromStorage(input: ImportFromStorageInput): Promise<ImportFromStorageResult> {
  const { tenantDbName, tenantId, projectId, bucketKey, importedBy } = input;
  const limit = Math.min(Math.max(Math.floor(input.limit ?? IMPORT_DEFAULT_LIMIT), 1), IMPORT_MAX_LIMIT);

  // A switched-off bucket takes nothing new, and an import adds files.
  const { bucket, provider, runtime } = await requireBucketContext(tenantDbName, tenantId, projectId, bucketKey, 'write');

  const lock = `${tenantId}:${projectId}:${bucket.key}`;
  if (running.has(lock)) {
    throw new FileServiceError('import_in_progress', 409, 'An import is already running for this bucket.');
  }
  running.add(lock);

  try {
    const db = await tenantDb(tenantDbName);
    // Before anything is listed: what a shared location holds is not all this bucket's.
    if ((await findBucketsSharingStorage(db, tenantId, bucket)).length > 0) {
      throw storageLocationSharedError('import');
    }

    const folder = resolveBucketPrefix(bucket);
    const page = await withResilience(
      () => runtime.listFiles({ ...(folder ? { prefix: folder } : {}), limit, ...(input.cursor ? { cursor: input.cursor } : {}) }),
      fileResilience('list', tenantId, bucket.providerKey),
    );

    const skipsCompanions = COMPANION_FILE_DRIVERS.has(provider.driver);
    const candidates: Array<{ key: string; name: string; handle: (typeof page.items)[number] }> = [];
    for (const handle of page.items) {
      const objectKey = handle.key.replace(/^\/+/, '');
      if (folder && !objectKey.startsWith(`${folder}/`)) continue;
      const key = folder ? objectKey.slice(folder.length + 1) : objectKey;
      if (key === '' || key.endsWith('/')) continue;
      if (objectKey.startsWith(CONNECTION_TEST_FOLDER) || key.startsWith(CONNECTION_TEST_FOLDER)) continue;
      if (skipsCompanions && key.endsWith('.meta.json')) continue;
      if (!isAddressableObjectKey(key)) continue;
      candidates.push({ key, name: key.slice(key.lastIndexOf('/') + 1), handle });
    }

    const lookup = { providerKey: bucket.providerKey, bucketKey: bucket.key, projectId, keys: candidates.map((candidate) => candidate.key) };
    const [named, copies] = await Promise.all([
      db.listFileRecordsByKeys(lookup),
      db.listFileRecordsByKeys({ ...lookup, field: 'markdownKey' }),
    ]);
    const known = new Set<string>([
      ...named.map((record) => record.key),
      ...copies.flatMap((record) => (record.markdownKey ? [record.markdownKey] : [])),
    ]);
    const fresh = candidates.filter((candidate) => !known.has(candidate.key));
    let imported = 0;

    if (fresh.length > 0) {
      await assertRoomFor(
        { domain: 'file', projectId, providerKey: bucket.providerKey, resourceKey: bucket.key, tenantDbName, tenantId, userId: importedBy },
        db,
        { files: fresh.length, bytes: fresh.reduce((sum, candidate) => sum + Math.max(candidate.handle.size ?? 0, 0), 0) },
      );

      const createdIds: string[] = [];
      await mapLimit(fresh, CREATE_CONCURRENCY, async ({ key, name, handle }) => {
        // The lock above is this process's. Another node may have registered the object since the lookup, so the
        // key is asked once more right before the insert: the window is one insert, not the whole page.
        if (await db.findFileRecordByKey(bucket.providerKey, bucket.key, key, projectId)) return;
        const contentType = importedContentType(handle.contentType, name);
        const record: Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'> = {
          tenantId,
          projectId,
          providerKey: bucket.providerKey,
          bucketKey: bucket.key,
          key,
          name,
          size: Math.max(handle.size ?? 0, 0),
          ...(contentType ? { contentType } : {}),
          ...(handle.checksum ? { checksum: handle.checksum } : {}),
          ...(handle.etag ? { etag: handle.etag } : {}),
          markdownStatus: 'skipped',
          origin: 'import',
          uploadedBy: importedBy,
          createdBy: importedBy,
        };
        const stored = await db.createFileRecord(record);
        if (stored._id) createdIds.push(String(stored._id));
        imported += 1;
      });

      await withdrawIfBucketClosed(db, bucket, projectId, createdIds);
    }

    return {
      scanned: page.items.length,
      imported,
      skipped: page.items.length - imported,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  } finally {
    running.delete(lock);
  }
}
