/**
 * MongoDB Provider – Entity health rollup mixin
 *
 * `entity_metrics` holds one row per (project, entity type, entity key,
 * source, 5-minute bucket) with additive counters and a latency histogram
 * (`lat0..lat14`). Writes are $inc upserts so concurrent flushers
 * (multi-instance) never conflict; the unique dimension index backstops the
 * upsert filter. A per-row `expiresAt` + TTL index expires old buckets; the
 * hourly purge sweep covers deployments whose TTL monitor is off.
 */

import { MongoBulkWriteError, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';
import {
  ENTITY_METRIC_BUCKET_MS,
  ENTITY_METRIC_COUNTER_FIELDS,
  type EntityMetricsAggregateQuery,
  type IEntityMetricAggregate,
  type IEntityMetricIncrement,
} from '../provider/types.base';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

const CHUNK_SIZE = 500;
const DEFAULT_AGGREGATE_LIMIT = 10_000;
const MAX_AGGREGATE_LIMIT = 50_000;
const MAX_ENTITY_KEYS = 500;

const GROUP_FIELDS = ['entityType', 'entityKey', 'source', 'projectId'] as const;

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function EntityMetricsMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class EntityMetricsOps extends Base {
    private entityMetricsIndexesReady = new Set<string>();
    private entityMetricsIndexInit = new Map<string, Promise<void>>();

    /**
     * Ensured on the write path as well as in the boot manifest: the manifest
     * is existence-guarded, so a collection created after the tenant's first
     * bind would stay unindexed until a restart. Names/keys are IDENTICAL to
     * the manifest's. Memoized only AFTER success, keyed by database name.
     */
    private async ensureEntityMetricsIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.entityMetricsIndexesReady.has(dbName)) return;
      const inflight = this.entityMetricsIndexInit.get(dbName);
      if (inflight) return inflight;

      const coll = db.collection(COLLECTIONS.entityMetrics);
      const pending = Promise.all([
        coll.createIndex(
          { tenantId: 1, projectId: 1, entityType: 1, entityKey: 1, source: 1, bucketMs: 1 },
          { name: 'uniq_entity_metrics_dims', unique: true },
        ),
        coll.createIndex(
          { tenantId: 1, projectId: 1, entityType: 1, bucketMs: 1 },
          { name: 'idx_entity_metrics_type_bucket' },
        ),
        coll.createIndex({ bucketMs: 1 }, { name: 'idx_entity_metrics_bucket' }),
        coll.createIndex({ expiresAt: 1 }, { name: 'ttl_entity_metrics_expiresAt', expireAfterSeconds: 0 }),
      ])
        .then(() => {
          this.entityMetricsIndexesReady.add(dbName);
        })
        .finally(() => {
          this.entityMetricsIndexInit.delete(dbName);
        });
      this.entityMetricsIndexInit.set(dbName, pending);
      return pending;
    }

    async incrementEntityMetrics(rows: IEntityMetricIncrement[]): Promise<void> {
      if (rows.length === 0) return;
      const db = this.getTenantDb();
      await this.ensureEntityMetricsIndexes(db).catch((error) => {
        logger.warn('Could not ensure entity_metrics indexes', { dbName: db.databaseName, error });
      });
      const coll = db.collection(COLLECTIONS.entityMetrics);
      const now = new Date();

      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const ops: AnyBulkWriteOperation<Document>[] = rows.slice(i, i + CHUNK_SIZE).map((row) => {
          const inc: Record<string, number> = {};
          for (const field of ENTITY_METRIC_COUNTER_FIELDS) {
            const v = num(row[field]);
            if (v !== 0) inc[field] = v;
          }
          // $inc may not be empty; a zero-valued row still materializes the bucket.
          if (Object.keys(inc).length === 0) inc.requests = 0;

          const update: Document = {
            $inc: inc,
            $set: { updatedAt: now },
            $setOnInsert: {
              bucketStart: new Date(row.bucketMs),
              ...(row.expiresAtMs ? { expiresAt: new Date(row.expiresAtMs) } : {}),
            },
          };
          const latencyMax = num(row.latencyMsMax);
          if (latencyMax > 0) update.$max = { latencyMsMax: latencyMax };

          return {
            updateOne: {
              filter: {
                tenantId: row.tenantId,
                projectId: row.projectId ?? '',
                entityType: row.entityType,
                entityKey: row.entityKey,
                source: row.source,
                bucketMs: row.bucketMs,
              },
              update,
              upsert: true,
            },
          };
        });
        try {
          await coll.bulkWrite(ops, { ordered: false });
        } catch (error) {
          // Two flushers upserting the same brand-new bucket: the loser hits the
          // unique index (E11000). Retry just those ops once; they now match the
          // winner's document and apply as a plain $inc. Anything else rethrows.
          const writeErrors = (error as { writeErrors?: unknown })?.writeErrors;
          const list = (Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : []) as Array<{
            code?: number;
            index?: number;
          }>;
          if (
            !(error instanceof MongoBulkWriteError) ||
            list.length === 0 ||
            !list.every((e) => e.code === 11000 && typeof e.index === 'number')
          ) {
            throw error;
          }
          const retry = list.map((e) => ops[e.index as number]);
          await coll.bulkWrite(retry, { ordered: false });
        }
      }
    }

    async aggregateEntityMetrics(q: EntityMetricsAggregateQuery): Promise<IEntityMetricAggregate[]> {
      const db = this.getTenantDb();
      const match: Record<string, unknown> = {
        tenantId: q.tenantId,
        bucketMs: { $gte: q.fromMs, $lt: q.toMs },
      };
      if (q.projectId !== undefined) match.projectId = q.projectId;
      if (q.entityType) match.entityType = q.entityType;
      if (q.entityKeys) {
        if (q.entityKeys.length === 0) return [];
        match.entityKey = { $in: q.entityKeys.slice(0, MAX_ENTITY_KEYS) };
      }
      if (q.sources) {
        if (q.sources.length === 0) return [];
        match.source = { $in: q.sources };
      }

      const groupFields: string[] = GROUP_FIELDS.filter((f) => q.groupBy.includes(f));
      const groupId: Record<string, unknown> = {};
      for (const f of groupFields) groupId[f] = `$${f}`;
      let bucketed = false;
      if (q.bucketMs !== undefined) {
        const size = Math.max(
          ENTITY_METRIC_BUCKET_MS,
          Math.round(q.bucketMs / ENTITY_METRIC_BUCKET_MS) * ENTITY_METRIC_BUCKET_MS,
        );
        groupId.bucketMs = {
          $multiply: [{ $floor: { $divide: ['$bucketMs', size] } }, size],
        };
        bucketed = true;
      }

      const group: Record<string, unknown> = { _id: groupId };
      for (const field of ENTITY_METRIC_COUNTER_FIELDS) {
        group[field] = { $sum: { $ifNull: [`$${field}`, 0] } };
      }
      group.latencyMsMax = { $max: { $ifNull: ['$latencyMsMax', 0] } };

      const limit = Math.min(
        Math.max(Math.floor(num(q.limit) || DEFAULT_AGGREGATE_LIMIT), 1),
        MAX_AGGREGATE_LIMIT,
      );
      const sort: Record<string, 1 | -1> = bucketed ? { '_id.bucketMs': 1, requests: -1 } : { requests: -1 };

      const docs = await db
        .collection(COLLECTIONS.entityMetrics)
        .aggregate([{ $match: match }, { $group: group }, { $sort: sort }, { $limit: limit }])
        .toArray();

      return docs.map((doc) => {
        const out: Record<string, unknown> = {};
        const id = (doc._id ?? {}) as Record<string, unknown>;
        for (const f of groupFields) out[f] = id[f];
        if (bucketed) out.bucketMs = num(id.bucketMs);
        for (const field of ENTITY_METRIC_COUNTER_FIELDS) out[field] = num(doc[field]);
        out.latencyMsMax = num(doc.latencyMsMax);
        return out as unknown as IEntityMetricAggregate;
      });
    }

    async purgeEntityMetrics(input: { olderThanMs: number; batchSize?: number }): Promise<number> {
      const db = this.getTenantDb();
      const coll = db.collection(COLLECTIONS.entityMetrics);
      const batchSize = Math.min(Math.max(Math.floor(num(input.batchSize) || 1000), 1), 10_000);
      let total = 0;
      for (;;) {
        const ids = await coll
          .find({ bucketMs: { $lt: input.olderThanMs } }, { projection: { _id: 1 } })
          .limit(batchSize)
          .toArray();
        if (ids.length === 0) break;
        const res = await coll.deleteMany({ _id: { $in: ids.map((d) => d._id) } });
        total += res.deletedCount ?? 0;
        if (ids.length < batchSize) break;
      }
      return total;
    }
  };
}
