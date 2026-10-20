/**
 * MongoDB Provider – File operations mixin
 *
 * Includes file records, file buckets, and vector counters.
 */

import { ObjectId, type Db } from 'mongodb';
import type { IFileRecord, IFileBucketRecord, IFileBucketStats, IFileEntriesPage, FileListPurpose, FileRecordPatch, FileTypeFilter } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';
import { keyPrefixUpperBound, walkFileEntries, type KeyRange } from '../fileEntryWalk';
import { FILE_KIND_RULES, type FileKindRule } from '../fileTypeFilter';

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * The pattern of a typed search for a file name, for a database that matches by pattern (MongoDB runs it with PCRE, so
 * the letters below are written out, not as \u escapes). The words are looked for as typed (every special character is
 * escaped), the four letters of the Turkish i family (I, İ, i, ı) meet at "i" and an "i" may carry its combining dot,
 * and a letter that can also be spelled as a base letter plus a combining mark ("ü" and "u" + U+0308) matches either
 * spelling - a name imported from a system that stores letters decomposed is found by the composed word, as it is on
 * SQLite, whose function folds the stored name too.
 */
function fileNamePatternSource(text: string): string {
  let source = '';
  for (const letter of text.normalize('NFC')) {
    if (/[İIıi]/.test(letter)) {
      source += '[iİıI]\u0307?';
      continue;
    }
    const composed = letter.replace(REGEX_SPECIALS, '\\$&');
    const decomposed = letter.normalize('NFD');
    source += decomposed === letter ? composed : `(?:${composed}|${decomposed.replace(REGEX_SPECIALS, '\\$&')})`;
  }
  return source;
}

