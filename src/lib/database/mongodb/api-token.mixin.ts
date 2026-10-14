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
      const storedTokenData = { ...tokenData };
      delete storedTokenData.token;
      // An empty allowlist is stored as "no field", exactly like every token minted before the feature.
      if (!storedTokenData.allowedIpRanges?.length) delete storedTokenData.allowedIpRanges;
      // Stored only when set, like the allowlist: a missing field is every token minted before the feature.
      if (!storedTokenData.requireUserToken) delete storedTokenData.requireUserToken;

      const result = await db.collection(COLLECTIONS.apiTokens).insertOne({
        ...storedTokenData,
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

    async findApiTokenByHash(tokenHash: string): Promise<IApiToken | null> {
      const db = this.getMainDb();
      const apiToken = await db
        .collection<IApiToken>(COLLECTIONS.apiTokens)
        .findOne({ tokenHash });
      if (!apiToken) return null;

      return {
        ...apiToken,
        _id: apiToken._id?.toString(),
      };
    }

    async findApiTokenById(id: string, tenantId: string): Promise<IApiToken | null> {
      // A malformed id is "no such token", not a driver exception (-> 500).
      if (!/^[0-9a-fA-F]{24}$/.test(id)) return null;
      const db = this.getMainDb();
      const apiToken = await db
        .collection<IApiToken>(COLLECTIONS.apiTokens)
        .findOne({ _id: new ObjectId(id), tenantId } as never);
      if (!apiToken) return null;

      return {
        ...apiToken,
        _id: apiToken._id?.toString(),
      };
    }

    async updateApiToken(
      id: string,
      tenantId: string,
      data: { label?: string; expiresAt?: Date | null; allowedIpRanges?: string[] | null; requireUserToken?: boolean },
    ): Promise<IApiToken | null> {
      if (!/^[0-9a-fA-F]{24}$/.test(id)) return null;
      const $set: Record<string, unknown> = {};
      const $unset: Record<string, ''> = {};
      if (data.label !== undefined) $set.label = data.label;
      if (data.expiresAt !== undefined) {
        if (data.expiresAt) $set.expiresAt = data.expiresAt;
        else $unset.expiresAt = '';
      }
      if (data.allowedIpRanges !== undefined) {
        // Cleared = field removed, i.e. exactly how a never-restricted token looks.
        if (data.allowedIpRanges?.length) $set.allowedIpRanges = data.allowedIpRanges;
        else $unset.allowedIpRanges = '';
      }
      if (data.requireUserToken !== undefined) {
        if (data.requireUserToken) $set.requireUserToken = true;
        else $unset.requireUserToken = '';
      }

      const update: Record<string, unknown> = {};
      if (Object.keys($set).length > 0) update.$set = $set;
      if (Object.keys($unset).length > 0) update.$unset = $unset;
      if (Object.keys(update).length === 0) return this.findApiTokenById(id, tenantId);

      const db = this.getMainDb();
      const result = await db
        .collection(COLLECTIONS.apiTokens)
        .updateOne({ _id: new ObjectId(id), tenantId }, update);
      if (result.matchedCount === 0) return null;
      return this.findApiTokenById(id, tenantId);
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

    async updateTokenLastUsedByHash(tokenHash: string): Promise<void> {
      const db = this.getMainDb();
      await db
        .collection(COLLECTIONS.apiTokens)
        .updateOne({ tokenHash }, { $set: { lastUsed: new Date() } });
    }
  };
}
