/**
 * MongoDB Provider – API Token operations mixin
 */

import { ObjectId } from 'mongodb';
import type { IApiToken } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function ApiTokenMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class ApiTokenOps extends Base {
    async createApiToken(
      tokenData: Omit<IApiToken, '_id' | 'createdAt'>,
    ): Promise<IApiToken> {
      const db = this.getMainDb();
      const now = new Date();

      const result = await db.collection(COLLECTIONS.apiTokens).insertOne({
        ...tokenData,
        createdAt: now,
      });

      return {
        ...tokenData,
        _id: result.insertedId.toString(),
        createdAt: now,
      };
    }

    async listApiTokens(userId: string): Promise<IApiToken[]> {
      const db = this.getMainDb();
      const tokens = await db
        .collection<IApiToken>(COLLECTIONS.apiTokens)
        .find({ userId })
        .sort({ createdAt: -1 })
        .toArray();

      return tokens.map((token: IApiToken) => ({
        ...token,
        _id: token._id?.toString(),
      }));
    }

    async listTenantApiTokens(tenantId: string): Promise<IApiToken[]> {
      const db = this.getMainDb();
      const tokens = await db
        .collection<IApiToken>(COLLECTIONS.apiTokens)
        .find({ tenantId })
        .sort({ createdAt: -1 })
        .toArray();

      return tokens.map((token: IApiToken) => ({
        ...token,
        _id: token._id?.toString(),
      }));
    }

    async listProjectApiTokens(tenantId: string, projectId: string): Promise<IApiToken[]> {
      const db = this.getMainDb();
      const tokens = await db
        .collection<IApiToken>(COLLECTIONS.apiTokens)
        .find({ tenantId, projectId })
        .sort({ createdAt: -1 })
        .toArray();

      return tokens.map((token: IApiToken) => ({
        ...token,
        _id: token._id?.toString(),
      }));
    }

    async findApiTokenByToken(token: string): Promise<IApiToken | null> {
      const db = this.getMainDb();
      const apiToken = await db
        .collection<IApiToken>(COLLECTIONS.apiTokens)
        .findOne({ token });
      if (!apiToken) return null;

      return {
        ...apiToken,
        _id: apiToken._id?.toString(),
      };
    }

    async deleteApiToken(id: string, userId: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = await db.collection(COLLECTIONS.apiTokens).deleteOne({
        _id: new ObjectId(id),
        userId,
      });
      return result.deletedCount > 0;
    }

    async deleteTenantApiToken(id: string, tenantId: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = await db.collection(COLLECTIONS.apiTokens).deleteOne({
        _id: new ObjectId(id),
        tenantId,
      });
      return result.deletedCount > 0;
    }

    async deleteProjectApiToken(id: string, tenantId: string, projectId: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = await db.collection(COLLECTIONS.apiTokens).deleteOne({
        _id: new ObjectId(id),
        tenantId,
        projectId,
      });
      return result.deletedCount > 0;
    }

    async updateTokenLastUsed(token: string): Promise<void> {
      const db = this.getMainDb();
      await db
        .collection(COLLECTIONS.apiTokens)
        .updateOne({ token }, { $set: { lastUsed: new Date() } });
    }
  };
}
