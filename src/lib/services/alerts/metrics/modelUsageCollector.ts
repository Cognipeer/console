/**
 * Model usage metric collector.
 *
 * Queries `model_usage_logs` to compute error rate, latency, cost,
 * and request count metrics over a rolling time window.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';

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

    // Build time range
    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);

    // Use aggregation to compute model usage metrics
    // We need to query model_usage_logs directly because the existing
    // `aggregateModelUsage` is scoped to a single modelKey.
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
    if (query.scope?.modelKey) {
      filter.modelKey = query.scope.modelKey;
    }

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
        return {
          value: total > 0 ? (errors / total) * 100 : 0,
          sampleCount: total,
        };
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
        return {
          value: (result?.avgLatency as number) || 0,
          sampleCount: (result?.count as number) || 0,
        };
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
        return {
          value: (result?.p95 as number) || 0,
          sampleCount: (result?.count as number) || 0,
        };
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
        return {
          value: (result?.totalCost as number) || 0,
          sampleCount: (result?.count as number) || 0,
        };
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
