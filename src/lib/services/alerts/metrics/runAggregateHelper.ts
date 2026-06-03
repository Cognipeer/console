/**
 * Shared helper for run-aggregate metric collectors (analysis & evaluation).
 *
 * Averages a numeric field of the persisted `aggregate` JSON across completed
 * runs within the time window, returning a 0–100 percentage. `table` and
 * `field` are fixed constants supplied by the collector (never user input).
 */

import type { MetricQuery, MetricResult } from './types';
import type { RawDb } from './dbHelper';

export async function collectRunAggregate(
  raw: RawDb,
  table: string,
  field: string,
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
    const where = `WHERE ${clauses.join(' AND ')}`;
    const row = raw.db.prepare(
      `SELECT AVG(json_extract(aggregate, '$.${field}')) as avgVal,
              COUNT(json_extract(aggregate, '$.${field}')) as cnt
       FROM ${table} ${where}`,
    ).get(params) as { avgVal: number | null; cnt: number } | undefined;
    return { value: (row?.avgVal ?? 0) * 100, sampleCount: row?.cnt ?? 0 };
  }

  const filter: Record<string, unknown> = {
    tenantId: query.tenantId,
    createdAt: { $gte: from, $lte: now },
    status: 'completed',
  };
  if (query.scope?.projectId) filter.projectId = query.scope.projectId;
  const fieldRef = `$aggregate.${field}`;
  const pipeline = [
    { $match: filter },
    {
      $group: {
        _id: null,
        avgVal: { $avg: fieldRef },
        cnt: { $sum: { $cond: [{ $gt: [fieldRef, null] }, 1, 0] } },
      },
    },
  ];
  const [result] = await raw.db.collection(table).aggregate(pipeline).toArray();
  return { value: ((result?.avgVal as number | null) ?? 0) * 100, sampleCount: (result?.cnt as number) ?? 0 };
}
