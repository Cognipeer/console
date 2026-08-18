/**
 * MongoDB Provider – Cross-service usage rollup mixin
 *
 * `usage_daily` holds one row per (dimension tuple, UTC day) with additive
 * counters. Writes are $inc upserts so concurrent flushers (multi-instance)
 * never conflict; the unique dimension index only backstops the upsert filter.
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IUsageDaily, IUsageDailyIncrement } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

const COUNTER_FIELDS = [
  'requests',
  'errors',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'totalTokens',
  'costUsd',
  'latencyMsSum',
  'latencyCount',
] as const;

export function UsageRollupMixin<TBase extends Constructor<MongoDBProviderBase>>(
  Base: TBase,
) {
  return class UsageRollupOps extends Base {
    private usageDailyIndexReady = new Set<string>();

    private async ensureUsageDailyIndexes(): Promise<void> {
      const db = this.getTenantDb();
      const dbName = db.databaseName;
      if (this.usageDailyIndexReady.has(dbName)) return;
      this.usageDailyIndexReady.add(dbName);
      try {
        const col = db.collection(COLLECTIONS.usageDaily);
        // v2 adds the agentKey dimension — drop the pre-agent unique index,
        // which would otherwise reject rows differing only in agentKey.
        await col.dropIndex('uniq_usage_daily_dims').catch(() => undefined);
        // v3 adds the metadataKey dimension (free-form caller-supplied
        // attribution tags) — drop v2, which would otherwise reject rows
        // differing only in metadataKey.
        await col.dropIndex('uniq_usage_daily_dims_v2').catch(() => undefined);
        await col.createIndex(
          {
            tenantId: 1,
            projectId: 1,
            userId: 1,
            apiTokenId: 1,
            source: 1,
            service: 1,
            refKey: 1,
            agentKey: 1,
            metadataKey: 1,
            day: 1,
          },
          { unique: true, name: 'uniq_usage_daily_dims_v3' },
        );
        await col.createIndex(
          { tenantId: 1, day: -1 },
          { name: 'idx_usage_daily_day' },
        );
        await col.createIndex(
          { tenantId: 1, userId: 1, day: -1 },
          { name: 'idx_usage_daily_user_day' },
        );
        await col.createIndex(
          { tenantId: 1, agentKey: 1, day: -1 },
          { name: 'idx_usage_daily_agent_day' },
        );
      } catch (error) {
        logger.warn('Could not ensure usage_daily indexes', { dbName, error });
      }
    }

    async incrementUsageDaily(rows: IUsageDailyIncrement[]): Promise<void> {
      if (rows.length === 0) return;
      await this.ensureUsageDailyIndexes();
      const db = this.getTenantDb();

      const ops = rows.map((row) => {
        // Every counter is always $inc'd (0 when omitted) so first-insert rows
        // carry the full counter set and readers never see missing fields.
        const inc: Record<string, number> = Object.fromEntries(
          COUNTER_FIELDS.map((field) => [field, row[field] ?? 0]),
        );
        for (const [unit, value] of Object.entries(row.units ?? {})) {
          if (typeof value === 'number' && value !== 0) {
            inc[`units.${unit}`] = value;
          }
        }

        return {
          updateOne: {
            filter: {
              tenantId: row.tenantId,
              projectId: row.projectId,
              userId: row.userId,
              apiTokenId: row.apiTokenId,
              source: row.source,
              service: row.service,
              refKey: row.refKey,
              agentKey: row.agentKey ?? '',
              metadataKey: row.metadataKey ?? '',
              day: row.day,
            },
            update: {
              $inc: inc,
              // Same metadataKey ⇒ same metadata object by construction
              // (metadataKey is its canonical serialization), so overwriting
              // on every increment is safe and keeps a stale object from
              // lingering if the shape changed upstream.
              $set: { updatedAt: new Date(), metadata: row.metadata ?? {} },
              $setOnInsert: {
                actorType: row.actorType,
                // Real Date for the reports engine's range filters/bucketing.
                dayDate: new Date(`${row.day}T00:00:00.000Z`),
              },
            },
            upsert: true,
          },
        };
      });

      await db
        .collection(COLLECTIONS.usageDaily)
        .bulkWrite(ops, { ordered: false });
    }

    async setUsageDailyCost(
      updates: Array<{ id: string; costUsd: number }>,
    ): Promise<number> {
      if (updates.length === 0) return 0;
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.usageDaily).bulkWrite(
        updates.map((row) => ({
          updateOne: {
            filter: { _id: new ObjectId(row.id) },
            update: { $set: { costUsd: row.costUsd, updatedAt: new Date() } },
          },
        })),
        { ordered: false },
      );
      return result.modifiedCount;
    }

    async listUsageDaily(filter: {
      projectId?: string;
      userId?: string;
      apiTokenId?: string;
      service?: string;
      refKey?: string;
      agentKey?: string;
      source?: string;
      fromDay?: string;
      toDay?: string;
      limit?: number;
    }): Promise<IUsageDaily[]> {
      const db = this.getTenantDb();
      const query: Filter<IUsageDaily> = {};
      if (filter.projectId !== undefined) query.projectId = filter.projectId;
      if (filter.userId !== undefined) query.userId = filter.userId;
      if (filter.apiTokenId !== undefined) query.apiTokenId = filter.apiTokenId;
      if (filter.service !== undefined) query.service = filter.service;
      if (filter.refKey !== undefined) query.refKey = filter.refKey;
      if (filter.agentKey !== undefined) query.agentKey = filter.agentKey;
      if (filter.source !== undefined) query.source = filter.source;
      if (filter.fromDay || filter.toDay) {
        query.day = {
          ...(filter.fromDay ? { $gte: filter.fromDay } : {}),
          ...(filter.toDay ? { $lte: filter.toDay } : {}),
        };
      }

      const rows = await db
        .collection<IUsageDaily>(COLLECTIONS.usageDaily)
        .find(query)
        .sort({ day: -1 })
        .limit(filter.limit ?? 1000)
        .toArray();

      return rows.map((row) => ({ ...row, _id: row._id?.toString() }));
    }
  };
}
