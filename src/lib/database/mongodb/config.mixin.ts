/**
 * MongoDB Provider – Config (Secret/Configuration Management) operations mixin
 *
 * Two-level hierarchy: ConfigGroup → ConfigItem
 * Includes audit logs for tenant-scoped configuration management.
 */

import { ObjectId, type Filter } from 'mongodb';
import type {
  IConfigGroup,
  IConfigItem,
  IConfigAuditLog,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function ConfigMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class ConfigOps extends Base {
    // ── Config Group operations ──────────────────────────────────────

    async createConfigGroup(
      group: Omit<IConfigGroup, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IConfigGroup> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...group, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.configGroups)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IConfigGroup;
    }

    async updateConfigGroup(
      id: string,
      data: Partial<Omit<IConfigGroup, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IConfigGroup | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.configGroups)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as unknown as IConfigGroup;
    }

    async deleteConfigGroup(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.configGroups)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findConfigGroupById(id: string): Promise<IConfigGroup | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IConfigGroup>(COLLECTIONS.configGroups)
        .findOne({ _id: new ObjectId(id) } as Filter<IConfigGroup>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IConfigGroup;
    }

    async findConfigGroupByKey(key: string, projectId?: string): Promise<IConfigGroup | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { key };
      if (projectId) query.projectId = projectId;
      const doc = await db
        .collection<IConfigGroup>(COLLECTIONS.configGroups)
        .findOne(query as Filter<IConfigGroup>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IConfigGroup;
    }

    async listConfigGroups(filters?: {
      projectId?: string;
      tags?: string[];
      search?: string;
    }): Promise<IConfigGroup[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.tags && filters.tags.length > 0) {
        query.tags = { $all: filters.tags };
      }
      if (filters?.search) {
        query.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection<IConfigGroup>(COLLECTIONS.configGroups)
        .find(query as Filter<IConfigGroup>)
        .sort({ key: 1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IConfigGroup);
    }

    async countConfigGroups(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (projectId) query.projectId = projectId;
      return db.collection(COLLECTIONS.configGroups).countDocuments(query);
    }

    // ── Config Item operations ───────────────────────────────────────

    async createConfigItem(
      item: Omit<IConfigItem, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IConfigItem> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...item, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.configItems)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IConfigItem;
    }

    async updateConfigItem(
      id: string,
      data: Partial<Omit<IConfigItem, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IConfigItem | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.configItems)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as unknown as IConfigItem;
    }

    async deleteConfigItem(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.configItems)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async deleteConfigItemsByGroupId(groupId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.configItems)
        .deleteMany({ groupId });
      return result.deletedCount;
    }

    async findConfigItemById(id: string): Promise<IConfigItem | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection<IConfigItem>(COLLECTIONS.configItems)
        .findOne({ _id: new ObjectId(id) } as Filter<IConfigItem>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IConfigItem;
    }

    async findConfigItemByKey(
      key: string,
      projectId?: string,
    ): Promise<IConfigItem | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { key };
      if (projectId) query.projectId = projectId;
      const doc = await db
        .collection<IConfigItem>(COLLECTIONS.configItems)
        .findOne(query as Filter<IConfigItem>);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as IConfigItem;
    }

    async listConfigItems(filters?: {
      projectId?: string;
      groupId?: string;
      isSecret?: boolean;
      tags?: string[];
      search?: string;
    }): Promise<IConfigItem[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.groupId) query.groupId = filters.groupId;
      if (filters?.isSecret !== undefined) query.isSecret = filters.isSecret;
      if (filters?.tags && filters.tags.length > 0) {
        query.tags = { $all: filters.tags };
      }
      if (filters?.search) {
        query.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection<IConfigItem>(COLLECTIONS.configItems)
        .find(query as Filter<IConfigItem>)
        .sort({ key: 1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IConfigItem);
    }

    async countConfigItems(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      if (projectId) query.projectId = projectId;
      return db
        .collection(COLLECTIONS.configItems)
        .countDocuments(query);
    }

    // ── Config Audit Log operations ──────────────────────────────────

    async createConfigAuditLog(
      log: Omit<IConfigAuditLog, '_id' | 'createdAt'>,
    ): Promise<IConfigAuditLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const record = { ...log, createdAt: now };
      const result = await db
        .collection(COLLECTIONS.configAuditLogs)
        .insertOne(record);
      return { ...record, _id: result.insertedId.toString() } as IConfigAuditLog;
    }

    async listConfigAuditLogs(
      configKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IConfigAuditLog[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { configKey };
      if (options?.from || options?.to) {
        const dateFilter: Record<string, Date> = {};
        if (options.from) dateFilter.$gte = options.from;
        if (options.to) dateFilter.$lte = options.to;
        query.createdAt = dateFilter;
      }
      const cursor = db
        .collection<IConfigAuditLog>(COLLECTIONS.configAuditLogs)
        .find(query as Filter<IConfigAuditLog>)
        .sort({ createdAt: -1 });
      if (options?.skip) cursor.skip(options.skip);
      if (options?.limit) cursor.limit(options.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }) as IConfigAuditLog);
    }
  };
}
