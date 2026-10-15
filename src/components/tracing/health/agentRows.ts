/**
 * Rows of the agents list: the health overview (`GET /tracing/agents/health`) joined with the agent
 * directory (`GET /tracing/agents`, which knows each agent's latest status), their sorting and filters. Pure.
 */

import type { HealthMetricValues } from './healthSeries';

export type AgentAlertPhase = 'firing' | 'pending' | null;
export type AgentAlertSeverity = 'critical' | 'warning' | 'info';

export interface AgentHealthApiRow {
  name: string;
  totals: HealthMetricValues;
  previous: HealthMetricValues | null;
  spark: { requests: number[]; errorRate: (number | null)[]; p95Ms: (number | null)[] };
  alert: { phase: AgentAlertPhase; severity?: AgentAlertSeverity; incidentId?: string };
}

export interface AgentDirectoryApiRow {
  name: string;
  sessionsCount: number;
  latestSessionAt: string | null;
  latestStatus: string | null;
}

export interface AgentListRow {
  name: string;
  /** Null for an agent the directory knows but the health rollup has nothing for in this period. */
  totals: HealthMetricValues | null;
  previous: HealthMetricValues | null;
  spark: AgentHealthApiRow['spark'] | null;
  alert: AgentHealthApiRow['alert'];
  latestStatus: string | null;
  latestSessionAt: string | null;
}

export type AgentSortKey =
  | 'name'
  | 'health'
  | 'sessions'
  | 'errorRate'
  | 'p95Ms'
  | 'toolErrorRate'
  | 'cost'
  | 'lastStatus';

export type SortDirection = 'asc' | 'desc';

const NO_ALERT: AgentHealthApiRow['alert'] = { phase: null };

/** Health rows first (in the order the API gave them), then agents only the directory knows. */
export function mergeAgentRows(
  health: AgentHealthApiRow[],
  directory: AgentDirectoryApiRow[] | null,
): AgentListRow[] {
  const known = new Map((directory ?? []).map((agent) => [agent.name, agent]));
  const rows: AgentListRow[] = health.map((agent) => {
    const entry = known.get(agent.name);
    return {
      name: agent.name,
      totals: agent.totals,
      previous: agent.previous,
      spark: agent.spark,
      alert: agent.alert ?? NO_ALERT,
      latestStatus: entry?.latestStatus ?? null,
      latestSessionAt: entry?.latestSessionAt ?? null,
    };
  });
  const present = new Set(health.map((agent) => agent.name));
  for (const agent of directory ?? []) {
    if (present.has(agent.name)) continue;
    rows.push({
      name: agent.name,
      totals: null,
      previous: null,
      spark: null,
      alert: NO_ALERT,
      latestStatus: agent.latestStatus,
      latestSessionAt: agent.latestSessionAt,
    });
  }
  return rows;
}

const SEVERITY_WEIGHT: Record<AgentAlertSeverity, number> = { critical: 3, warning: 2, info: 1 };

/** Higher is more urgent: firing by severity, then pending, then nothing. */
export function healthRank(alert: AgentHealthApiRow['alert'] | undefined): number {
  if (!alert || !alert.phase) return 0;
  if (alert.phase === 'pending') return 1;
  return 10 + (alert.severity ? SEVERITY_WEIGHT[alert.severity] : 0);
}

/**
 * The error rate is worth a red flag when it is above 5% AND has grown by half against the previous period
 * (SPEC 6.2). Without a previous error rate there is nothing to compare with, so a new agent is not flagged.
 */
export function isErrorRateElevated(totals: HealthMetricValues | null, previous: HealthMetricValues | null): boolean {
  const current = totals?.errorRate;
  if (typeof current !== 'number' || !Number.isFinite(current) || current <= 5) return false;
  const before = previous?.errorRate;
  if (typeof before !== 'number' || !Number.isFinite(before)) return false;
  return current > before * 1.5;
}

function sortValue(row: AgentListRow, key: AgentSortKey): number | string | null {
  const totals = row.totals;
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  switch (key) {
    case 'name':
      return row.name.toLowerCase();
    case 'health':
      return healthRank(row.alert);
    case 'sessions':
      return totals ? num(totals.requests) : null;
    case 'errorRate':
      return totals ? num(totals.errorRate) : null;
    case 'p95Ms':
      return totals ? num(totals.p95Ms) : null;
    case 'toolErrorRate':
      return totals ? num(totals.toolErrorRate) : null;
    case 'cost':
      return totals ? num(totals.costUsd) : null;
    case 'lastStatus':
      return row.latestStatus ? row.latestStatus.toLowerCase() : null;
  }
}

/** Sorted copy; rows without a value go last whichever the direction. */
export function sortAgentRows(rows: AgentListRow[], key: AgentSortKey, direction: SortDirection): AgentListRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null && right === null) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    const order = typeof left === 'string' || typeof right === 'string'
      ? String(left).localeCompare(String(right))
      : left - right;
    return order !== 0 ? order * sign : a.name.localeCompare(b.name);
  });
}

export type AgentHealthFilter = 'all' | 'firing' | 'pending' | 'ok';

export interface AgentRowFilters {
  query: string;
  /** `all`, or a normalized latest status (`success`, `error`, `in_progress`, `abandoned`). */
  status: string;
  health: AgentHealthFilter;
}

export function filterAgentRows(
  rows: AgentListRow[],
  filters: AgentRowFilters,
  normalizeStatus: (status: string | null) => string,
): AgentListRow[] {
  const q = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (q && !row.name.toLowerCase().includes(q)) return false;
    if (filters.status !== 'all' && normalizeStatus(row.latestStatus) !== filters.status) return false;
    if (filters.health === 'firing' && row.alert.phase !== 'firing') return false;
    if (filters.health === 'pending' && row.alert.phase !== 'pending') return false;
    if (filters.health === 'ok' && row.alert.phase !== null) return false;
    return true;
  });
}

/** Error-rate values of a sparkline with its gaps as zero, or null when fewer than two points have data. */
export function errorSpark(values: (number | null)[] | undefined): number[] | null {
  if (!Array.isArray(values)) return null;
  const present = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).length;
  if (present < 2) return null;
  return values.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0));
}
