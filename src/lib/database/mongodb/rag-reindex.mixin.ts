/**
 * MongoDB Provider – RAG re-index run operations mixin
 *
 * Mirrors `sqlite/rag-reindex.mixin.ts` so a re-index resumes identically on
 * both backends. `key` is unique within a tenant database and is what the
 * queue payload carries — the record, not the queue, is the source of truth.
 */

import type { Filter } from 'mongodb';
import type { IRagReindexRun } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

/** Fields a caller may clear by passing an explicit `undefined`. */
const NULLABLE_FIELDS: readonly string[] = [
  'errorMessage',
  'startedAt',
  'completedAt',
  'progress',
  'claimedBy',
  'claimedAt',
  'heartbeatAt',
];

const IMMUTABLE_FIELDS: readonly string[] = ['_id', 'tenantId', 'key', 'createdBy'];

export function RagReindexMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RagReindexOps extends Base {
    async createRagReindexRun(
      run: Omit<IRagReindexRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagReindexRun> {
      const db = this.getTenantDb();
      const now = new Date();
      const document = { ...run, createdAt: now, updatedAt: now };

      const result = await db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .insertOne(document as unknown as IRagReindexRun);

      return { ...document, _id: result.insertedId.toString() };
    }

    async updateRagReindexRun(
      key: string,
      data: Partial<Omit<IRagReindexRun, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRagReindexRun | null> {
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { updatedAt: new Date() };
      const unset: Record<string, ''> = {};

      for (const [field, value] of Object.entries(data)) {
        if (IMMUTABLE_FIELDS.includes(field)) continue;
        if (value === undefined) {
          if (NULLABLE_FIELDS.includes(field)) unset[field] = '';
          continue;
        }
        set[field] = value;
      }

      const result = await db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .findOneAndUpdate(
          { key } as Filter<IRagReindexRun>,
          Object.keys(unset).length > 0 ? { $set: set, $unset: unset } : { $set: set },
          { returnDocument: 'after' },
        );

      return result ? { ...result, _id: result._id?.toString() } : null;
    }

    async findRagReindexRunByKey(key: string): Promise<IRagReindexRun | null> {
      const db = this.getTenantDb();
      const run = await db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .findOne({ key } as Filter<IRagReindexRun>);

      return run ? { ...run, _id: run._id?.toString() } : null;
    }

    async listRagReindexRuns(filters?: {
      ragModuleKey?: string;
      projectId?: string;
      statuses?: IRagReindexRun['status'][];
      limit?: number;
    }): Promise<IRagReindexRun[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};

      if (filters?.ragModuleKey) query.ragModuleKey = filters.ragModuleKey;
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.statuses && filters.statuses.length > 0) {
        query.status = { $in: filters.statuses };
      }

      const cursor = db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .find(query as Filter<IRagReindexRun>)
        .sort({ createdAt: -1 });
      if (filters?.limit) cursor.limit(filters.limit);

      const runs = await cursor.toArray();
      return runs.map((run) => ({ ...run, _id: run._id?.toString() }));
    }

    /**
     * One `findOneAndUpdate`, so two replicas racing the same run cannot both
     * win: the filter is evaluated and the write applied under a single
     * document lock. A run whose owner has stopped heart-beating is reclaimable,
     * which is what lets a SIGKILLed pod's run continue elsewhere.
     */
    async claimRagReindexRun(
      key: string,
      ownerId: string,
      staleBefore: Date,
    ): Promise<IRagReindexRun | null> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = await db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .findOneAndUpdate(
          {
            key,
            status: { $in: ['pending', 'queued', 'running'] },
            $or: [
              { claimedBy: { $exists: false } },
              { claimedBy: null },
              { claimedBy: ownerId },
              { heartbeatAt: { $exists: false } },
              { heartbeatAt: null },
              { heartbeatAt: { $lt: staleBefore } },
            ],
          } as Filter<IRagReindexRun>,
          {
            $set: {
              status: 'running',
              claimedBy: ownerId,
              claimedAt: now,
              heartbeatAt: now,
              updatedAt: now,
            },
          },
          { returnDocument: 'after' },
        );
      return doc ? ({ ...doc, _id: doc._id?.toString() } as IRagReindexRun) : null;
    }

    async touchRagReindexRunClaim(key: string, ownerId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const now = new Date();
      const result = await db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .updateOne(
          { key, claimedBy: ownerId, status: 'running' } as Filter<IRagReindexRun>,
          { $set: { heartbeatAt: now, updatedAt: now } },
        );
      return result.matchedCount > 0;
    }

    async releaseRagReindexRunClaim(key: string, ownerId: string): Promise<void> {
      const db = this.getTenantDb();
      await db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .updateOne(
          { key, claimedBy: ownerId } as Filter<IRagReindexRun>,
          { $unset: { claimedBy: '', claimedAt: '', heartbeatAt: '' }, $set: { updatedAt: new Date() } },
        );
    }

    async deleteRagReindexRun(key: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IRagReindexRun>(COLLECTIONS.ragReindexRuns)
        .deleteOne({ key } as Filter<IRagReindexRun>);

      return result.deletedCount > 0;
    }
  };
}
