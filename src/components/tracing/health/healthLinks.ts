/** Deep links the tracing health views build. Pure. */

import {
  applyDashboardDateFilterToSearchParams,
  type DashboardDateFilterState,
} from '@/lib/utils/dashboardDateFilter';

/** The alert rules list, which opens its create form on `?create=1`. */
export const ALERT_RULES_PATH = '/dashboard/alerts';

export const TRACING_AGENTS_PATH = '/dashboard/tracing/agents';

export interface CreateAlertLinkInput {
  /** Alert module of the rule (`agents`, `models`, `rag`, `mcp`, `tools`). */
  module: string;
  metric: string;
  entityType: string;
  entityKey: string;
}

/** Opens the alert rule form prefilled for one entity. */
export function buildCreateAlertHref(input: CreateAlertLinkInput): string {
  const params = new URLSearchParams();
  params.set('create', '1');
  params.set('module', input.module);
  params.set('metric', input.metric);
  params.set('entityType', input.entityType);
  params.set('entityKey', input.entityKey);
  return `${ALERT_RULES_PATH}?${params.toString()}`;
}

/** "Create alert" for an agent: its error rate, the metric people alert on first. */
export function buildCreateAgentAlertHref(agentName: string): string {
  return buildCreateAlertHref({
    module: 'agents',
    metric: 'agent_error_rate',
    entityType: 'agent',
    entityKey: agentName,
  });
}

/**
 * The incidents of the alert rules on one agent. Every status, not `open`: a firing rule keeps its incident
 * through acknowledged and investigating, which an `open` filter would hide.
 */
export function buildAgentIncidentsHref(agentName: string): string {
  const params = new URLSearchParams();
  params.set('status', 'all');
  params.set('module', 'agents');
  params.set('entityKey', agentName);
  return `/dashboard/alerts/incidents?${params.toString()}`;
}

/** The sessions list narrowed to an agent's failed sessions in a time range. */
export function buildFailingSessionsHref(
  agentName: string,
  range?: { fromMs: number; toMs: number } | null,
): string {
  const params = new URLSearchParams();
  params.set('agent', agentName);
  params.set('status', 'error');
  if (range && Number.isFinite(range.fromMs) && Number.isFinite(range.toMs)) {
    params.set('from', new Date(range.fromMs).toISOString());
    params.set('to', new Date(range.toMs).toISOString());
  }
  return `/dashboard/tracing/sessions?${params.toString()}`;
}

/** The agent page, carrying the date filter of the list it was opened from. */
export function buildAgentDetailHref(agentName: string, filter?: DashboardDateFilterState | null): string {
  const base = `${TRACING_AGENTS_PATH}/${encodeURIComponent(agentName)}`;
  if (!filter) return base;
  const params = new URLSearchParams();
  // The list's default period is not in its URL, so it is always written out for the page that follows.
  applyDashboardDateFilterToSearchParams(filter, params);
  if (filter.period === 'total') params.set('period', 'total');
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
