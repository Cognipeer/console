/**
 * MongoDB Provider – File operations mixin
 *
 * Includes file records, file buckets, and vector counters.
 */

import { ObjectId, type Db } from 'mongodb';
import type { IFileRecord, IFileBucketRecord, IFileEntriesPage, FileListPurpose } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';
import { keyPrefixUpperBound, walkFileEntries, type KeyRange } from '../fileEntryWalk';

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

    async updateFileRecord(
      id: string,
      data: Partial<
        Omit<IFileRecord, 'tenantId' | 'providerKey' | 'bucketKey' | 'key' | 'createdBy'>
      >,
    ): Promise<IFileRecord | null> {
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

    /** `purpose` as a filter: session files, or everything that is not one (a missing field counts as "other"). */
    protected filePurposeFilter(purpose: FileListPurpose | undefined): Record<string, unknown> {
      if (purpose === 'conversation') return { purpose: 'conversation' };
      if (purpose === 'other') return { purpose: { $ne: 'conversation' } };
      return {};
    }

    async listFileRecords(filters: {
      providerKey: string;
      bucketKey: string;
      projectId?: string;
      search?: string;
      prefix?: string;
      purpose?: FileListPurpose;
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

      if (filters.search) {
        const regex = new RegExp(this.escapeRegex(filters.search), 'i');
        conditions.push({ $or: [{ key: regex }, { name: regex }] });
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

      const next = documents.length > limit ? documents[limit] : undefined;
      const nextCursor = next?._id ? next._id.toString() : undefined;

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
