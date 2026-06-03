/**
 * Evaluation metric collector.
 *
 * Averages aggregate fields of completed `evaluation_runs` over a rolling
 * window:
 *   - evaluation_pass_rate  ← aggregate.passRate
 *   - evaluation_avg_score  ← aggregate.avgScore
 * Both returned as 0–100 percentages. Supports MongoDB and SQLite.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';
import { collectRunAggregate } from './runAggregateHelper';

const FIELD_BY_METRIC: Partial<Record<AlertMetric, string>> = {
  evaluation_pass_rate: 'passRate',
  evaluation_avg_score: 'avgScore',
};

export class EvaluationCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = ['evaluation_pass_rate', 'evaluation_avg_score'];

  async collect(query: MetricQuery): Promise<MetricResult> {
    const field = FIELD_BY_METRIC[query.metric];
    if (!field) return { value: 0, sampleCount: 0 };

    const db = await getTenantDatabase(query.tenantDbName);
    const raw = getRawDb(db);
    if (!raw) return { value: 0, sampleCount: 0 };

    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);
    return collectRunAggregate(raw, 'evaluation_runs', field, query, from, now);
  }
}
