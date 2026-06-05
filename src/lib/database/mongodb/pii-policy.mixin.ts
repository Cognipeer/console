/**
 * MongoDB Provider – PII Policy operations mixin
 */

import { ObjectId } from 'mongodb';
import type { IPiiPolicy } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function PiiPolicyMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class PiiPolicyOps extends Base {
    async createPiiPolicy(
      policy: Omit<IPiiPolicy, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IPiiPolicy> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...policy, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.piiPolicies).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updatePiiPolicy(
      id: string,
      data: Partial<Omit<IPiiPolicy, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IPiiPolicy | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IPiiPolicy>(COLLECTIONS.piiPolicies)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IPiiPolicy;
    }

    async deletePiiPolicy(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.piiPolicies)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findPiiPolicyById(id: string): Promise<IPiiPolicy | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.piiPolicies)
        .findOne({ _id: new ObjectId(id) });
      return doc as unknown as IPiiPolicy | null;
    }

    async findPiiPolicyByKey(key: string, projectId?: string): Promise<IPiiPolicy | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db.collection(COLLECTIONS.piiPolicies).findOne(filter);
      return doc as unknown as IPiiPolicy | null;
    }

    async listPiiPolicies(filters?: {
      projectId?: string;
      enabled?: boolean;
      search?: string;
    }): Promise<IPiiPolicy[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.enabled !== undefined) filter.enabled = filters.enabled;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.piiPolicies)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as IPiiPolicy[];
    }
  };
}
