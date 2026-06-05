/**
 * Inference server metric collector.
 *
 * Queries `inference_server_metrics` to compute GPU cache usage and
 * request queue depth metrics over a rolling time window.
 *
 * Supports both MongoDB and SQLite backends.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';

export class InferenceServerCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'gpu_cache_usage',
    'request_queue_depth',
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
    db: { prepare(sql: string): { get(...p: unknown[]): unknown } },
    query: MetricQuery,
    from: Date,
    now: Date,
  ): MetricResult {
    const clauses: string[] = ['tenantId = @tenantId', 'timestamp >= @from', 'timestamp <= @to'];
    const params: Record<string, unknown> = {
      tenantId: query.tenantId,
      from: from.toISOString(),
      to: now.toISOString(),
    };

    if (query.scope?.serverKey) { clauses.push('serverKey = @serverKey'); params.serverKey = query.scope.serverKey; }

    const where = `WHERE ${clauses.join(' AND ')}`;

    switch (query.metric) {
      case 'gpu_cache_usage': {
        const row = db.prepare(`
          SELECT AVG(gpuCacheUsagePercent) as avgGpu, COUNT(*) as count
          FROM inference_server_metrics ${where}
          AND gpuCacheUsagePercent IS NOT NULL
        `).get(params) as { avgGpu: number | null; count: number } | undefined;
        return { value: row?.avgGpu || 0, sampleCount: row?.count || 0 };
      }

      case 'request_queue_depth': {
        const row = db.prepare(`
          SELECT AVG(numRequestsWaiting) as avgQueue, COUNT(*) as count
          FROM inference_server_metrics ${where}
          AND numRequestsWaiting IS NOT NULL
        `).get(params) as { avgQueue: number | null; count: number } | undefined;
        return { value: row?.avgQueue || 0, sampleCount: row?.count || 0 };
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
      timestamp: { $gte: from, $lte: now },
    };

    if (query.scope?.serverKey) filter.serverKey = query.scope.serverKey;

    const collection = tenantDb.collection('inference_server_metrics');

    switch (query.metric) {
      case 'gpu_cache_usage': {
        const pipeline = [
          { $match: filter },
          {
            $group: {
              _id: null,
              avgGpu: { $avg: '$gpuCacheUsagePercent' },
              count: { $sum: 1 },
            },
          },
        ];
        const [result] = await collection.aggregate(pipeline).toArray();
        return { value: (result?.avgGpu as number) || 0, sampleCount: (result?.count as number) || 0 };
      }

      case 'request_queue_depth': {
        const pipeline = [
          { $match: filter },
          {
            $group: {
              _id: null,
              avgQueue: { $avg: '$numRequestsWaiting' },
              count: { $sum: 1 },
            },
          },
        ];
        const [result] = await collection.aggregate(pipeline).toArray();
        return { value: (result?.avgQueue as number) || 0, sampleCount: (result?.count as number) || 0 };
      }

      default:
        return { value: 0, sampleCount: 0 };
    }
  }
}
