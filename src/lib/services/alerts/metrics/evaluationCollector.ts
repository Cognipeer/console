/**
 * Evaluation metric collector.
 *
 * Averages aggregate fields of completed `evaluation_runs` over a rolling
 * window:
 *   - evaluation_pass_rate  ← aggregate.passRate
 *   - evaluation_avg_score  ← aggregate.avgScore
 *   - evaluation_error_rate ← aggregate.errorRate (runs stored before the field
 *     existed derive it from failed / total)
 * All returned as 0–100 percentages. Supports MongoDB and SQLite.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb, type RawDb } from './dbHelper';
import { collectRunAggregate } from './runAggregateHelper';

const FIELD_BY_METRIC: Partial<Record<AlertMetric, string>> = {
  evaluation_pass_rate: 'passRate',
  evaluation_avg_score: 'avgScore',
};

/**
 * Average error rate (0–100) over completed runs in the window. `errorRate` is
 * absent on runs written before it existed, so fall back to failed / total per
 * run; a run with no items (total 0) has no rate and is not sampled.
 */
async function collectErrorRate(
  raw: RawDb,
  query: MetricQuery,
  from: Date,
  now: Date,
): Promise<MetricResult> {
  if (raw.type === 'sqlite') {
    const clauses = ['tenantId = @tenantId', 'createdAt >= @from', 'createdAt <= @to', "status = 'completed'"];
    const params: Record<string, unknown> = {
      tenantId: query.tenantId,
      from: from.toISOString(),
      to: now.toISOString(),
    };
    if (query.scope?.projectId) { clauses.push('projectId = @projectId'); params.projectId = query.scope.projectId; }
    const rate = `COALESCE(
      json_extract(aggregate, '$.errorRate'),
      CASE WHEN COALESCE(json_extract(aggregate, '$.total'), 0) > 0
        THEN 1.0 * COALESCE(json_extract(aggregate, '$.failed'), 0) / json_extract(aggregate, '$.total')
      END)`;
    const row = raw.db.prepare(
      `SELECT AVG(${rate}) as avgVal, COUNT(${rate}) as cnt
       FROM evaluation_runs WHERE ${clauses.join(' AND ')}`,
    ).get(params) as { avgVal: number | null; cnt: number } | undefined;
    return { value: (row?.avgVal ?? 0) * 100, sampleCount: row?.cnt ?? 0 };
  }

  const filter: Record<string, unknown> = {
    tenantId: query.tenantId,
    createdAt: { $gte: from, $lte: now },
    status: 'completed',
  };
  if (query.scope?.projectId) filter.projectId = query.scope.projectId;
  const rateExpr = {
    $ifNull: [
      '$aggregate.errorRate',
      {
        $cond: [
          { $gt: ['$aggregate.total', 0] },
          { $divide: [{ $ifNull: ['$aggregate.failed', 0] }, '$aggregate.total'] },
          null,
        ],
      },
    ],
  };
  const pipeline = [
    { $match: filter },
    { $project: { rate: rateExpr } },
    {
      $group: {
        _id: null,
        avgVal: { $avg: '$rate' },
        cnt: { $sum: { $cond: [{ $gt: ['$rate', null] }, 1, 0] } },
      },
    },
  ];
  const [result] = await raw.db.collection('evaluation_runs').aggregate(pipeline).toArray();
  return { value: ((result?.avgVal as number | null) ?? 0) * 100, sampleCount: (result?.cnt as number) ?? 0 };
}

export class EvaluationCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'evaluation_pass_rate',
    'evaluation_avg_score',
    'evaluation_error_rate',
  ];

  async collect(query: MetricQuery): Promise<MetricResult> {
    const isErrorRate = query.metric === 'evaluation_error_rate';
    const field = FIELD_BY_METRIC[query.metric];
    if (!field && !isErrorRate) return { value: 0, sampleCount: 0 };

    const db = await getTenantDatabase(query.tenantDbName);
    const raw = getRawDb(db);
    if (!raw) return { value: 0, sampleCount: 0 };

    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);
    if (isErrorRate) return collectErrorRate(raw, query, from, now);
    return collectRunAggregate(raw, 'evaluation_runs', field!, query, from, now);
  }
}
