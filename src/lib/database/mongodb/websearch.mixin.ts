/**
 * MongoDB Provider – Web Search operations mixin
 *
 * Web Search instances are stored as websearch-domain provider records; this
 * mixin only persists their per-instance run logs.
 */

import { type Filter } from 'mongodb';
import type { IWebSearchRunLog } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function WebSearchMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class WebSearchOps extends Base {
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
