/**
 * MongoDB Provider – Vector index operations mixin
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IVectorIndexRecord, IVectorQueryLog, IVectorQueryStats } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function VectorMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class VectorOps extends Base {
    async createVectorIndex(
      indexData: Omit<IVectorIndexRecord, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IVectorIndexRecord> {
      const db = this.getTenantDb();
      const now = new Date();

      const document: Omit<IVectorIndexRecord, '_id'> & {
        createdAt: Date;
        updatedAt: Date;
      } = {
        ...indexData,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
        .insertOne(document as unknown as IVectorIndexRecord);

      return {
        ...document,
        _id: result.insertedId.toString(),
      };
    }

    async updateVectorIndex(
      id: string,
      data: Partial<
        Omit<IVectorIndexRecord, 'tenantId' | 'providerKey' | 'key'>
      >,
    ): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      const objectId = new ObjectId(id);

      const existing = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
        .findOne({ _id: objectId });

      if (!existing) {
        return null;
      }

      const payload: Partial<IVectorIndexRecord> = {
        ...(data as Partial<IVectorIndexRecord>),
        updatedAt: new Date(),
      };
      delete payload._id;
      delete payload.tenantId;
      delete payload.providerKey;
      delete payload.key;

      const result = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
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

    async deleteVectorIndex(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
        .deleteOne({ _id: new ObjectId(id) });

      return result.deletedCount > 0;
    }

    async listVectorIndexes(filters?: {
      providerKey?: string;
      projectId?: string;
      search?: string;
    }): Promise<IVectorIndexRecord[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};

      if (filters?.projectId) {
        query.projectId = filters.projectId;
      }

      if (filters?.providerKey) {
        query.providerKey = filters.providerKey;
      }

      if (filters?.search) {
        const regex = new RegExp(filters.search, 'i');
        query.$or = [{ key: regex }, { name: regex }];
      }

      const indexes = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      return indexes.map((index) => ({
        ...index,
        _id: index._id?.toString(),
      }));
    }

    async findVectorIndexById(id: string): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      const index = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
        .findOne({ _id: new ObjectId(id) });

      if (!index) {
        return null;
      }

      return {
        ...index,
        _id: index._id?.toString(),
      };
    }

    async findVectorIndexByKey(
      providerKey: string,
      key: string,
      projectId?: string,
    ): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      const index = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
        .findOne({ providerKey, key, ...(projectId ? { projectId } : {}) } as Filter<IVectorIndexRecord>);

      if (!index) {
        return null;
      }

      return {
        ...index,
        _id: index._id?.toString(),
      };
    }

    async findVectorIndexByExternalId(
      providerKey: string,
      externalId: string,
      projectId?: string,
    ): Promise<IVectorIndexRecord | null> {
      const db = this.getTenantDb();
      const index = await db
        .collection<IVectorIndexRecord>(COLLECTIONS.vectorIndexes)
        .findOne({ providerKey, externalId, ...(projectId ? { projectId } : {}) } as Filter<IVectorIndexRecord>);

      if (!index) {
        return null;
      }

      return {
        ...index,
        _id: index._id?.toString(),
      };
    }

    async createVectorQueryLog(
      log: Omit<IVectorQueryLog, '_id'>,
    ): Promise<IVectorQueryLog> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.vectorQueryLogs)
        .insertOne({ ...log });
      return { ...log, _id: result.insertedId.toString() };
    }

    async aggregateVectorQueryStats(params: {
      indexKey: string;
      from: Date;
      to: Date;
    }): Promise<IVectorQueryStats> {
      const db = this.getTenantDb();
      const collection = db.collection(COLLECTIONS.vectorQueryLogs);
      const match = {
        indexKey: params.indexKey,
        timestamp: { $gte: params.from, $lte: params.to },
      };

      const [daily, totalsRaw, topKDist] = await Promise.all([
        collection.aggregate([
          { $match: match },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
              queryCount: { $sum: 1 },
              avgLatencyMs: { $avg: '$latencyMs' },
              avgScore: { $avg: '$avgScore' },
              filterCount: { $sum: { $cond: [{ $eq: ['$filterApplied', true] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ]).toArray(),

        collection.aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              totalQueries: { $sum: 1 },
              avgLatencyMs: { $avg: '$latencyMs' },
              avgScore: { $avg: '$avgScore' },
              minLatencyMs: { $min: '$latencyMs' },
              maxLatencyMs: { $max: '$latencyMs' },
            },
          },
        ]).toArray(),

        collection.aggregate([
          { $match: match },
          { $group: { _id: '$topK', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]).toArray(),
      ]);

      const totals = totalsRaw[0] ?? {};

      return {
        daily: daily.map((row) => ({
          date: row._id as string,
          queryCount: (row.queryCount as number | undefined) ?? 0,
          avgLatencyMs: (row.avgLatencyMs as number | undefined) ?? 0,
          avgScore: (row.avgScore as number | null | undefined) ?? null,
          filterCount: (row.filterCount as number | undefined) ?? 0,
        })),
        totals: {
          totalQueries: (totals.totalQueries as number | undefined) ?? 0,
          avgLatencyMs: (totals.avgLatencyMs as number | null | undefined) ?? null,
          avgScore: (totals.avgScore as number | null | undefined) ?? null,
          minLatencyMs: (totals.minLatencyMs as number | null | undefined) ?? null,
          maxLatencyMs: (totals.maxLatencyMs as number | null | undefined) ?? null,
        },
        topKDistribution: topKDist.map((row) => ({
          topK: (row._id as number | undefined) ?? 0,
          count: (row.count as number | undefined) ?? 0,
        })),
      };
    }
  };
}
