/**
 * MCP metric collector.
 *
 * Queries `mcp_request_logs` to compute error rate, average latency,
 * and total request count metrics over a rolling time window.
 *
 * Supports both MongoDB and SQLite backends.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';

export class McpCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'mcp_error_rate',
    'mcp_avg_latency_ms',
    'mcp_total_requests',
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
    const clauses: string[] = ['createdAt >= @from', 'createdAt <= @to'];
    const params: Record<string, unknown> = {
      from: from.toISOString(),
      to: now.toISOString(),
    };

    if (query.scope?.mcpServerKey) {
      clauses.push('serverKey = @serverKey');
      params.serverKey = query.scope.mcpServerKey;
    }
    if (query.scope?.projectId) {
      clauses.push('projectId = @projectId');
      params.projectId = query.scope.projectId;
    }

    const where = `WHERE ${clauses.join(' AND ')}`;

    switch (query.metric) {
      case 'mcp_error_rate': {
        const row = db.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
          FROM mcp_request_logs ${where}
        `).get(params) as { total: number; errors: number } | undefined;
        const total = row?.total || 0;
        const errors = row?.errors || 0;
        return { value: total > 0 ? (errors / total) * 100 : 0, sampleCount: total };
      }

      case 'mcp_avg_latency_ms': {
        const row = db.prepare(`
          SELECT AVG(latencyMs) as avgLatency, COUNT(*) as count
          FROM mcp_request_logs ${where} AND latencyMs IS NOT NULL
        `).get(params) as { avgLatency: number | null; count: number } | undefined;
        return { value: row?.avgLatency || 0, sampleCount: row?.count || 0 };
      }

      case 'mcp_total_requests': {
        const row = db.prepare(`
          SELECT COUNT(*) as count FROM mcp_request_logs ${where}
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
      createdAt: { $gte: from, $lte: now },
    };

    if (query.scope?.mcpServerKey) filter.serverKey = query.scope.mcpServerKey;
    if (query.scope?.projectId) filter.projectId = query.scope.projectId;

    const collection = tenantDb.collection('mcp_request_logs');

    switch (query.metric) {
      case 'mcp_error_rate': {
        const [agg] = await collection
          .aggregate([
            { $match: filter },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
              },
            },
          ])
          .toArray();
        const total = agg?.total || 0;
        const errors = agg?.errors || 0;
        return { value: total > 0 ? (errors / total) * 100 : 0, sampleCount: total };
      }

      case 'mcp_avg_latency_ms': {
        const [agg] = await collection
          .aggregate([
            { $match: { ...filter, latencyMs: { $exists: true, $ne: null } } },
            {
              $group: {
                _id: null,
                avgLatency: { $avg: '$latencyMs' },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray();
        return { value: agg?.avgLatency || 0, sampleCount: agg?.count || 0 };
      }

      case 'mcp_total_requests': {
        const count = await collection.countDocuments(filter);
        return { value: count, sampleCount: count };
      }

      default:
        return { value: 0, sampleCount: 0 };
    }
  }
}
