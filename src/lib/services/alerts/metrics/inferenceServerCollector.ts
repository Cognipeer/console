/**
 * Inference server metric collector.
 *
 * Queries `inference_server_metrics` to compute GPU cache usage and
 * request queue depth metrics over a rolling time window.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';

export class InferenceServerCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'gpu_cache_usage',
    'request_queue_depth',
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
      timestamp: { $gte: from, $lte: now },
    };

    if (query.scope?.serverKey) {
      filter.serverKey = query.scope.serverKey;
    }

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
        return {
          value: (result?.avgGpu as number) || 0,
          sampleCount: (result?.count as number) || 0,
        };
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
        return {
          value: (result?.avgQueue as number) || 0,
          sampleCount: (result?.count as number) || 0,
        };
      }

      default:
        return { value: 0, sampleCount: 0 };
    }
  }
}
