/**
 * SQLite Provider – Entity health rollup mixin
 *
 * Mirrors mongodb/entity-metrics.mixin.ts. `entity_metrics` holds one row per
 * (project, entity type, entity key, source, 5-minute bucket) with additive
 * counters and a latency histogram. Writes are single UPSERTs
 * (`c = c + excluded.c`) inside one transaction, so concurrent flushers never
 * lose increments.
 */

import {
  ENTITY_METRIC_BUCKET_MS,
  ENTITY_METRIC_COUNTER_FIELDS,
  type EntityMetricsAggregateQuery,
  type IEntityMetricAggregate,
  type IEntityMetricIncrement,
} from '../provider/types.base';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const CHUNK_SIZE = 500;
const DEFAULT_AGGREGATE_LIMIT = 10_000;
const MAX_AGGREGATE_LIMIT = 50_000;
const MAX_ENTITY_KEYS = 500;

const GROUP_COLUMNS = ['entityType', 'entityKey', 'source', 'projectId'] as const;

const INSERT_COLUMNS = [
  'id', 'tenantId', 'projectId', 'entityType', 'entityKey', 'source', 'bucketMs',
  'bucketStart', 'expiresAt',
  ...ENTITY_METRIC_COUNTER_FIELDS,
  'latencyMsMax',
  'updatedAt',
];

const UPSERT_SQL = `
  INSERT INTO ${TABLES.entityMetrics} (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map((c) => `@${c}`).join(', ')})
  ON CONFLICT(tenantId, projectId, entityType, entityKey, source, bucketMs) DO UPDATE SET
    ${ENTITY_METRIC_COUNTER_FIELDS.map((c) => `${c} = ${c} + excluded.${c}`).join(',\n    ')},
    latencyMsMax = MAX(latencyMsMax, excluded.latencyMsMax),
    updatedAt = excluded.updatedAt
`;

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function EntityMetricsMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class EntityMetricsOps extends Base {
    async incrementEntityMetrics(rows: IEntityMetricIncrement[]): Promise<void> {
      if (rows.length === 0) return;
      const db = this.getTenantDb();
      const stmt = db.prepare(UPSERT_SQL);
      const now = this.now();

      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        db.transaction(() => {
          for (const row of chunk) {
            const params: Record<string, unknown> = {
              id: this.newId(),
              tenantId: row.tenantId,
              projectId: row.projectId ?? '',
              entityType: row.entityType,
              entityKey: row.entityKey,
              source: row.source,
              bucketMs: row.bucketMs,
              bucketStart: new Date(row.bucketMs).toISOString(),
              expiresAt: row.expiresAtMs ? new Date(row.expiresAtMs).toISOString() : null,
              latencyMsMax: num(row.latencyMsMax),
              updatedAt: now,
            };
            for (const field of ENTITY_METRIC_COUNTER_FIELDS) {
              params[field] = num(row[field]);
            }
            stmt.run(params);
          }
        })();
      }
    }

    async aggregateEntityMetrics(q: EntityMetricsAggregateQuery): Promise<IEntityMetricAggregate[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId', 'bucketMs >= @fromMs', 'bucketMs < @toMs'];
      const params: Record<string, unknown> = {
        tenantId: q.tenantId,
        fromMs: q.fromMs,
        toMs: q.toMs,
      };
      if (q.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = q.projectId; }
      if (q.entityType) { clauses.push('entityType = @entityType'); params.entityType = q.entityType; }
      if (q.entityKeys) {
        if (q.entityKeys.length === 0) return [];
        const keys = q.entityKeys.slice(0, MAX_ENTITY_KEYS);
        const names = keys.map((k, i) => { params[`k${i}`] = k; return `@k${i}`; });
        clauses.push(`entityKey IN (${names.join(', ')})`);
      }
      if (q.sources) {
        if (q.sources.length === 0) return [];
        const names = q.sources.map((s, i) => { params[`s${i}`] = s; return `@s${i}`; });
        clauses.push(`source IN (${names.join(', ')})`);
      }

      const groupCols: string[] = GROUP_COLUMNS.filter((c) => q.groupBy.includes(c));
      const selects: string[] = [...groupCols];
      const groupExprs: string[] = [...groupCols];
      const orderBy: string[] = [];
      if (q.bucketMs !== undefined) {
        const size = Math.max(
          ENTITY_METRIC_BUCKET_MS,
          Math.round(q.bucketMs / ENTITY_METRIC_BUCKET_MS) * ENTITY_METRIC_BUCKET_MS,
        );
        params.size = size;
        // Both operands cast: a JS number may bind as REAL, which would turn the division into a float.
        const expr = '((CAST(bucketMs AS INTEGER) / CAST(@size AS INTEGER)) * CAST(@size AS INTEGER))';
        selects.push(`${expr} AS bucketMs`);
        groupExprs.push(expr);
        orderBy.push('bucketMs ASC');
      }
      orderBy.push('requests DESC');

      for (const field of ENTITY_METRIC_COUNTER_FIELDS) {
        selects.push(`SUM(${field}) AS ${field}`);
      }
      selects.push('MAX(latencyMsMax) AS latencyMsMax');

      const limit = Math.min(
        Math.max(Math.floor(num(q.limit) || DEFAULT_AGGREGATE_LIMIT), 1),
        MAX_AGGREGATE_LIMIT,
      );
      params.limit = limit;

      const sql = `
        SELECT ${selects.join(', ')}
        FROM ${TABLES.entityMetrics}
        WHERE ${clauses.join(' AND ')}
        ${groupExprs.length ? `GROUP BY ${groupExprs.join(', ')}` : ''}
        HAVING COUNT(*) > 0
        ORDER BY ${orderBy.join(', ')}
        LIMIT @limit
      `;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const col of groupCols) out[col] = r[col];
        if (q.bucketMs !== undefined) out.bucketMs = num(r.bucketMs);
        for (const field of ENTITY_METRIC_COUNTER_FIELDS) out[field] = num(r[field]);
        out.latencyMsMax = num(r.latencyMsMax);
        return out as unknown as IEntityMetricAggregate;
      });
    }

    async purgeEntityMetrics(input: { olderThanMs: number; batchSize?: number }): Promise<number> {
      const db = this.getTenantDb();
      const batchSize = Math.min(Math.max(Math.floor(num(input.batchSize) || 1000), 1), 10_000);
      const stmt = db.prepare(
        `DELETE FROM ${TABLES.entityMetrics} WHERE id IN (
           SELECT id FROM ${TABLES.entityMetrics} WHERE bucketMs < @olderThanMs LIMIT @batchSize
         )`,
      );
      let total = 0;
      for (;;) {
        const { changes } = stmt.run({ olderThanMs: input.olderThanMs, batchSize });
        total += changes;
        if (changes < batchSize) break;
      }
      return total;
    }
  };
}
