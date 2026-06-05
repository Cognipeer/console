/**
 * MongoDB Provider – Memory operations mixin
 *
 * Includes memory stores and memory items.
 */

import { ObjectId, type Filter } from 'mongodb';
import type {
  IMemoryStore,
  IMemoryItem,
  MemoryScope,
  MemoryStoreStatus,
  MemoryItemStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function MemoryMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class MemoryOps extends Base {
    // ── Memory Store operations ──────────────────────────────────────

    async createMemoryStore(
      store: Omit<IMemoryStore, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IMemoryStore> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...store, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.memoryStores)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IMemoryStore;
    }

    async updateMemoryStore(
      id: string,
      data: Partial<Omit<IMemoryStore, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IMemoryStore | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.memoryStores)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as unknown as IMemoryStore;
    }

    async deleteMemoryStore(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.memoryStores)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findMemoryStoreById(id: string): Promise<IMemoryStore | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IMemoryStore>(COLLECTIONS.memoryStores)
        .findOne({ _id: new ObjectId(id) } as Filter<IMemoryStore>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IMemoryStore;
    }

    async findMemoryStoreByKey(key: string, projectId?: string): Promise<IMemoryStore | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { key };
      if (projectId) query.projectId = projectId;
      const doc = await db
        .collection<IMemoryStore>(COLLECTIONS.memoryStores)
        .findOne(query as Filter<IMemoryStore>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IMemoryStore;
    }

    async listMemoryStores(filters?: {
      projectId?: string;
      status?: MemoryStoreStatus;
      search?: string;
    }): Promise<IMemoryStore[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        query.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection<IMemoryStore>(COLLECTIONS.memoryStores)
        .find(query as Filter<IMemoryStore>)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IMemoryStore);
    }

    async countMemoryStores(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (projectId) query.projectId = projectId;
      return db
        .collection(COLLECTIONS.memoryStores)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .countDocuments(query as any);
    }

    // ── Memory Item operations ───────────────────────────────────────

    async createMemoryItem(
      item: Omit<IMemoryItem, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IMemoryItem> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...item, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.memoryItems)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IMemoryItem;
    }

    async updateMemoryItem(
      id: string,
      data: Partial<Omit<IMemoryItem, 'tenantId' | 'storeKey'>>,
    ): Promise<IMemoryItem | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.memoryItems)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as unknown as IMemoryItem;
    }

    async deleteMemoryItem(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.memoryItems)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async deleteMemoryItems(
      storeKey: string,
      filter?: { scope?: MemoryScope; scopeId?: string; tags?: string[]; before?: Date },
    ): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { storeKey };
      if (filter?.scope) query.scope = filter.scope;
      if (filter?.scopeId) query.scopeId = filter.scopeId;
      if (filter?.tags?.length) query.tags = { $in: filter.tags };
      if (filter?.before) query.createdAt = { $lt: filter.before };
      const result = await db
        .collection(COLLECTIONS.memoryItems)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .deleteMany(query as any);
      return result.deletedCount;
    }

    async findMemoryItemById(id: string): Promise<IMemoryItem | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IMemoryItem>(COLLECTIONS.memoryItems)
        .findOne({ _id: new ObjectId(id) } as Filter<IMemoryItem>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IMemoryItem;
    }

    async findMemoryItemByHash(storeKey: string, contentHash: string): Promise<IMemoryItem | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IMemoryItem>(COLLECTIONS.memoryItems)
        .findOne({ storeKey, contentHash } as Filter<IMemoryItem>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IMemoryItem;
    }

    async listMemoryItems(
      storeKey: string,
      filters?: {
        projectId?: string;
        scope?: MemoryScope;
        scopeId?: string;
        tags?: string[];
        status?: MemoryItemStatus;
        search?: string;
        limit?: number;
        skip?: number;
      },
    ): Promise<{ items: IMemoryItem[]; total: number }> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { storeKey };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.scope) query.scope = filters.scope;
      if (filters?.scopeId) query.scopeId = filters.scopeId;
      if (filters?.status) query.status = filters.status;
      if (filters?.tags?.length) query.tags = { $in: filters.tags };
      if (filters?.search) {
        query.content = { $regex: filters.search, $options: 'i' };
      }
      const col = db.collection<IMemoryItem>(COLLECTIONS.memoryItems);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = await col.countDocuments(query as any);
      const cursor = col
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find(query as any)
        .sort({ createdAt: -1 });
      if (filters?.skip) cursor.skip(filters.skip);
      cursor.limit(filters?.limit ?? 50);
      const docs = await cursor.toArray();
      return {
        items: docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IMemoryItem),
        total,
      };
    }

    async countMemoryItems(storeKey: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { storeKey };
      if (projectId) query.projectId = projectId;
      return db
        .collection(COLLECTIONS.memoryItems)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .countDocuments(query as any);
    }

    async incrementMemoryAccess(id: string): Promise<void> {
      const db = this.getTenantDb();
      await db
        .collection(COLLECTIONS.memoryItems)
        .updateOne(
          { _id: new ObjectId(id) },
          {
            $inc: { accessCount: 1 },
            $set: { lastAccessedAt: new Date() },
          },
        );
    }
  };
}
