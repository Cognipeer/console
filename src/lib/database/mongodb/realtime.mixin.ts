/**
 * MongoDB Provider – Realtime (named models + session logs) mixin
 */

import { ObjectId } from 'mongodb';
import type { IRealtimeModel, IRealtimeSessionLog, RealtimeSessionLogDelta } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

function toId(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

function objectId(id: string): ObjectId {
  return new ObjectId(id);
}

export function RealtimeMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RealtimeOps extends Base {
    // ── Realtime models ──────────────────────────────────────────────
    async createRealtimeModel(
      record: Omit<IRealtimeModel, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRealtimeModel> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<IRealtimeModel, '_id'> = { ...record, createdAt: now, updatedAt: now };
      const result = await db
        .collection<IRealtimeModel>(COLLECTIONS.realtimeModels)
        .insertOne(doc as unknown as IRealtimeModel);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateRealtimeModel(
      id: string,
      data: Partial<Omit<IRealtimeModel, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IRealtimeModel | null> {
      const db = this.getTenantDb();
      const payload: Partial<IRealtimeModel> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<IRealtimeModel>(COLLECTIONS.realtimeModels)
        .findOneAndUpdate({ _id: objectId(id) }, { $set: payload }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IRealtimeModel;
    }

    async findRealtimeModelById(id: string): Promise<IRealtimeModel | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IRealtimeModel>(COLLECTIONS.realtimeModels)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IRealtimeModel;
      } catch {
        return null;
      }
    }

    async findRealtimeModelByKey(key: string, projectId?: string): Promise<IRealtimeModel | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { key };
      if (projectId) {
        query.$or = [{ projectId }, { projectId: { $exists: false } }, { projectId: null }];
      }
      const record = await db
        .collection<IRealtimeModel>(COLLECTIONS.realtimeModels)
        .findOne(query, { sort: { projectId: -1 } });
      if (!record) return null;
      return { ...record, _id: toId(record._id) } as IRealtimeModel;
    }

    async listRealtimeModels(
      tenantId: string,
      filters?: { projectId?: string; status?: string; limit?: number },
    ): Promise<IRealtimeModel[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      const cursor = db
        .collection<IRealtimeModel>(COLLECTIONS.realtimeModels)
        .find(query)
        .sort({ createdAt: -1 });
      if (filters?.limit && filters.limit > 0) cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IRealtimeModel);
    }

    async deleteRealtimeModel(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IRealtimeModel>(COLLECTIONS.realtimeModels)
        .deleteOne({ _id: objectId(id) });
      return result.deletedCount > 0;
    }

    // ── Realtime session logs ────────────────────────────────────────
    async createRealtimeSessionLog(
      record: Omit<IRealtimeSessionLog, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRealtimeSessionLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<IRealtimeSessionLog, '_id'> = { ...record, createdAt: now, updatedAt: now };
      const result = await db
        .collection<IRealtimeSessionLog>(COLLECTIONS.realtimeSessions)
        .insertOne(doc as unknown as IRealtimeSessionLog);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateRealtimeSessionLog(
      id: string,
      data: Partial<Omit<IRealtimeSessionLog, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IRealtimeSessionLog | null> {
      const db = this.getTenantDb();
      const payload: Partial<IRealtimeSessionLog> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<IRealtimeSessionLog>(COLLECTIONS.realtimeSessions)
        .findOneAndUpdate({ _id: objectId(id) }, { $set: payload }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IRealtimeSessionLog;
    }

    async incrementRealtimeSessionLog(
      id: string,
      delta: RealtimeSessionLogDelta,
    ): Promise<IRealtimeSessionLog | null> {
      const db = this.getTenantDb();
      const inc: Record<string, number> = {};
      for (const [k, v] of Object.entries(delta)) {
        if (typeof v === 'number' && v !== 0) inc[k] = v;
      }
      const update: Record<string, unknown> = { $set: { updatedAt: new Date() } };
      if (Object.keys(inc).length > 0) update.$inc = inc;
      const result = await db
        .collection<IRealtimeSessionLog>(COLLECTIONS.realtimeSessions)
        .findOneAndUpdate({ _id: objectId(id) }, update, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IRealtimeSessionLog;
    }

    async listRealtimeSessionLogs(
      tenantId: string,
      filters?: {
        projectId?: string;
        realtimeModelKey?: string;
        transport?: string;
        status?: string;
        from?: Date;
        to?: Date;
        limit?: number;
        skip?: number;
      },
    ): Promise<IRealtimeSessionLog[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.realtimeModelKey) query.realtimeModelKey = filters.realtimeModelKey;
      if (filters?.transport) query.transport = filters.transport;
      if (filters?.status) query.status = filters.status;
      if (filters?.from || filters?.to) {
        const range: Record<string, Date> = {};
        if (filters.from) range.$gte = new Date(filters.from);
        if (filters.to) range.$lte = new Date(filters.to);
        query.startedAt = range;
      }
      const cursor = db
        .collection<IRealtimeSessionLog>(COLLECTIONS.realtimeSessions)
        .find(query)
        .sort({ startedAt: -1 });
      if (filters?.skip) cursor.skip(filters.skip);
      if (filters?.limit) cursor.limit(Math.min(filters.limit, 1000));
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IRealtimeSessionLog);
    }
  };
}
