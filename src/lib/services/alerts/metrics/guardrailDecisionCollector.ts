/**
 * Guardrail DECISION metric collector.
 *
 * Aggregates the hook plane's verdicts over a rolling window:
 *   - guardrail_block_rate       ← % of decisions that were 'block'
 *   - guardrail_approval_rate    ← % that were 'require_approval' (see below)
 *   - guardrail_avg_risk_score   ← average riskScore (0–100)
 *   - guardrail_total_decisions  ← count
 *
 * An alert like `guardrail_block_rate > 20` fires when a guardrail starts
 * blocking a surge of calls — a runaway agent, or a policy change that was
 * broader than its author thought.
 *
 * ── WHY THIS IS SEPARATE FROM GuardrailCollector ───────────────────────────
 * That collector answers "how is the guardrail SERVICE doing" — fail rate,
 * latency, evaluation count — over every row in the table. This one answers
 * "what is the guardrail DECIDING", and its denominator is only the rows a hook
 * wrote. Folding them together would mean one of the two questions silently got
 * the other's population.
 *
 * ── THE SOURCE MOVED, THE METRIC IDs DID NOT ───────────────────────────────
 * These four used to be computed over `aegis_audit` by an enterprise-only
 * collector. That table is gone from the read path; the numbers now come from
 * `guardrail_evaluation_logs.decision` / `.riskScore`, which every guardrail
 * evaluation writes in both editions. The four `aegis_*` metric ids are still
 * claimed here, unchanged, because stored `IAlertRule` rows carry the metric
 * name in a column: dropping the old spelling would not migrate those rules, it
 * would make every one of them resolve to no collector and quietly report 0.
 *
 * ── 'require_approval' ─────────────────────────────────────────────────────
 * A vestigial rung. It has no store and no UI in the hook plane, so nothing
 * writes it and the rate is structurally 0. The metric is retained rather than
 * removed for exactly the reason above — an existing rule must keep resolving —
 * and it is computed honestly rather than hardcoded, so it starts reporting the
 * moment something does emit that decision.
 *
 * Supports SQLite and MongoDB.
 */

import { getTenantDatabase } from '@/lib/database';
import type { AlertMetric } from '@/lib/database';
import type { IMetricCollector, MetricQuery, MetricResult } from './types';
import { getRawDb } from './dbHelper';

const TABLE = 'guardrail_evaluation_logs';

/** Aggregates over the window, shared by both backends so the two arithmetic
 *  paths cannot drift. */
interface DecisionTotals {
  total: number;
  blocked: number;
  approvals: number;
  riskSum: number;
}

const EMPTY: MetricResult = { value: 0, sampleCount: 0 };

export class GuardrailDecisionCollector implements IMetricCollector {
  readonly supportedMetrics: AlertMetric[] = [
    'guardrail_block_rate',
    'guardrail_approval_rate',
    'guardrail_avg_risk_score',
    'guardrail_total_decisions',
    // @deprecated spellings — same numbers, same collector. See the header.
    'aegis_block_rate',
    'aegis_approval_rate',
    'aegis_avg_risk_score',
    'aegis_total_decisions',
  ];

  async collect(query: MetricQuery): Promise<MetricResult> {
    const db = await getTenantDatabase(query.tenantDbName);
    const raw = getRawDb(db);
    if (!raw) return EMPTY;

    const now = new Date();
    const from = new Date(now.getTime() - query.windowMinutes * 60 * 1000);

    const totals = raw.type === 'sqlite'
      ? this.collectSqlite(raw.db, query, from, now)
      : await this.collectMongo(raw.db, query, from, now);
    if (!totals) return EMPTY;

    return { value: this.value(query.metric, totals), sampleCount: totals.total };
  }

  // ── SQLite ─────────────────────────────────────────────────────────────

  private collectSqlite(
    db: { prepare(sql: string): { get(...p: unknown[]): unknown } },
    query: MetricQuery,
    from: Date,
    now: Date,
  ): DecisionTotals | null {
    // `decision IS NOT NULL` is the population, not an optimisation: every row
    // written before the hook plane has no decision, and counting those in the
    // denominator would dilute a block rate with evaluations that never had a
    // decision to report.
    const clauses: string[] = [
      'tenantId = @tenantId',
      'createdAt >= @from',
      'createdAt <= @to',
      'decision IS NOT NULL',
    ];
    const params: Record<string, unknown> = {
      tenantId: query.tenantId,
      from: from.toISOString(),
      to: now.toISOString(),
    };
    if (query.scope?.projectId) { clauses.push('projectId = @projectId'); params.projectId = query.scope.projectId; }
    if (query.scope?.guardrailKey) { clauses.push('guardrailKey = @guardrailKey'); params.guardrailKey = query.scope.guardrailKey; }

    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
               SUM(CASE WHEN decision = 'require_approval' THEN 1 ELSE 0 END) AS approvals,
               SUM(COALESCE(riskScore, 0)) AS riskSum
        FROM ${TABLE} WHERE ${clauses.join(' AND ')}
      `).get(params) as { total: number; blocked: number | null; approvals: number | null; riskSum: number | null } | undefined;
      return {
        total: row?.total ?? 0,
        blocked: row?.blocked ?? 0,
        approvals: row?.approvals ?? 0,
        riskSum: row?.riskSum ?? 0,
      };
    } catch {
      // A tenant DB that has not run the hook-plane migration yet has no
      // `decision` column, and `no such column` must read as "no decisions",
      // not as an alert evaluation that throws every minute.
      return null;
    }
  }

  // ── MongoDB ────────────────────────────────────────────────────────────

  private async collectMongo(
    tenantDb: import('mongodb').Db,
    query: MetricQuery,
    from: Date,
    now: Date,
  ): Promise<DecisionTotals> {
    const filter: Record<string, unknown> = {
      tenantId: query.tenantId,
      createdAt: { $gte: from, $lte: now },
      decision: { $exists: true, $ne: null },
    };
    if (query.scope?.projectId) filter.projectId = query.scope.projectId;
    if (query.scope?.guardrailKey) filter.guardrailKey = query.scope.guardrailKey;

    const [result] = await tenantDb.collection(TABLE).aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          blocked: { $sum: { $cond: [{ $eq: ['$decision', 'block'] }, 1, 0] } },
          approvals: { $sum: { $cond: [{ $eq: ['$decision', 'require_approval'] }, 1, 0] } },
          // `$ifNull` because a row can carry a decision without a score; a
          // missing field would otherwise make `$sum` skip it silently, which
          // is right, while `$avg` over the same field would change the
          // denominator — so the average is computed here, not by Mongo.
          riskSum: { $sum: { $ifNull: ['$riskScore', 0] } },
        },
      },
    ]).toArray();

    return {
      total: (result?.total as number) ?? 0,
      blocked: (result?.blocked as number) ?? 0,
      approvals: (result?.approvals as number) ?? 0,
      riskSum: (result?.riskSum as number) ?? 0,
    };
  }

  private value(metric: AlertMetric, totals: DecisionTotals): number {
    if (totals.total === 0) return 0;
    switch (metric) {
      case 'guardrail_block_rate':
      case 'aegis_block_rate':
        return (totals.blocked / totals.total) * 100;
      case 'guardrail_approval_rate':
      case 'aegis_approval_rate':
        return (totals.approvals / totals.total) * 100;
      case 'guardrail_avg_risk_score':
      case 'aegis_avg_risk_score':
        return totals.riskSum / totals.total;
      case 'guardrail_total_decisions':
      case 'aegis_total_decisions':
        return totals.total;
      default:
        return 0;
    }
  }
}
