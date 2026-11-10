/**
 * MongoDB Provider – Web Search operations mixin
 *
 * Web Search instances are stored as websearch-domain provider records; this
 * mixin only persists their per-instance run logs.
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IWebSearchInstance, IWebSearchRunLog } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function WebSearchMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class WebSearchOps extends Base {
    async createWebSearchInstance(
      instance: Omit<IWebSearchInstance, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IWebSearchInstance> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...instance, projectId: instance.projectId ?? null, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.websearchInstances).insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IWebSearchInstance;
    }

    async updateWebSearchInstance(
      id: string,
      data: Partial<Omit<IWebSearchInstance, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt'>>,
    ): Promise<IWebSearchInstance | null> {
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete set._id;
      if ('projectId' in set) set.projectId = set.projectId ?? null;
      const result = await db
        .collection<IWebSearchInstance>(COLLECTIONS.websearchInstances)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: set }, { returnDocument: 'after' });
      return result ? ({ ...result, _id: result._id?.toString() } as IWebSearchInstance) : null;
    }

    async deleteWebSearchInstance(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.websearchInstances)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    }

    async findWebSearchInstanceByKey(tenantId: string, key: string): Promise<IWebSearchInstance | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IWebSearchInstance>(COLLECTIONS.websearchInstances)
        .findOne({ tenantId, key } as Filter<IWebSearchInstance>);
      return doc ? ({ ...doc, _id: doc._id?.toString() } as IWebSearchInstance) : null;
    }

    async listWebSearchInstances(
      tenantId: string,
      filters?: { providerKey?: string },
    ): Promise<IWebSearchInstance[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.providerKey) query.providerKey = filters.providerKey;
      const docs = await db
        .collection<IWebSearchInstance>(COLLECTIONS.websearchInstances)
        .find(query as Filter<IWebSearchInstance>)
        .sort({ key: 1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IWebSearchInstance);
    }

    async createWebSearchRunLog(
      log: Omit<IWebSearchRunLog, '_id' | 'createdAt'>,
    ): Promise<IWebSearchRunLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.websearchRunLogs)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IWebSearchRunLog;
    }

    async listWebSearchRunLogs(
      searchKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IWebSearchRunLog[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { searchKey };
      if (options?.from || options?.to) {
        const dateFilter: Record<string, Date> = {};
        if (options.from) dateFilter.$gte = options.from;
        if (options.to) dateFilter.$lte = options.to;
        query.createdAt = dateFilter;
      }
      const cursor = db
        .collection<IWebSearchRunLog>(COLLECTIONS.websearchRunLogs)
        .find(query as Filter<IWebSearchRunLog>)
        .sort({ createdAt: -1 });
      if (options?.skip) cursor.skip(options.skip);
      cursor.limit(options?.limit ?? 50);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IWebSearchRunLog);
    }
  };
}
