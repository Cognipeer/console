/**
 * Red-team metric collector.
 *
 * Averages aggregate fields of completed `redteam_runs` over a rolling window:
 *   - redteam_attack_success_rate ← aggregate.attackSuccessRate
 *   - redteam_resilience_score    ← aggregate.resilienceScore
 * Both stored in [0,1] and returned as 0–100 percentages. Supports MongoDB and
 * SQLite. An alert rule like `redteam_attack_success_rate > 10` fires when a
 * scheduled scan regresses (the target newly complies with attacks).
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';
import { collectRunAggregate } from './runAggregateHelper';

const FIELD_BY_METRIC: Partial<Record<AlertMetric, string>> = {
  redteam_attack_success_rate: 'attackSuccessRate',
  redteam_resilience_score: 'resilienceScore',
};

export class RedTeamCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = ['redteam_attack_success_rate', 'redteam_resilience_score'];

  async collect(query: MetricQuery): Promise<MetricResult> {
    const field = FIELD_BY_METRIC[query.metric];
    if (!field) return { value: 0, sampleCount: 0 };

    const db = await getTenantDatabase(query.tenantDbName);
    const raw = getRawDb(db);
    if (!raw) return { value: 0, sampleCount: 0 };

    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);
    return collectRunAggregate(raw, 'redteam_runs', field, query, from, now);
  }
}
