/**
 * MongoDB Provider – scheduler claims mixin
 *
 * Exactly-once primitive for replicated schedulers: the claim key is the
 * document `_id`, so the DATABASE decides the single winner (no partial
 * index, which Cosmos DB's Mongo API rejects).
 */

import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

const DUPLICATE_KEY_ERROR_CODE = 11000;

export function SchedulerClaimMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class SchedulerClaimOps extends Base {
    async claimSchedulerSlot(key: string, expiresAt: Date): Promise<boolean> {
      const db = this.getTenantDb();
      try {
        await db
          .collection<{ _id: string; createdAt: Date; expiresAt: Date }>(COLLECTIONS.schedulerClaims)
          .insertOne({ _id: key, createdAt: new Date(), expiresAt });
        return true;
      } catch (error) {
        if ((error as { code?: number })?.code === DUPLICATE_KEY_ERROR_CODE) return false;
        throw error;
      }
    }

    async cleanupSchedulerClaims(olderThan: Date): Promise<number> {
      const db = this.getTenantDb();
      const res = await db
        .collection(COLLECTIONS.schedulerClaims)
        .deleteMany({ expiresAt: { $lt: olderThan } });
      return res.deletedCount ?? 0;
    }
  };
}
