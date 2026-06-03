/**
 * Analysis metric collector.
 *
 * Averages aggregate fields of completed `analysis_runs` over a rolling window:
 *   - analysis_pass_rate        ← aggregate.passRate
 *   - analysis_avg_judge_score  ← aggregate.avgJudgeScore
 *   - analysis_avg_accuracy     ← aggregate.avgExtractionAccuracy
 * All returned as 0–100 percentages. Supports MongoDB and SQLite.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';
import { collectRunAggregate } from './runAggregateHelper';

const FIELD_BY_METRIC: Partial<Record<AlertMetric, string>> = {
  analysis_pass_rate: 'passRate',
  analysis_avg_judge_score: 'avgJudgeScore',
  analysis_avg_accuracy: 'avgExtractionAccuracy',
};

export class AnalysisCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'analysis_pass_rate',
    'analysis_avg_judge_score',
    'analysis_avg_accuracy',
  ];

  async collect(query: MetricQuery): Promise<MetricResult> {
    const field = FIELD_BY_METRIC[query.metric];
    if (!field) return { value: 0, sampleCount: 0 };

    const db = await getTenantDatabase(query.tenantDbName);
    const raw = getRawDb(db);
    if (!raw) return { value: 0, sampleCount: 0 };

    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);
    return collectRunAggregate(raw, 'analysis_runs', field, query, from, now);
  }
}
