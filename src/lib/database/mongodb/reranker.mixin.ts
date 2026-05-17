/**
 * MongoDB Provider – Reranker operations mixin
 */

import { ObjectId, type Filter } from 'mongodb';
import type {
  IReranker,
  IRerankerRunLog,
  RerankerStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function RerankerMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RerankerOps extends Base {
    async createReranker(
      reranker: Omit<IReranker, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IReranker> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...reranker, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.rerankers)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IReranker;
    }

    async updateReranker(
      id: string,
      data: Partial<Omit<IReranker, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IReranker | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IReranker>(COLLECTIONS.rerankers)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IReranker;
    }

    async deleteReranker(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.rerankers)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    }

    async findRerankerById(id: string): Promise<IReranker | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IReranker>(COLLECTIONS.rerankers)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IReranker;
    }

    async findRerankerByKey(key: string, projectId?: string): Promise<IReranker | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) {
        Object.assign(filter, this.buildProjectScopeFilter(projectId));
      }
      const doc = await db
        .collection<IReranker>(COLLECTIONS.rerankers)
        .findOne(filter as Filter<IReranker>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IReranker;
    }

    async listRerankers(filters?: {
      projectId?: string;
      status?: RerankerStatus;
      search?: string;
    }): Promise<IReranker[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) {
        Object.assign(query, this.buildProjectScopeFilter(filters.projectId));
      }
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.$or = [
          { name: { $regex: this.escapeRegex(filters.search), $options: 'i' } },
          { key: { $regex: this.escapeRegex(filters.search), $options: 'i' } },
        ];
      }
      const docs = await db
        .collection<IReranker>(COLLECTIONS.rerankers)
        .find(query as Filter<IReranker>)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IReranker);
    }

    // ── Run logs ──────────────────────────────────────────────────────

    async createRerankerRunLog(
      log: Omit<IRerankerRunLog, '_id' | 'createdAt'>,
    ): Promise<IRerankerRunLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.rerankerRunLogs)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IRerankerRunLog;
    }

    async listRerankerRunLogs(
      rerankerKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IRerankerRunLog[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { rerankerKey };
      if (options?.from || options?.to) {
        const dateFilter: Record<string, Date> = {};
        if (options.from) dateFilter.$gte = options.from;
        if (options.to) dateFilter.$lte = options.to;
        query.createdAt = dateFilter;
      }
      const cursor = db
        .collection<IRerankerRunLog>(COLLECTIONS.rerankerRunLogs)
        .find(query as Filter<IRerankerRunLog>)
        .sort({ createdAt: -1 });
      if (options?.skip) cursor.skip(options.skip);
      cursor.limit(options?.limit ?? 50);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IRerankerRunLog);
    }
  };
}
