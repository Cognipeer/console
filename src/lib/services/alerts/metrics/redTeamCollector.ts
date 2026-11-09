/**
 * Red-team metric collector.
 *
 * Both metrics read the completed `redteam_runs` that finished inside the
 * rolling window (a run without a finish time counts at its creation time):
 *   - redteam_attack_success_rate ← sum(vulnerable) / sum(completed) × 100
 *   - redteam_resilience_score    ← 100 − attack success rate
 * Pooling attempts across the runs weights every attempt equally, where an
 * average of per-run rates would let a 5-attempt scan count as much as a
 * 200-attempt one. A run whose rates cannot be trusted (inconclusive, or no
 * attempt completed) is left out: it says nothing about the target. `sampleCount`
 * is the number of runs used; with none the metric has no data (value 0,
 * sampleCount 0), which the evaluator treats as "not enough data", never a breach.
 *
 * Supports MongoDB and SQLite. An alert rule like `redteam_attack_success_rate > 10`
 * fires when a scheduled scan regresses (the target newly complies with attacks).
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';

const METRICS: AlertMetric[] = ['redteam_attack_success_rate', 'redteam_resilience_score'];

interface RunAggregateFields {
  completed?: unknown;
  vulnerable?: unknown;
  attackSuccessRate?: unknown;
  inconclusive?: unknown;
}

function parseAggregate(value: unknown): RunAggregateFields | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as RunAggregateFields) : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as RunAggregateFields) : null;
}

/** The pooled attack success rate (0–100) over the runs that can be trusted, and how many runs that is. */
export function pooledAttackSuccess(aggregates: unknown[]): { rate: number; runs: number } {
  let vulnerable = 0;
  let completed = 0;
  let runs = 0;
  for (const raw of aggregates) {
    const agg = parseAggregate(raw);
    if (!agg) continue;
    // Stored before the lists existed, `inconclusive: true` meant judge errors: still untrusted.
    if (agg.inconclusive === true) continue;
    if (agg.attackSuccessRate === null) continue;
    const done = typeof agg.completed === 'number' ? agg.completed : 0;
    if (done <= 0) continue;
    completed += done;
    vulnerable += typeof agg.vulnerable === 'number' ? agg.vulnerable : 0;
    runs += 1;
  }
  return { rate: completed > 0 ? (vulnerable / completed) * 100 : 0, runs };
}

export class RedTeamCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = METRICS;

  async collect(query: MetricQuery): Promise<MetricResult> {
    if (!METRICS.includes(query.metric)) return { value: 0, sampleCount: 0 };

    const db = await getTenantDatabase(query.tenantDbName);
    const raw = getRawDb(db);
    if (!raw) return { value: 0, sampleCount: 0 };

    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);

    let aggregates: unknown[];
    if (raw.type === 'sqlite') {
      const when = 'COALESCE(finishedAt, createdAt)';
      const clauses = [
        'tenantId = @tenantId',
        "status = 'completed'",
        'aggregate IS NOT NULL',
        `${when} >= @from`,
        `${when} <= @to`,
      ];
      const params: Record<string, unknown> = {
        tenantId: query.tenantId,
        from: from.toISOString(),
        to: now.toISOString(),
      };
      if (query.scope?.projectId) {
        clauses.push('projectId = @projectId');
        params.projectId = query.scope.projectId;
      }
      const rows = raw.db
        .prepare(`SELECT aggregate FROM redteam_runs WHERE ${clauses.join(' AND ')}`)
        .all(params) as Array<{ aggregate: unknown }>;
      aggregates = rows.map((r) => r.aggregate);
    } else {
      const filter: Record<string, unknown> = {
        tenantId: query.tenantId,
        status: 'completed',
        // `finishedAt: null` also matches a run that has none; those count at their creation time.
        $or: [
          { finishedAt: { $gte: from, $lte: now } },
          { finishedAt: null, createdAt: { $gte: from, $lte: now } },
        ],
      };
      if (query.scope?.projectId) filter.projectId = query.scope.projectId;
      const docs = await raw.db
        .collection('redteam_runs')
        .find(filter, { projection: { aggregate: 1 } })
        .toArray();
      aggregates = docs.map((d) => (d as { aggregate?: unknown }).aggregate);
    }

    const { rate, runs } = pooledAttackSuccess(aggregates);
    if (runs === 0) return { value: 0, sampleCount: 0 };
    return {
      value: query.metric === 'redteam_attack_success_rate' ? rate : 100 - rate,
      sampleCount: runs,
    };
  }
}
