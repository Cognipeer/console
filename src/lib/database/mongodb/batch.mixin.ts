/**
 * MongoDB Provider – Batch API (jobs + per-request items) mixin
 */

import { ObjectId } from 'mongodb';
import type { IBatchJob, IBatchJobItem, BatchJobAggregateDelta } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

function toId(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

function objectId(id: string): ObjectId {
  return new ObjectId(id);
}

export function BatchJobMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class BatchJobOps extends Base {
    // ── Batch jobs ───────────────────────────────────────────────────
    async createBatchJob(
      record: Omit<IBatchJob, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBatchJob> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<IBatchJob, '_id'> = { ...record, createdAt: now, updatedAt: now };
      const result = await db
        .collection<IBatchJob>(COLLECTIONS.batchJobs)
        .insertOne(doc as unknown as IBatchJob);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateBatchJob(
      id: string,
      data: Partial<Omit<IBatchJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBatchJob | null> {
      const db = this.getTenantDb();
      const payload: Partial<IBatchJob> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.createdAt;
      const result = await db
        .collection<IBatchJob>(COLLECTIONS.batchJobs)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IBatchJob;
    }

    async incrementBatchJobAggregates(
      id: string,
      delta: BatchJobAggregateDelta,
    ): Promise<IBatchJob | null> {
      const db = this.getTenantDb();
      const inc: Record<string, number> = {};
      for (const [k, v] of Object.entries(delta)) {
        if (typeof v === 'number' && v !== 0) inc[k] = v;
      }
      const update: Record<string, unknown> = { $set: { updatedAt: new Date() } };
      if (Object.keys(inc).length > 0) update.$inc = inc;
      const result = await db
        .collection<IBatchJob>(COLLECTIONS.batchJobs)
        .findOneAndUpdate({ _id: objectId(id) }, update, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IBatchJob;
    }

    async findBatchJobById(id: string): Promise<IBatchJob | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IBatchJob>(COLLECTIONS.batchJobs)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IBatchJob;
      } catch {
        return null;
      }
    }

    async listBatchJobs(
      tenantId: string,
      filters?: { projectId?: string; status?: string; limit?: number },
    ): Promise<IBatchJob[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      const cursor = db
        .collection<IBatchJob>(COLLECTIONS.batchJobs)
        .find(query)
        .sort({ createdAt: -1 });
      if (filters?.limit && filters.limit > 0) cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IBatchJob);
    }

    async deleteBatchJob(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      await db.collection<IBatchJobItem>(COLLECTIONS.batchJobItems).deleteMany({ batchId: id });
      const result = await db
        .collection<IBatchJob>(COLLECTIONS.batchJobs)
        .deleteOne({ _id: objectId(id) });
      return result.deletedCount > 0;
    }

    // ── Batch job items ──────────────────────────────────────────────
    async createBatchJobItems(
      records: Array<Omit<IBatchJobItem, '_id' | 'createdAt' | 'updatedAt'>>,
    ): Promise<IBatchJobItem[]> {
      const db = this.getTenantDb();
      if (records.length === 0) return [];
      const now = new Date();
      const docs = records.map((r) => ({ ...r, createdAt: now, updatedAt: now }));
      const result = await db
        .collection<IBatchJobItem>(COLLECTIONS.batchJobItems)
        .insertMany(docs as unknown as IBatchJobItem[]);
      return docs.map((doc, i) => ({
        ...doc,
        _id: result.insertedIds[i]?.toString(),
      })) as IBatchJobItem[];
    }

    async updateBatchJobItem(
      id: string,
      data: Partial<Omit<IBatchJobItem, '_id' | 'tenantId' | 'batchId' | 'createdAt'>>,
    ): Promise<IBatchJobItem | null> {
      const db = this.getTenantDb();
      const payload: Partial<IBatchJobItem> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.batchId;
      delete payload.createdAt;
      const result = await db
        .collection<IBatchJobItem>(COLLECTIONS.batchJobItems)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: toId(result._id) } as IBatchJobItem;
    }

    async findBatchJobItemById(id: string): Promise<IBatchJobItem | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IBatchJobItem>(COLLECTIONS.batchJobItems)
          .findOne({ _id: objectId(id) });
        if (!record) return null;
        return { ...record, _id: toId(record._id) } as IBatchJobItem;
      } catch {
        return null;
      }
    }

    async listBatchJobItems(
      batchId: string,
      options?: { limit?: number; skip?: number; status?: string },
    ): Promise<IBatchJobItem[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { batchId };
      if (options?.status) query.status = options.status;
      const cursor = db
        .collection<IBatchJobItem>(COLLECTIONS.batchJobItems)
        .find(query)
        .sort({ index: 1 });
      if (options?.skip) cursor.skip(options.skip);
      if (options?.limit) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: toId(d._id) }) as IBatchJobItem);
    }
  };
}
