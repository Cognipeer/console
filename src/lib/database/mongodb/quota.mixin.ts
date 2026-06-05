/**
 * MongoDB Provider – Quota policy operations mixin
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IQuotaPolicy } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function QuotaMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class QuotaOps extends Base {
    async createQuotaPolicy(
      policy: Omit<IQuotaPolicy, '_id'>,
    ): Promise<IQuotaPolicy> {
      const db = this.getTenantDb();
      const now = new Date();
      const payload = {
        ...policy,
        createdAt: policy.createdAt ?? now,
        updatedAt: policy.updatedAt ?? now,
      };

      const result = await db
        .collection<IQuotaPolicy>(COLLECTIONS.quotaPolicies)
        .insertOne(payload);

      return {
        ...payload,
        _id: result.insertedId.toString(),
      };
    }

    async listQuotaPolicies(tenantId: string, projectId?: string): Promise<IQuotaPolicy[]> {
      const db = this.getTenantDb();
      const tenantFilter = ObjectId.isValid(tenantId)
        ? { $or: [{ tenantId }, { tenantId: new ObjectId(tenantId) }] }
        : { tenantId };
      const projectFilter = projectId ? { projectId } : {};
      const query: Filter<IQuotaPolicy> = {
        ...(tenantFilter as Record<string, unknown>),
        ...(projectFilter as Record<string, unknown>),
      };
      const policies = await db
        .collection<IQuotaPolicy>(COLLECTIONS.quotaPolicies)
        .find(query)
        .sort({ priority: -1, createdAt: -1 })
        .toArray();

      return policies.map((policy) => ({
        ...policy,
        _id: policy._id?.toString(),
      }));
    }

    async updateQuotaPolicy(
      id: string,
      tenantId: string,
      data: Partial<IQuotaPolicy>,
      projectId?: string,
    ): Promise<IQuotaPolicy | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const tenantFilter = ObjectId.isValid(tenantId)
        ? { $or: [{ tenantId }, { tenantId: new ObjectId(tenantId) }] }
        : { tenantId };
      const idFilter = hasObjectId
        ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
        : { _id: id };
      const projectFilter = projectId ? { projectId } : {};
      const filter = { $and: [tenantFilter, idFilter, projectFilter] } as Filter<IQuotaPolicy>;
      const updateData = {
        ...data,
        updatedAt: new Date(),
      };

      const result = await db
        .collection<IQuotaPolicy>(COLLECTIONS.quotaPolicies)
        .findOneAndUpdate(
          filter,
          { $set: updateData },
          { returnDocument: 'after' },
        );

      if (!result) return null;

      return {
        ...result,
        _id: result._id?.toString(),
      } as IQuotaPolicy;
    }

    async deleteQuotaPolicy(id: string, tenantId: string, projectId?: string): Promise<boolean> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const tenantFilter = ObjectId.isValid(tenantId)
        ? { $or: [{ tenantId }, { tenantId: new ObjectId(tenantId) }] }
        : { tenantId };
      const idFilter = hasObjectId
        ? { $or: [{ _id: new ObjectId(id) }, { _id: id }] }
        : { _id: id };
      const projectFilter = projectId ? { projectId } : {};
      const filter = { $and: [tenantFilter, idFilter, projectFilter] } as Filter<IQuotaPolicy>;

      const result = await db
        .collection<IQuotaPolicy>(COLLECTIONS.quotaPolicies)
        .deleteOne(filter);

      return result.deletedCount > 0;
    }
  };
}
