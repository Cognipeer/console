/**
 * RAG metric collector.
 *
 * Queries `rag_query_logs` for latency and query count metrics,
 * and `rag_documents` for failed document count over a rolling window.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';

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

    const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb
      ? (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb()
      : null;

    if (!tenantDb) {
      return { value: 0, sampleCount: 0 };
    }

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
        return {
          value: (result?.avgLatency as number) || 0,
          sampleCount: (result?.count as number) || 0,
        };
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
