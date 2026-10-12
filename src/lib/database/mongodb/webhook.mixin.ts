/**
 * MongoDB Provider – Webhook subscriptions mixin
 *
 * Endpoints (`webhook_endpoints`) and the deliveries owed to them
 * (`webhook_deliveries`). Ids are `whk_…` / `whd_…` strings. Indexes come from
 * `indexManifest.ts` (applied when the tenant DB is bound).
 */

import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type {
  IWebhookDelivery,
  IWebhookEndpoint,
  WebhookDeliveryStatus,
  WebhookEndpointStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

const toEndpoint = (doc: Record<string, unknown>): IWebhookEndpoint => ({ ...doc, _id: String(doc._id) }) as unknown as IWebhookEndpoint;
const toDelivery = (doc: Record<string, unknown>): IWebhookDelivery => ({ ...doc, _id: String(doc._id) }) as unknown as IWebhookDelivery;

export function WebhookMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class WebhookOps extends Base {
    /** Per-process memo: the delivery indexes are ensured on the first write per tenant DB. */
    private webhookIndexesReady = new Set<string>();

    /**
     * Ensured on the write path as well as in the boot manifest: the manifest
     * is existence-guarded, so a collection created after the tenant's first
     * bind would be swept by `(status, nextAttemptAt)` unindexed until a
     * restart. Names/keys are IDENTICAL to the manifest's.
     */
    private async ensureWebhookIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.webhookIndexesReady.has(dbName)) return;
      const coll = db.collection(COLLECTIONS.webhookDeliveries);
      await Promise.all([
        db.collection(COLLECTIONS.webhookEndpoints).createIndex({ tenantId: 1, projectId: 1 }, { name: 'idx_tenant_project' }),
        coll.createIndex({ status: 1, nextAttemptAt: 1 }, { name: 'idx_status_nextAttemptAt' }),
        coll.createIndex({ endpointId: 1, createdAt: -1 }, { name: 'idx_endpoint_createdAt' }),
        coll.createIndex({ tenantId: 1, eventId: 1 }, { name: 'idx_tenant_eventId' }),
        coll.createIndex({ status: 1, createdAt: 1 }, { name: 'idx_status_createdAt' }),
      ]);
      this.webhookIndexesReady.add(dbName);
    }

    // ── Endpoints ────────────────────────────────────────────────

    async createWebhookEndpoint(
      endpoint: Omit<IWebhookEndpoint, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IWebhookEndpoint> {
      const db = this.getTenantDb();
      await this.ensureWebhookIndexes(db).catch(() => undefined);
      const now = new Date();
      const doc = { ...endpoint, projectId: endpoint.projectId ?? null, _id: newId('whk'), createdAt: now, updatedAt: now };
      await db.collection(COLLECTIONS.webhookEndpoints).insertOne(doc as never);
      return doc as unknown as IWebhookEndpoint;
    }

    async findWebhookEndpointById(id: string): Promise<IWebhookEndpoint | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.webhookEndpoints).findOne({ _id: id as never });
      return doc ? toEndpoint(doc) : null;
    }

    async listWebhookEndpoints(
      tenantId: string,
      filter?: { projectScopes?: Array<string | null>; status?: WebhookEndpointStatus },
    ): Promise<IWebhookEndpoint[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filter?.status) query.status = filter.status;
      if (filter?.projectScopes) {
        if (filter.projectScopes.length === 0) return [];
        // `null` also matches a document that never had the field.
        query.projectId = { $in: filter.projectScopes };
      }
      const docs = await db.collection(COLLECTIONS.webhookEndpoints).find(query).sort({ createdAt: 1 }).toArray();
      return docs.map(toEndpoint);
    }

    async updateWebhookEndpoint(
      id: string,
      data: Partial<Omit<IWebhookEndpoint, '_id' | 'tenantId' | 'projectId' | 'createdBy' | 'createdAt'>>,
    ): Promise<IWebhookEndpoint | null> {
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete set._id;
      const doc = await db.collection(COLLECTIONS.webhookEndpoints).findOneAndUpdate(
        { _id: id as never },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? toEndpoint(doc) : null;
    }

    async deleteWebhookEndpoint(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.webhookDeliveries).deleteMany({ endpointId: id });
      const result = await db.collection(COLLECTIONS.webhookEndpoints).deleteOne({ _id: id as never });
      return result.deletedCount > 0;
    }

    // ── Deliveries ───────────────────────────────────────────────

    async createWebhookDeliveries(
      deliveries: Array<Omit<IWebhookDelivery, '_id'>>,
    ): Promise<IWebhookDelivery[]> {
      if (deliveries.length === 0) return [];
      const db = this.getTenantDb();
      await this.ensureWebhookIndexes(db).catch(() => undefined);
      const docs = deliveries.map((delivery) => ({ ...delivery, projectId: delivery.projectId ?? null, _id: newId('whd') }));
      await db.collection(COLLECTIONS.webhookDeliveries).insertMany(docs as never[]);
      return docs as unknown as IWebhookDelivery[];
    }

    async findWebhookDeliveryById(id: string): Promise<IWebhookDelivery | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.webhookDeliveries).findOne({ _id: id as never });
      return doc ? toDelivery(doc) : null;
    }

    async listWebhookDeliveries(
      endpointId: string,
      options?: { limit?: number; skip?: number; status?: WebhookDeliveryStatus },
    ): Promise<IWebhookDelivery[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { endpointId };
      if (options?.status) query.status = options.status;
      let cursor = db.collection(COLLECTIONS.webhookDeliveries).find(query).sort({ createdAt: -1 });
      if (options?.skip) cursor = cursor.skip(options.skip);
      if (options?.limit) cursor = cursor.limit(options.limit);
      return (await cursor.toArray()).map(toDelivery);
    }

    async updateWebhookDelivery(
      id: string,
      data: Partial<Omit<IWebhookDelivery, '_id' | 'tenantId' | 'endpointId' | 'eventId' | 'createdAt'>>,
    ): Promise<IWebhookDelivery | null> {
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { ...data };
      delete set._id;
      if (Object.keys(set).length === 0) return this.findWebhookDeliveryById(id);
      const doc = await db.collection(COLLECTIONS.webhookDeliveries).findOneAndUpdate(
        { _id: id as never },
        { $set: set },
        { returnDocument: 'after' },
      );
      return doc ? toDelivery(doc) : null;
    }

    async claimWebhookDelivery(id: string, now: Date, leaseUntil: Date): Promise<IWebhookDelivery | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.webhookDeliveries).findOneAndUpdate(
        { _id: id as never, status: 'pending', nextAttemptAt: { $lte: now } },
        { $set: { nextAttemptAt: leaseUntil } },
        { returnDocument: 'after' },
      );
      return doc ? toDelivery(doc) : null;
    }

    async listDueWebhookDeliveries(tenantId: string, now: Date, limit = 200): Promise<IWebhookDelivery[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.webhookDeliveries)
        .find({ tenantId, status: 'pending', nextAttemptAt: { $lte: now } })
        .sort({ nextAttemptAt: 1 })
        .limit(limit)
        .toArray();
      return docs.map(toDelivery);
    }

    async failPendingWebhookDeliveries(endpointId: string, reason: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.webhookDeliveries).updateMany(
        { endpointId, status: 'pending' },
        { $set: { status: 'failed', nextAttemptAt: null, lastError: reason } },
      );
      return result.modifiedCount ?? 0;
    }

    async cleanupWebhookDeliveryRetention(options: { olderThan: Date; batchSize?: number }): Promise<{ deletedCount: number }> {
      const db = this.getTenantDb();
      await this.ensureWebhookIndexes(db).catch(() => undefined);
      const coll = db.collection(COLLECTIONS.webhookDeliveries);
      // `$in` (not `$ne: 'pending'`) so the (status, createdAt) index serves it.
      const query = { status: { $in: ['delivered', 'failed'] }, createdAt: { $lt: options.olderThan } };
      if (options.batchSize && options.batchSize > 0) {
        const ids = await coll.find(query).project({ _id: 1 }).limit(options.batchSize).toArray();
        if (ids.length === 0) return { deletedCount: 0 };
        const result = await coll.deleteMany({ _id: { $in: ids.map((d) => d._id) } });
        return { deletedCount: result.deletedCount ?? 0 };
      }
      const result = await coll.deleteMany(query);
      return { deletedCount: result.deletedCount ?? 0 };
    }
  };
}
