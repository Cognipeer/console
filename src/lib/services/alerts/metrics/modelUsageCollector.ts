/**
 * Model usage metric collector.
 *
 * Queries `model_usage_logs` to compute error rate, latency, cost,
 * and request count metrics over a rolling time window.
 *
 * Supports both MongoDB and SQLite backends.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';

export class ModelUsageCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'error_rate',
    'avg_latency_ms',
    'p95_latency_ms',
    'total_cost',
    'total_requests',
  ];

  async collect(query: MetricQuery): Promise<MetricResult> {
    const db = await getTenantDatabase(query.tenantDbName);

    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);

    const raw = getRawDb(db);
    if (!raw) return { value: 0, sampleCount: 0 };

    if (raw.type === 'sqlite') {
      return this.collectSqlite(raw.db, query, from, now);
    }

    return this.collectMongo(raw.db, query, from, now);
  }

  // ── SQLite implementation ─────────────────────────────────────────

  private collectSqlite(
    db: { prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown } },
    query: MetricQuery,
    from: Date,
    now: Date,
  ): MetricResult {
    const clauses: string[] = ['tenantId = @tenantId', 'createdAt >= @from', 'createdAt <= @to'];
    const params: Record<string, unknown> = {
      tenantId: query.tenantId,
      from: from.toISOString(),
      to: now.toISOString(),
    };

    if (query.scope?.projectId) { clauses.push('projectId = @projectId'); params.projectId = query.scope.projectId; }
    if (query.scope?.modelKey) { clauses.push('modelKey = @modelKey'); params.modelKey = query.scope.modelKey; }

    const where = `WHERE ${clauses.join(' AND ')}`;

    switch (query.metric) {
      case 'error_rate': {
        const row = db.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
          FROM model_usage_logs ${where}
        `).get(params) as { total: number; errors: number } | undefined;
        const total = row?.total || 0;
        const errors = row?.errors || 0;
        return { value: total > 0 ? (errors / total) * 100 : 0, sampleCount: total };
      }

      case 'avg_latency_ms': {
        const row = db.prepare(`
          SELECT AVG(latencyMs) as avgLatency, COUNT(*) as count
          FROM model_usage_logs ${where} AND latencyMs IS NOT NULL
        `).get(params) as { avgLatency: number | null; count: number } | undefined;
        return {
          value: row?.avgLatency || 0,
          sampleCount: row?.count || 0,
        };
      }

      case 'p95_latency_ms': {
        // Count first, then pick the row at the 95th percentile offset
        const countRow = db.prepare(`
          SELECT COUNT(*) as count FROM model_usage_logs ${where} AND latencyMs IS NOT NULL
        `).get(params) as { count: number } | undefined;
        const count = countRow?.count || 0;
        if (count === 0) return { value: 0, sampleCount: 0 };

        const offset = Math.floor(0.95 * count);
        const p95Row = db.prepare(`
          SELECT latencyMs FROM model_usage_logs ${where} AND latencyMs IS NOT NULL
          ORDER BY latencyMs ASC LIMIT 1 OFFSET @offset
        `).get({ ...params, offset }) as { latencyMs: number } | undefined;
        return { value: p95Row?.latencyMs || 0, sampleCount: count };
      }

      case 'total_cost': {
        const row = db.prepare(`
          SELECT SUM(json_extract(pricingSnapshot, '$.totalCost')) as totalCost,
                 COUNT(*) as count
          FROM model_usage_logs ${where} AND pricingSnapshot IS NOT NULL
        `).get(params) as { totalCost: number | null; count: number } | undefined;
        return { value: row?.totalCost || 0, sampleCount: row?.count || 0 };
      }

      case 'total_requests': {
        const row = db.prepare(`
          SELECT COUNT(*) as count FROM model_usage_logs ${where}
        `).get(params) as { count: number } | undefined;
        const count = row?.count || 0;
        return { value: count, sampleCount: count };
      }

      default:
        return { value: 0, sampleCount: 0 };
    }
  }

  // ── MongoDB implementation ─────────────────────────────────────────

  private async collectMongo(
    tenantDb: import('mongodb').Db,
    query: MetricQuery,
    from: Date,
    now: Date,
  ): Promise<MetricResult> {
    const filter: Record<string, unknown> = {
      tenantId: query.tenantId,
      createdAt: { $gte: from, $lte: now },
    };

    if (query.scope?.projectId) filter.projectId = query.scope.projectId;
    if (query.scope?.modelKey) filter.modelKey = query.scope.modelKey;

    const collection = tenantDb.collection('model_usage_logs');

    switch (query.metric) {
      case 'error_rate': {
        const pipeline = [
          { $match: filter },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
            },
          },
        ];
        const [result] = await collection.aggregate(pipeline).toArray();
        const total = (result?.total as number) || 0;
        const errors = (result?.errors as number) || 0;
        return { value: total > 0 ? (errors / total) * 100 : 0, sampleCount: total };
      }

      case 'avg_latency_ms': {
        const pipeline = [
          { $match: { ...filter, latencyMs: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: null,
              avgLatency: { $avg: '$latencyMs' },
              count: { $sum: 1 },
            },
          },
        ];
        const [result] = await collection.aggregate(pipeline).toArray();
        return { value: (result?.avgLatency as number) || 0, sampleCount: (result?.count as number) || 0 };
      }

      case 'p95_latency_ms': {
        const pipeline = [
          { $match: { ...filter, latencyMs: { $exists: true, $ne: null } } },
          { $sort: { latencyMs: 1 as const } },
          {
            $group: {
              _id: null,
              latencies: { $push: '$latencyMs' },
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              count: 1,
              p95: {
                $arrayElemAt: [
                  '$latencies',
                  { $floor: { $multiply: [0.95, '$count'] } },
                ],
              },
            },
          },
        ];
        const [result] = await collection.aggregate(pipeline).toArray();
        return { value: (result?.p95 as number) || 0, sampleCount: (result?.count as number) || 0 };
      }

      case 'total_cost': {
        const pipeline = [
          { $match: filter },
          {
            $group: {
              _id: null,
              totalCost: { $sum: '$pricingSnapshot.totalCost' },
              count: { $sum: 1 },
            },
          },
        ];
        const [result] = await collection.aggregate(pipeline).toArray();
        return { value: (result?.totalCost as number) || 0, sampleCount: (result?.count as number) || 0 };
      }

      case 'total_requests': {
        const count = await collection.countDocuments(filter);
        return { value: count, sampleCount: count };
      }

      default:
        return { value: 0, sampleCount: 0 };
    }
  }
}
