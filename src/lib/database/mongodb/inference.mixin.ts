/**
 * MongoDB Provider – Inference server operations mixin
 *
 * Includes inference servers and inference server metrics.
 */

import { ObjectId } from 'mongodb';
import type { IInferenceServer, IInferenceServerMetrics } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function InferenceMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class InferenceOps extends Base {
    // ── Inference server CRUD ────────────────────────────────────────

    async createInferenceServer(
      server: Omit<IInferenceServer, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IInferenceServer> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...server, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.inferenceServers)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId };
    }

    async updateInferenceServer(
      id: string,
      data: Partial<Omit<IInferenceServer, 'tenantId' | 'key'>>,
    ): Promise<IInferenceServer | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.inferenceServers)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      return result as unknown as IInferenceServer | null;
    }

    async deleteInferenceServer(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.inferenceServers)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount > 0;
    }

    async findInferenceServerById(id: string): Promise<IInferenceServer | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.inferenceServers)
        .findOne({ _id: new ObjectId(id) });
      return doc as unknown as IInferenceServer | null;
    }

    async findInferenceServerByKey(
      tenantId: string,
      key: string,
    ): Promise<IInferenceServer | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.inferenceServers)
        .findOne({ tenantId, key });
      return doc as unknown as IInferenceServer | null;
    }

    async listInferenceServers(tenantId: string): Promise<IInferenceServer[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.inferenceServers)
        .find({ tenantId })
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as IInferenceServer[];
    }

    // ── Inference server metrics ─────────────────────────────────────

    async createInferenceServerMetrics(
      metrics: Omit<IInferenceServerMetrics, '_id' | 'createdAt'>,
    ): Promise<IInferenceServerMetrics> {
      const db = this.getTenantDb();
      const doc = { ...metrics, createdAt: new Date() };
      const result = await db
        .collection(COLLECTIONS.inferenceServerMetrics)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId };
    }

    async listInferenceServerMetrics(
      serverKey: string,
      options?: { from?: Date; to?: Date; limit?: number },
    ): Promise<IInferenceServerMetrics[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { serverKey };
      if (options?.from || options?.to) {
        const tsFilter: Record<string, Date> = {};
        if (options.from) tsFilter.$gte = options.from;
        if (options.to) tsFilter.$lte = options.to;
        filter.timestamp = tsFilter;
      }
      const cursor = db
        .collection(COLLECTIONS.inferenceServerMetrics)
        .find(filter)
        .sort({ timestamp: -1 });
      if (options?.limit) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs as unknown as IInferenceServerMetrics[];
    }

    async deleteInferenceServerMetrics(serverKey: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.inferenceServerMetrics)
        .deleteMany({ serverKey });
      return result.deletedCount;
    }
  };
}
