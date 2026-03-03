/**
 * Guardrail metric collector.
 *
 * Queries `guardrail_evaluation_logs` to compute fail rate, latency,
 * and evaluation count metrics over a rolling time window.
 *
 * Supports both MongoDB and SQLite backends.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';

export class GuardrailCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'guardrail_fail_rate',
    'guardrail_avg_latency_ms',
    'guardrail_total_evaluations',
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
    const clauses: string[] = ['tenantId = @tenantId', 'createdAt >= @from', 'createdAt <= @to'];
    const params: Record<string, unknown> = {
      tenantId: query.tenantId,
      from: from.toISOString(),
      to: now.toISOString(),
    };

    if (query.scope?.projectId) { clauses.push('projectId = @projectId'); params.projectId = query.scope.projectId; }
    if (query.scope?.guardrailKey) { clauses.push('guardrailKey = @guardrailKey'); params.guardrailKey = query.scope.guardrailKey; }

    const where = `WHERE ${clauses.join(' AND ')}`;

    switch (query.metric) {
      case 'guardrail_fail_rate': {
        const row = db.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) as failed
          FROM guardrail_evaluation_logs ${where}
        `).get(params) as { total: number; failed: number } | undefined;
        const total = row?.total || 0;
        const failed = row?.failed || 0;
        return { value: total > 0 ? (failed / total) * 100 : 0, sampleCount: total };
      }

      case 'guardrail_avg_latency_ms': {
        const row = db.prepare(`
          SELECT AVG(latencyMs) as avgLatency, COUNT(*) as count
          FROM guardrail_evaluation_logs ${where} AND latencyMs IS NOT NULL
        `).get(params) as { avgLatency: number | null; count: number } | undefined;
        return { value: row?.avgLatency || 0, sampleCount: row?.count || 0 };
      }

      case 'guardrail_total_evaluations': {
        const row = db.prepare(`
          SELECT COUNT(*) as count FROM guardrail_evaluation_logs ${where}
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
    if (query.scope?.guardrailKey) filter.guardrailKey = query.scope.guardrailKey;

    const collection = tenantDb.collection('guardrail_evaluation_logs');

    switch (query.metric) {
      case 'guardrail_fail_rate': {
        const pipeline = [
          { $match: filter },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              failed: { $sum: { $cond: [{ $eq: ['$passed', false] }, 1, 0] } },
            },
          },
        ];
        const [result] = await collection.aggregate(pipeline).toArray();
        const total = (result?.total as number) || 0;
        const failed = (result?.failed as number) || 0;
        return { value: total > 0 ? (failed / total) * 100 : 0, sampleCount: total };
      }

      case 'guardrail_avg_latency_ms': {
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

      case 'guardrail_total_evaluations': {
        const count = await collection.countDocuments(filter);
        return { value: count, sampleCount: count };
      }

      default:
        return { value: 0, sampleCount: 0 };
    }
  }
}
