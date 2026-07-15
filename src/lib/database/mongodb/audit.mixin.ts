/**
 * MongoDB Provider – General audit log operations mixin
 */

import type { Filter } from 'mongodb';
import type { IAuditLog } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function AuditMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AuditOps extends Base {
    async createAuditLog(log: Omit<IAuditLog, '_id' | 'createdAt'>): Promise<IAuditLog> {
      const db = this.getTenantDb();
      const record = { ...log, createdAt: new Date() };
      const result = await db.collection(COLLECTIONS.auditLogs).insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IAuditLog;
    }

    async listAuditLogs(filters: {
      actorUserId?: string;
      outcome?: IAuditLog['outcome'];
      service?: string;
      action?: string;
      method?: string;
      q?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      skip?: number;
    } = {}): Promise<IAuditLog[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (filters.actorUserId) query.actorUserId = filters.actorUserId;
      if (filters.outcome) query.outcome = filters.outcome;
      if (filters.service) query.service = filters.service;
      if (filters.action) query.action = filters.action;
      if (filters.method) query.method = filters.method;
      if (filters.q) {
        const escaped = filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = { $regex: escaped, $options: 'i' };
        query.$or = [{ event: rx }, { path: rx }, { actorEmail: rx }];
      }
      if (filters.from || filters.to) {
        const createdAt: Record<string, Date> = {};
        if (filters.from) createdAt.$gte = filters.from;
        if (filters.to) createdAt.$lte = filters.to;
        query.createdAt = createdAt;
      }

      const cursor = db
        .collection<IAuditLog>(COLLECTIONS.auditLogs)
        .find(query as Filter<IAuditLog>)
        .sort({ createdAt: -1 });

      cursor.skip(Math.max(filters.skip ?? 0, 0));
      cursor.limit(Math.min(Math.max(filters.limit ?? 100, 1), 500));

      const docs = await cursor.toArray();
      return docs.map((doc) => ({ ...doc, _id: doc._id?.toString() }) as IAuditLog);
    }
  };
}
