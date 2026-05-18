/**
 * MongoDB Provider – JS Sandbox runtimes and execution logs.
 */

import { ObjectId } from 'mongodb';
import type {
  IJsSandboxExecution,
  IJsSandboxRuntime,
  JsSandboxExecutionStatus,
  JsSandboxRuntimeStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { COLLECTIONS, MongoDBProviderBase } from './base';

function toId(value: ObjectId | string | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.toString();
}

function objectId(id: string): ObjectId {
  return new ObjectId(id);
}

export function JsSandboxMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class JsSandboxOps extends Base {
    async createJsSandboxRuntime(
      runtime: Omit<IJsSandboxRuntime, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IJsSandboxRuntime> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc: Omit<IJsSandboxRuntime, '_id'> = { ...runtime, createdAt: now, updatedAt: now };
      const result = await db
        .collection<IJsSandboxRuntime>(COLLECTIONS.jsSandboxRuntimes)
        .insertOne(doc as IJsSandboxRuntime);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateJsSandboxRuntime(
      id: string,
      data: Partial<Omit<IJsSandboxRuntime, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt'>>,
    ): Promise<IJsSandboxRuntime | null> {
      const db = this.getTenantDb();
      const payload: Partial<IJsSandboxRuntime> = { ...data, updatedAt: new Date() };
      delete payload._id;
      delete payload.tenantId;
      delete payload.key;
      delete payload.createdBy;
      delete payload.createdAt;
      const result = await db
        .collection<IJsSandboxRuntime>(COLLECTIONS.jsSandboxRuntimes)
        .findOneAndUpdate(
          { _id: objectId(id) },
          { $set: payload },
          { returnDocument: 'after' },
        );
      return result ? ({ ...result, _id: toId(result._id) } as IJsSandboxRuntime) : null;
    }

    async deleteJsSandboxRuntime(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IJsSandboxRuntime>(COLLECTIONS.jsSandboxRuntimes)
        .deleteOne({ _id: objectId(id) });
      return result.deletedCount > 0;
    }

    async findJsSandboxRuntimeById(id: string): Promise<IJsSandboxRuntime | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IJsSandboxRuntime>(COLLECTIONS.jsSandboxRuntimes)
          .findOne({ _id: objectId(id) });
        return record ? ({ ...record, _id: toId(record._id) } as IJsSandboxRuntime) : null;
      } catch {
        return null;
      }
    }

    async findJsSandboxRuntimeByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<IJsSandboxRuntime | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId, key };
      if (projectId) query.projectId = projectId;
      const record = await db
        .collection<IJsSandboxRuntime>(COLLECTIONS.jsSandboxRuntimes)
        .findOne(query);
      return record ? ({ ...record, _id: toId(record._id) } as IJsSandboxRuntime) : null;
    }

    async listJsSandboxRuntimes(
      tenantId: string,
      filters?: { projectId?: string; status?: JsSandboxRuntimeStatus | string; search?: string },
    ): Promise<IJsSandboxRuntime[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        const search = new RegExp(this.escapeRegex(filters.search), 'i');
        query.$or = [{ name: search }, { key: search }, { description: search }];
      }
      const docs = await db
        .collection<IJsSandboxRuntime>(COLLECTIONS.jsSandboxRuntimes)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((doc) => ({ ...doc, _id: toId(doc._id) }) as IJsSandboxRuntime);
    }

    async countJsSandboxRuntimes(tenantId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };
      if (projectId) query.projectId = projectId;
      return db.collection<IJsSandboxRuntime>(COLLECTIONS.jsSandboxRuntimes).countDocuments(query);
    }

    async createJsSandboxExecution(
      execution: Omit<IJsSandboxExecution, '_id' | 'createdAt'>,
    ): Promise<IJsSandboxExecution> {
      const db = this.getTenantDb();
      const doc: Omit<IJsSandboxExecution, '_id'> = { ...execution, createdAt: new Date() };
      const result = await db
        .collection<IJsSandboxExecution>(COLLECTIONS.jsSandboxExecutions)
        .insertOne(doc as IJsSandboxExecution);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async findJsSandboxExecutionById(id: string): Promise<IJsSandboxExecution | null> {
      const db = this.getTenantDb();
      try {
        const record = await db
          .collection<IJsSandboxExecution>(COLLECTIONS.jsSandboxExecutions)
          .findOne({ _id: objectId(id) });
        return record ? ({ ...record, _id: toId(record._id) } as IJsSandboxExecution) : null;
      } catch {
        return null;
      }
    }

    async listJsSandboxExecutions(
      tenantId: string,
      filters?: {
        projectId?: string;
        runtimeId?: string;
        runtimeKey?: string;
        status?: JsSandboxExecutionStatus | string;
        from?: Date;
        to?: Date;
        limit?: number;
        skip?: number;
      },
    ): Promise<IJsSandboxExecution[]> {
      const db = this.getTenantDb();
      const query = this.buildExecutionFilter(tenantId, filters);
      const docs = await db
        .collection<IJsSandboxExecution>(COLLECTIONS.jsSandboxExecutions)
        .find(query)
        .sort({ createdAt: -1 })
        .skip(Math.max(filters?.skip ?? 0, 0))
        .limit(Math.min(Math.max(filters?.limit ?? 50, 1), 200))
        .toArray();
      return docs.map((doc) => ({ ...doc, _id: toId(doc._id) }) as IJsSandboxExecution);
    }

    async countJsSandboxExecutions(
      tenantId: string,
      filters?: {
        projectId?: string;
        runtimeId?: string;
        runtimeKey?: string;
        status?: JsSandboxExecutionStatus | string;
        from?: Date;
        to?: Date;
      },
    ): Promise<number> {
      const db = this.getTenantDb();
      return db
        .collection<IJsSandboxExecution>(COLLECTIONS.jsSandboxExecutions)
        .countDocuments(this.buildExecutionFilter(tenantId, filters));
    }

    private buildExecutionFilter(
      tenantId: string,
      filters?: {
        projectId?: string;
        runtimeId?: string;
        runtimeKey?: string;
        status?: JsSandboxExecutionStatus | string;
        from?: Date;
        to?: Date;
      },
    ): Record<string, unknown> {
      const query: Record<string, unknown> = { tenantId };
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.runtimeId) query.runtimeId = filters.runtimeId;
      if (filters?.runtimeKey) query.runtimeKey = filters.runtimeKey;
      if (filters?.status) query.status = filters.status;
      if (filters?.from || filters?.to) {
        query.createdAt = {};
        if (filters.from) (query.createdAt as Record<string, unknown>).$gte = filters.from;
        if (filters.to) (query.createdAt as Record<string, unknown>).$lte = filters.to;
      }
      return query;
    }
  };
}
