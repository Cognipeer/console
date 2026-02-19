/**
 * Guardrail metric collector.
 *
 * Queries `guardrail_evaluation_logs` to compute fail rate, latency,
 * and evaluation count metrics over a rolling time window.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';

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

    const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb
      ? (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb()
      : null;

    if (!tenantDb) {
      return { value: 0, sampleCount: 0 };
    }

    const filter: Record<string, unknown> = {
      tenantId: query.tenantId,
      createdAt: { $gte: from, $lte: now },
    };

    if (query.scope?.projectId) {
      filter.projectId = query.scope.projectId;
    }
    if (query.scope?.guardrailKey) {
      filter.guardrailKey = query.scope.guardrailKey;
    }

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
        return {
          value: total > 0 ? (failed / total) * 100 : 0,
          sampleCount: total,
        };
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
        return {
          value: (result?.avgLatency as number) || 0,
          sampleCount: (result?.count as number) || 0,
        };
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
