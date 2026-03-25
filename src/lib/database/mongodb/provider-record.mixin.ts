/**
 * MongoDB Provider – Provider record operations mixin
 *
 * Includes provider configuration CRUD and rate-limiting.
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IProviderRecord, ProviderDomain } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function ProviderRecordMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class ProviderRecordOps extends Base {
    // ── Provider CRUD ────────────────────────────────────────────────

    async createProvider(
      provider: Omit<IProviderRecord, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IProviderRecord> {
      const db = this.getTenantDb();
      const now = new Date();
      const document: Omit<IProviderRecord, '_id'> & {
        createdAt: Date;
        updatedAt: Date;
      } = {
        ...provider,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db
        .collection<IProviderRecord>(COLLECTIONS.providers)
        .insertOne(document as unknown as IProviderRecord);

      return {
        ...document,
        _id: result.insertedId.toString(),
      };
    }

    async updateProvider(
      id: string,
      data: Partial<Omit<IProviderRecord, 'tenantId' | 'key'>>,
    ): Promise<IProviderRecord | null> {
      const db = this.getTenantDb();
      const objectId = new ObjectId(id);

      const existing = await db
        .collection<IProviderRecord>(COLLECTIONS.providers)
        .findOne({ _id: objectId });

      if (!existing) {
        return null;
      }

      const payload: Partial<IProviderRecord> = {
        ...(data as Partial<IProviderRecord>),
        updatedAt: new Date(),
      };
      delete payload._id;
      delete payload.tenantId;
      delete payload.key;

      const result = await db
        .collection<IProviderRecord>(COLLECTIONS.providers)
        .findOneAndUpdate(
          { _id: objectId },
          { $set: payload },
          { returnDocument: 'after' },
        );

      if (!result) {
        return null;
      }

      return {
        ...result,
        _id: result._id?.toString(),
      };
    }

    async findProviderById(id: string): Promise<IProviderRecord | null> {
      const db = this.getTenantDb();
      const provider = await db
        .collection<IProviderRecord>(COLLECTIONS.providers)
        .findOne({ _id: new ObjectId(id) });

      if (!provider) {
        return null;
      }

      return {
        ...provider,
        _id: provider._id?.toString(),
      };
    }

    async findProviderByKey(
      tenantId: string,
      key: string,
      projectId?: string,
    ): Promise<IProviderRecord | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId, key };
      if (projectId) {
        // Treat projectId as an assignment filter.
        // Supports legacy single-project providers (projectId) and multi-assigned providers (projectIds).
        query.$or = [{ projectId }, { projectIds: projectId }];
      }
      const provider = await db
        .collection<IProviderRecord>(COLLECTIONS.providers)
        .findOne(query as Filter<IProviderRecord>);

      if (!provider) {
        return null;
      }

      return {
        ...provider,
        _id: provider._id?.toString(),
      };
    }

    async listProviders(
      tenantId: string,
      filters?: {
        type?: ProviderDomain;
        driver?: string;
        status?: IProviderRecord['status'];
        projectId?: string;
      },
    ): Promise<IProviderRecord[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId };

      if (filters?.projectId) {
        query.$or = [{ projectId: filters.projectId }, { projectIds: filters.projectId }];
      }

      if (filters?.type) {
        query.type = filters.type;
      }

      if (filters?.driver) {
        query.driver = filters.driver;
      }

      if (filters?.status) {
        query.status = filters.status;
      }

      const providers = await db
        .collection<IProviderRecord>(COLLECTIONS.providers)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      return providers.map((provider) => ({
        ...provider,
        _id: provider._id?.toString(),
      }));
    }

    async deleteProvider(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IProviderRecord>(COLLECTIONS.providers)
        .deleteOne({ _id: new ObjectId(id) });

      return result.deletedCount > 0;
    }

    // ── Rate limiting ────────────────────────────────────────────────

    async incrementRateLimit(
      key: string,
      windowSeconds: number,
      amount: number = 1,
    ): Promise<{ count: number; resetAt: Date }> {
      type RateLimitRecord = {
        _id: string;
        count: number;
        resetAt: Date;
        isExpired?: boolean;
      };

      const db = this.getTenantDb();
      const now = new Date();
      const resetAt = new Date(now.getTime() + windowSeconds * 1000);

      // Use pipeline update for atomic check-and-set
      const result = await db
        .collection<RateLimitRecord>(COLLECTIONS.rateLimits)
        .findOneAndUpdate(
          { _id: key } as Filter<RateLimitRecord>,
          [
            {
              $set: {
                isExpired: { $lt: ['$resetAt', now] },
              },
            },
            {
              $set: {
                count: {
                  $cond: {
                    if: { $or: [{ $eq: ['$isExpired', true] }, { $not: ['$resetAt'] }] },
                    then: amount,
                    else: { $add: ['$count', amount] },
                  },
                },
                resetAt: {
                  $cond: {
                    if: { $or: [{ $eq: ['$isExpired', true] }, { $not: ['$resetAt'] }] },
                    then: resetAt,
                    else: '$resetAt',
                  },
                },
              },
            },
            {
              $unset: 'isExpired',
            },
          ],
          { upsert: true, returnDocument: 'after' },
        );

      if (!result) {
        throw new Error('Failed to increment rate limit');
      }

      return {
        count: result.count,
        resetAt: result.resetAt,
      };
    }
  };
}
