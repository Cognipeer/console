/**
 * MongoDB Provider – Cross-service usage rollup mixin
 *
 * `usage_daily` holds one row per (dimension tuple, UTC day) with additive
 * counters. Writes are $inc upserts so concurrent flushers (multi-instance)
 * never conflict; the unique dimension index only backstops the upsert filter.
 */

import type { Filter } from 'mongodb';
import type { IUsageDaily, IUsageDailyIncrement } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

const COUNTER_FIELDS = [
  'requests',
  'errors',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
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
        await col.createIndex(
          {
            tenantId: 1,
            projectId: 1,
            userId: 1,
            apiTokenId: 1,
            source: 1,
            service: 1,
            refKey: 1,
            day: 1,
          },
          { unique: true, name: 'uniq_usage_daily_dims' },
        );
        await col.createIndex(
          { tenantId: 1, day: -1 },
          { name: 'idx_usage_daily_day' },
        );
        await col.createIndex(
          { tenantId: 1, userId: 1, day: -1 },
          { name: 'idx_usage_daily_user_day' },
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
              day: row.day,
            },
            update: {
              $inc: inc,
              $set: { updatedAt: new Date() },
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

    async listUsageDaily(filter: {
      projectId?: string;
      userId?: string;
      apiTokenId?: string;
      service?: string;
      refKey?: string;
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
