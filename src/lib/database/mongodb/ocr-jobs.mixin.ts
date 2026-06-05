/**
 * MongoDB Provider – OCR jobs & job items mixin
 */

import { ObjectId } from 'mongodb';
import type { IOcrJob, IOcrJobItem, OcrJobAggregateDelta } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

function toId(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

function objectId(id: string): ObjectId {
  return new ObjectId(id);
}

export function OcrJobMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class OcrJobOps extends Base {
    // ── OCR jobs ─────────────────────────────────────────────────────
    async createOcrJob(
      record: Omit<IOcrJob, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IOcrJob> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<IOcrJob, '_id'> = { ...record, createdAt: now, updatedAt: now };
      const result = await db
        .collection<IOcrJob>(COLLECTIONS.ocrJobs)
        .insertOne(doc as unknown as IOcrJob);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateOcrJob(
      id: string,
      data: Partial<Omit<IOcrJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IOcrJob | null> {
      const db = this.getTenantDb();
      const payload: Partial<IOcrJob> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<IOcrJob>(COLLECTIONS.ocrJobs)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IOcrJob;
    }

    async findOcrJobById(id: string): Promise<IOcrJob | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IOcrJob>(COLLECTIONS.ocrJobs)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IOcrJob;
      } catch {
        return null;
      }
    }

    async listOcrJobs(
      tenantId: string,
      filters?: { projectId?: string; status?: string; limit?: number },
    ): Promise<IOcrJob[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      const cursor = db
        .collection<IOcrJob>(COLLECTIONS.ocrJobs)
        .find(query)
        .sort({ createdAt: -1 });
      if (filters?.limit && filters.limit > 0) cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IOcrJob);
    }

    async deleteOcrJob(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      await db.collection<IOcrJobItem>(COLLECTIONS.ocrJobItems).deleteMany({ jobId: id });
      const result = await db
        .collection<IOcrJob>(COLLECTIONS.ocrJobs)
        .deleteOne({ _id: objectId(id) });
      return result.deletedCount > 0;
    }

    async incrementOcrJobAggregates(
      id: string,
      delta: OcrJobAggregateDelta,
      extra?: { costCurrency?: string; lastItemAt?: Date },
    ): Promise<IOcrJob | null> {
      const db = this.getTenantDb();
      const inc: Record<string, number> = {};
      for (const [k, v] of Object.entries(delta)) {
        if (typeof v === 'number' && v !== 0) inc[k] = v;
      }
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (extra?.costCurrency) set.costCurrency = extra.costCurrency;
      if (extra?.lastItemAt) set.lastItemAt = extra.lastItemAt;
      const update: Record<string, unknown> = { $set: set };
      if (Object.keys(inc).length > 0) update.$inc = inc;
      const result = await db
        .collection<IOcrJob>(COLLECTIONS.ocrJobs)
        .findOneAndUpdate({ _id: objectId(id) }, update, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IOcrJob;
    }

    // ── OCR job items ────────────────────────────────────────────────
    async createOcrJobItem(
      record: Omit<IOcrJobItem, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IOcrJobItem> {
      const [created] = await this.createOcrJobItems([record]);
      return created;
    }

    async findOcrJobItemById(id: string): Promise<IOcrJobItem | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IOcrJobItem>(COLLECTIONS.ocrJobItems)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IOcrJobItem;
      } catch {
        return null;
      }
    }

    async createOcrJobItems(
      records: Array<Omit<IOcrJobItem, '_id' | 'createdAt' | 'updatedAt'>>,
    ): Promise<IOcrJobItem[]> {
      const db = this.getTenantDb();
      if (records.length === 0) return [];
      const now = new Date();
      const docs = records.map((r) => ({ ...r, createdAt: now, updatedAt: now }));
      const result = await db
        .collection<IOcrJobItem>(COLLECTIONS.ocrJobItems)
        .insertMany(docs as unknown as IOcrJobItem[]);
      return docs.map((doc, i) => ({
        ...doc,
        _id: result.insertedIds[i]?.toString(),
      })) as IOcrJobItem[];
    }

    async updateOcrJobItem(
      id: string,
      data: Partial<Omit<IOcrJobItem, '_id' | 'tenantId' | 'jobId' | 'createdAt'>>,
    ): Promise<IOcrJobItem | null> {
      const db = this.getTenantDb();
      const payload: Partial<IOcrJobItem> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.jobId;
      delete payload.createdAt;
      const result = await db
        .collection<IOcrJobItem>(COLLECTIONS.ocrJobItems)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IOcrJobItem;
    }

    async listOcrJobItems(
      jobId: string,
      options?: { limit?: number; skip?: number; status?: string },
    ): Promise<IOcrJobItem[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { jobId };
      if (options?.status) query.status = options.status;
      const cursor = db
        .collection<IOcrJobItem>(COLLECTIONS.ocrJobItems)
        .find(query)
        .sort({ index: 1 });
      if (options?.skip) cursor.skip(options.skip);
      if (options?.limit) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IOcrJobItem);
    }
  };
}