export function FileMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class FileOps extends Base {
    /** Per-process memo: the file indexes are ensured on the first file written per tenant DB. */
    private fileIndexesReady = new Set<string>();

    /**
     * Ensured on the write path as well as in the boot manifest: the manifest
     * only indexes collections that exist when a tenant DB is first bound, so a
     * tenant whose first file is written later would otherwise run the object
     * lookup, the folder listing, the retention sweep and the per-session listing
     * unindexed until a restart. Names/keys are IDENTICAL to the manifest's.
     */
    private async ensureFileIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.fileIndexesReady.has(dbName)) return;
      const coll = db.collection(COLLECTIONS.files);
      await Promise.all([
        coll.createIndex({ providerKey: 1, bucketKey: 1, key: 1 }, { name: 'idx_provider_bucket_key' }),
        coll.createIndex({ purpose: 1, expiresAt: 1 }, { name: 'idx_purpose_expiresAt' }),
        coll.createIndex({ conversationId: 1 }, { name: 'idx_conversationId' }),
      ]);
      this.fileIndexesReady.add(dbName);
    }

    // ── File records ─────────────────────────────────────────────────

    async createFileRecord(
      record: Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IFileRecord> {
      const db = this.getTenantDb();
      await this.ensureFileIndexes(db).catch(() => undefined);
      const now = new Date();
      const document: Omit<IFileRecord, '_id'> & {
        createdAt: Date;
        updatedAt: Date;
      } = {
        ...record,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .insertOne(document as unknown as IFileRecord);

      return {
        ...document,
        _id: result.insertedId.toString(),
      };
    }

    async updateFileRecord(id: string, data: FileRecordPatch): Promise<IFileRecord | null> {
      const db = this.getTenantDb();
      const objectId = new ObjectId(id);

      const existing = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .findOne({ _id: objectId });

      if (!existing) {
        return null;
      }

      const payload: Partial<IFileRecord> = {
        ...(data as Partial<IFileRecord>),
        updatedAt: new Date(),
      };
      delete payload._id;
      delete payload.tenantId;
      delete payload.providerKey;
      delete payload.bucketKey;
      delete payload.key;
      delete payload.createdBy;

      const result = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .findOneAndUpdate(
          { _id: objectId },
          { $set: payload },
          { returnDocument: 'after' },
        );

      if (!result) {
        return null;
      }

      return {
        ...result,
        _id: result._id?.toString(),
      } as IFileRecord;
    }

    async deleteFileRecord(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .deleteOne({ _id: new ObjectId(id) });

      return result.deletedCount > 0;
    }

    async findFileRecordById(id: string): Promise<IFileRecord | null> {
      const db = this.getTenantDb();
      const record = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .findOne({ _id: new ObjectId(id) });

      if (!record) {
        return null;
      }

      return {
        ...record,
        _id: record._id?.toString(),
      };
    }

    async findFileRecordByKey(
      providerKey: string,
      bucketKey: string,
      key: string,
      projectId?: string,
    ): Promise<IFileRecord | null> {
      const db = this.getTenantDb();
      const record = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .findOne(projectId ? { providerKey, bucketKey, key, projectId } : { providerKey, bucketKey, key });

      if (!record) {
        return null;
      }

      return {
        ...record,
        _id: record._id?.toString(),
      };
    }

    async listFileRecordsByKeys(filters: {
      providerKey: string;
      bucketKey: string;
      projectId?: string;
      keys: string[];
      field?: 'key' | 'markdownKey';
    }): Promise<IFileRecord[]> {
      const keys = [...new Set(filters.keys)];
      if (keys.length === 0) return [];
      const db = this.getTenantDb();
      const documents = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .find({
          providerKey: filters.providerKey,
          bucketKey: filters.bucketKey,
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          [filters.field === 'markdownKey' ? 'markdownKey' : 'key']: { $in: keys },
        })
        .toArray();
      return documents.map((record) => ({ ...record, _id: record._id?.toString() }));
    }

    /** `purpose` as a filter: session files, or everything that is not one (a missing field counts as "other"). */
    protected filePurposeFilter(purpose: FileListPurpose | undefined): Record<string, unknown> {
      if (purpose === 'conversation') return { purpose: 'conversation' };
      if (purpose === 'other') return { purpose: { $ne: 'conversation' } };
      return {};
    }

    /**
     * A kind of file (`fileTypeFilter.ts`) as a filter: the content type (parameters allowed after it), and
     * the extension of the name only when no kind claims the content type.
     */
    protected fileTypeCondition(type: FileTypeFilter): Record<string, unknown> {
      const byContentType = (rule: FileKindRule): Array<Record<string, unknown>> => [
        ...rule.mimeTypes.map((value) => ({ contentType: new RegExp(`^\\s*${this.escapeRegex(value)}\\s*(?:;|$)`, 'i') })),
        ...rule.mimePrefixes.map((prefix) => ({ contentType: new RegExp(`^\\s*${this.escapeRegex(prefix)}`, 'i') })),
      ];
      const byExtension = (rule: FileKindRule): Array<Record<string, unknown>> => rule.extensions
        .map((extension) => ({ name: new RegExp(`${this.escapeRegex(extension)}$`, 'i') }));
      const rules = Object.values(FILE_KIND_RULES);
      const claimed = rules.flatMap(byContentType);
      if (type === 'other') {
        return { $nor: [...claimed, ...rules.flatMap(byExtension)] };
      }
      const rule = FILE_KIND_RULES[type];
      return { $or: [...byContentType(rule), { $and: [{ $nor: claimed }, { $or: byExtension(rule) }] }] };
    }

    async listFileRecords(filters: {
      providerKey: string;
      bucketKey: string;
      projectId?: string;
      search?: string;
      prefix?: string;
      purpose?: FileListPurpose;
      type?: FileTypeFilter;
      limit?: number;
      cursor?: string;
    }): Promise<{ items: IFileRecord[]; nextCursor?: string }> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {
        providerKey: filters.providerKey,
        bucketKey: filters.bucketKey,
      };

      if (filters.projectId) {
        query.projectId = filters.projectId;
      }

      Object.assign(query, this.filePurposeFilter(filters.purpose));
      const conditions: Record<string, unknown>[] = [];
      if (filters.prefix) {
        // A key range, exact and served by the (providerKey, bucketKey, key) index.
        const upper = keyPrefixUpperBound(filters.prefix);
        conditions.push({ key: { $gte: filters.prefix, ...(upper !== undefined ? { $lt: upper } : {}) } });
      }

      if (filters.type) conditions.push(this.fileTypeCondition(filters.type));

      if (filters.search) {
        // The name of the file, as typed (see `fileNamePatternSource`; the SQLite side folds the same way); a leading
        // or trailing blank is not part of the name looked for. The key is not searched - it holds the folders above
        // the file and a generated suffix, which a search by name must not match.
        const regex = new RegExp(fileNamePatternSource(filters.search.trim()), 'i');
        conditions.push({ name: regex });
      }
      if (conditions.length > 0) query.$and = conditions;

      if (filters.cursor) {
        try {
          query._id = { $gt: new ObjectId(filters.cursor) };
        } catch (error) {
          logger.warn('Invalid cursor provided for listFileRecords', { cursor: filters.cursor, error });
        }
      }

      const limit = Math.min(filters.limit ?? 50, 200);

      const documents = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .find(query)
        .sort({ _id: 1 })
        .limit(limit + 1)
        .toArray();

      const items = documents.slice(0, limit).map((record) => ({
        ...record,
        _id: record._id?.toString(),
      }));

      // One document past the page proves there is more. The cursor is the last document the page returns: the
      // next read continues after it (`_id > cursor`), so the document that proved it is not skipped.
      const nextCursor = documents.length > limit ? items[items.length - 1]?._id as string | undefined : undefined;

      return {
        items,
        nextCursor,
      };
    }

    async listFileEntries(filters: {
      providerKey: string;
      bucketKey: string;
      projectId?: string;
      prefix: string;
      purpose?: FileListPurpose;
      limit?: number;
      cursor?: string;
    }): Promise<IFileEntriesPage> {
      const db = this.getTenantDb();
      const probe = async (range: KeyRange, limit: number): Promise<IFileRecord[]> => {
        const keyRange: Record<string, string> = {};
        if (range.gte !== undefined) keyRange.$gte = range.gte;
        if (range.gt !== undefined) keyRange.$gt = range.gt;
        if (range.lt !== undefined) keyRange.$lt = range.lt;
        const documents = await db
          .collection<IFileRecord>(COLLECTIONS.files)
          .find({
            providerKey: filters.providerKey,
            bucketKey: filters.bucketKey,
            ...(filters.projectId ? { projectId: filters.projectId } : {}),
            ...(Object.keys(keyRange).length > 0 ? { key: keyRange } : {}),
            ...this.filePurposeFilter(filters.purpose),
          })
          .sort({ key: 1 })
          .limit(limit)
          .toArray();
        return documents.map((record) => ({ ...record, _id: record._id?.toString() }));
      };
      return walkFileEntries(probe, {
        prefix: filters.prefix,
        limit: Math.min(Math.max(filters.limit ?? 50, 1), 200),
        cursor: filters.cursor,
      });
    }

    async listFileRecordsByConversation(conversationId: string): Promise<IFileRecord[]> {
      const db = this.getTenantDb();
      const documents = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .find({ conversationId })
        .sort({ createdAt: 1, _id: 1 })
        .toArray();
      return documents.map((record) => ({ ...record, _id: record._id?.toString() }));
    }

    async listExpiredConversationFiles(before: Date, limit: number): Promise<IFileRecord[]> {
      const db = this.getTenantDb();
      const documents = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .find({ purpose: 'conversation', expiresAt: { $lt: before } })
        .sort({ expiresAt: 1, createdAt: 1, _id: 1 })
        .limit(limit)
        .toArray();
      return documents.map((record) => ({ ...record, _id: record._id?.toString() }));
    }

    async countFileRecords(filters?: { projectId?: string }): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (filters?.projectId) {
        query.projectId = filters.projectId;
      }

      return db
        .collection<IFileRecord>(COLLECTIONS.files)
        .countDocuments(query);
    }

    async sumFileRecordBytes(filters?: { projectId?: string }): Promise<number> {
      const db = this.getTenantDb();
      const match: Record<string, unknown> = {};
      if (filters?.projectId) {
        match.projectId = filters.projectId;
      }

      const result = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              total: {
                $sum: {
                  $add: [
                    { $ifNull: ['$size', 0] },
                    { $ifNull: ['$markdownSize', 0] },
                  ],
                },
              },
            },
          },
        ])
        .toArray();

      const total = (result[0] as { total?: number } | undefined)?.total;
      return typeof total === 'number' ? total : 0;
    }

    async listFileBucketStats(filters?: {
      projectId?: string;
      buckets?: Array<{ providerKey: string; bucketKey: string }>;
    }): Promise<IFileBucketStats[]> {
      if (filters?.buckets && filters.buckets.length === 0) return [];
      const db = this.getTenantDb();
      const match: Record<string, unknown> = {};
      if (filters?.projectId) match.projectId = filters.projectId;
      // One equality pair per bucket: each branch is an index range on (providerKey, bucketKey, key).
      if (filters?.buckets) match.$or = filters.buckets.map((bucket) => ({ providerKey: bucket.providerKey, bucketKey: bucket.bucketKey }));

      const groups = await db
        .collection<IFileRecord>(COLLECTIONS.files)
        .aggregate<{ _id: { providerKey: string; bucketKey: string }; fileCount: number; totalBytes: number }>([
          { $match: match },
          {
            $group: {
              _id: { providerKey: '$providerKey', bucketKey: '$bucketKey' },
              fileCount: { $sum: 1 },
              totalBytes: { $sum: { $add: [{ $ifNull: ['$size', 0] }, { $ifNull: ['$markdownSize', 0] }] } },
            },
          },
        ])
        .toArray();

      return groups.map((group) => ({
        providerKey: group._id.providerKey,
        bucketKey: group._id.bucketKey,
        fileCount: group.fileCount,
        totalBytes: typeof group.totalBytes === 'number' ? group.totalBytes : 0,
      }));
    }

    // ── Vector counters ──────────────────────────────────────────────

    async getProjectVectorCountApprox(projectId: string): Promise<number> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.vectorCounters)
        .findOne({ projectId }, { projection: { count: 1 } });

      const count = (doc as { count?: number } | null)?.count;
      return typeof count === 'number' ? count : 0;
    }

    async incrementProjectVectorCountApprox(projectId: string, delta: number): Promise<number> {
      const db = this.getTenantDb();
      const now = new Date();
      const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;

      const result = await db
        .collection(COLLECTIONS.vectorCounters)
        .findOneAndUpdate(
          { projectId },
          [
            {
              $set: {
                projectId,
                updatedAt: now,
                createdAt: { $ifNull: ['$createdAt', now] },
                count: {
                  $max: [
                    0,
                    {
                      $add: [
                        { $ifNull: ['$count', 0] },
                        safeDelta,
                      ],
                    },
                  ],
                },
              },
            },
          ],
          { upsert: true, returnDocument: 'after' },
        );

      const count = (result as { count?: number } | null)?.count;
      return typeof count === 'number' ? count : 0;
    }

    // ── File buckets ─────────────────────────────────────────────────

    async createFileBucket(
      bucket: Omit<IFileBucketRecord, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IFileBucketRecord> {
      const db = this.getTenantDb();
      const now = new Date();
      const document: Omit<IFileBucketRecord, '_id'> & {
        createdAt: Date;
        updatedAt: Date;
      } = {
        ...bucket,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db
        .collection<IFileBucketRecord>(COLLECTIONS.fileBuckets)
        .insertOne(document as unknown as IFileBucketRecord);

      return {
        ...document,
        _id: result.insertedId.toString(),
      };
    }

    async updateFileBucket(
      id: string,
      data: Partial<Omit<IFileBucketRecord, 'tenantId' | 'key' | 'providerKey'>>,
    ): Promise<IFileBucketRecord | null> {
      const db = this.getTenantDb();
      const objectId = new ObjectId(id);

      const existing = await db
        .collection<IFileBucketRecord>(COLLECTIONS.fileBuckets)
        .findOne({ _id: objectId });

      if (!existing) {
        return null;
      }

      const payload: Partial<IFileBucketRecord> = {
        ...(data as Partial<IFileBucketRecord>),
        updatedAt: new Date(),
      };
      delete payload._id;
      delete payload.tenantId;
      delete payload.key;
      delete payload.providerKey;

      const result = await db
        .collection<IFileBucketRecord>(COLLECTIONS.fileBuckets)
        .findOneAndUpdate(
          { _id: objectId },
          { $set: payload },
          { returnDocument: 'after' },
        );

      if (!result) {
        return null;
      }

      return {
        ...result,
        _id: result._id?.toString(),
      };
    }

    async deleteFileBucket(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IFileBucketRecord>(COLLECTIONS.fileBuckets)
        .deleteOne({ _id: new ObjectId(id) });

      return result.deletedCount > 0;
    }

    async findFileBucketById(id: string): Promise<IFileBucketRecord | null> {
      const db = this.getTenantDb();
      const record = await db
        .collection<IFileBucketRecord>(COLLECTIONS.fileBuckets)
        .findOne({ _id: new ObjectId(id) });

      if (!record) {
        return null;
      }

      return {
        ...record,
        _id: record._id?.toString(),
      };
    }

    async findFileBucketByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<IFileBucketRecord | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId, key };
      if (projectId) {
        query.projectId = projectId;
      }
      const record = await db
        .collection<IFileBucketRecord>(COLLECTIONS.fileBuckets)
        .findOne(query);

      if (!record) {
        return null;
      }

      return {
        ...record,
        _id: record._id?.toString(),
      };
    }

    async listFileBuckets(tenantId: string, projectId?: string): Promise<IFileBucketRecord[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (projectId) {
        query.projectId = projectId;
      }
      const records = await db
        .collection<IFileBucketRecord>(COLLECTIONS.fileBuckets)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      return records.map((record) => ({
        ...record,
        _id: record._id?.toString(),
      }));
    }
  };
}
