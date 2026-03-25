/**
 * RAG metric collector.
 *
 * Queries `rag_query_logs` for latency and query count metrics,
 * and `rag_documents` for failed document count over a rolling window.
 *
 * Supports both MongoDB and SQLite backends.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';

export class RagCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'rag_avg_latency_ms',
    'rag_total_queries',
    'rag_failed_documents',
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
    switch (query.metric) {
      case 'rag_avg_latency_ms': {
        const clauses: string[] = [
          'tenantId = @tenantId',
          'createdAt >= @from',
          'createdAt <= @to',
          'latencyMs IS NOT NULL',
        ];
        const params: Record<string, unknown> = {
          tenantId: query.tenantId,
          from: from.toISOString(),
          to: now.toISOString(),
        };
        if (query.scope?.projectId) { clauses.push('projectId = @projectId'); params.projectId = query.scope.projectId; }
        if (query.scope?.ragModuleKey) { clauses.push('ragModuleKey = @ragModuleKey'); params.ragModuleKey = query.scope.ragModuleKey; }

        const row = db.prepare(`
          SELECT AVG(latencyMs) as avgLatency, COUNT(*) as count
          FROM rag_query_logs WHERE ${clauses.join(' AND ')}
        `).get(params) as { avgLatency: number | null; count: number } | undefined;
        return { value: row?.avgLatency || 0, sampleCount: row?.count || 0 };
      }

      case 'rag_total_queries': {
        const clauses: string[] = ['tenantId = @tenantId', 'createdAt >= @from', 'createdAt <= @to'];
        const params: Record<string, unknown> = {
          tenantId: query.tenantId,
          from: from.toISOString(),
          to: now.toISOString(),
        };
        if (query.scope?.projectId) { clauses.push('projectId = @projectId'); params.projectId = query.scope.projectId; }
        if (query.scope?.ragModuleKey) { clauses.push('ragModuleKey = @ragModuleKey'); params.ragModuleKey = query.scope.ragModuleKey; }

        const row = db.prepare(`
          SELECT COUNT(*) as count FROM rag_query_logs WHERE ${clauses.join(' AND ')}
        `).get(params) as { count: number } | undefined;
        const count = row?.count || 0;
        return { value: count, sampleCount: count };
      }

      case 'rag_failed_documents': {
        const clauses: string[] = [
          'tenantId = @tenantId',
          "status = 'failed'",
          'updatedAt >= @from',
          'updatedAt <= @to',
        ];
        const params: Record<string, unknown> = {
          tenantId: query.tenantId,
          from: from.toISOString(),
          to: now.toISOString(),
        };
        if (query.scope?.projectId) { clauses.push('projectId = @projectId'); params.projectId = query.scope.projectId; }
        if (query.scope?.ragModuleKey) { clauses.push('ragModuleKey = @ragModuleKey'); params.ragModuleKey = query.scope.ragModuleKey; }

        const row = db.prepare(`
          SELECT COUNT(*) as count FROM rag_documents WHERE ${clauses.join(' AND ')}
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
    switch (query.metric) {
      case 'rag_avg_latency_ms': {
        const filter: Record<string, unknown> = {
          tenantId: query.tenantId,
          createdAt: { $gte: from, $lte: now },
          latencyMs: { $exists: true, $ne: null },
        };
        if (query.scope?.projectId) filter.projectId = query.scope.projectId;
        if (query.scope?.ragModuleKey) filter.ragModuleKey = query.scope.ragModuleKey;

        const pipeline = [
          { $match: filter },
          {
            $group: {
              _id: null,
              avgLatency: { $avg: '$latencyMs' },
              count: { $sum: 1 },
            },
          },
        ];
        const [result] = await tenantDb
          .collection('rag_query_logs')
          .aggregate(pipeline)
          .toArray();
        return { value: (result?.avgLatency as number) || 0, sampleCount: (result?.count as number) || 0 };
      }

      case 'rag_total_queries': {
        const filter: Record<string, unknown> = {
          tenantId: query.tenantId,
          createdAt: { $gte: from, $lte: now },
        };
        if (query.scope?.projectId) filter.projectId = query.scope.projectId;
        if (query.scope?.ragModuleKey) filter.ragModuleKey = query.scope.ragModuleKey;

        const count = await tenantDb
          .collection('rag_query_logs')
          .countDocuments(filter);
        return { value: count, sampleCount: count };
      }

      case 'rag_failed_documents': {
        const filter: Record<string, unknown> = {
          tenantId: query.tenantId,
          status: 'failed',
          updatedAt: { $gte: from, $lte: now },
        };
        if (query.scope?.projectId) filter.projectId = query.scope.projectId;
        if (query.scope?.ragModuleKey) filter.ragModuleKey = query.scope.ragModuleKey;

        const count = await tenantDb
          .collection('rag_documents')
          .countDocuments(filter);
        return { value: count, sampleCount: count };
      }

      default:
        return { value: 0, sampleCount: 0 };
    }
  }
}
