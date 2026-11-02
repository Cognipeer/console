import { applyDashboardDateFilterToSearchParams } from '@/lib/utils/dashboardDateFilter';

/** Lead-in before `firedAt` when the rule does not say how long its detection window is. */
const DEFAULT_LEAD_MINUTES = 30;
const MAX_LEAD_MINUTES = 24 * 60;
/** A little after the end, so sessions that were still running when it resolved are included. */
const TRAIL_MINUTES = 5;
const MINUTE_MS = 60_000;

export interface InvestigateWindow {
  from: Date;
  to: Date;
}

/**
 * The period worth looking at for an incident: from one detection window before it fired
 * until it resolved or closed (or until now, while it is still going).
 */
export function investigateWindow(
  incident: { firedAt: string; resolvedAt?: string | null; closedAt?: string | null },
  windowMinutes: number | undefined,
  now: Date = new Date(),
): InvestigateWindow | null {
  const fired = Date.parse(incident.firedAt);
  if (!Number.isFinite(fired)) return null;
  const lead = Math.min(Math.max(windowMinutes && windowMinutes > 0 ? windowMinutes : DEFAULT_LEAD_MINUTES, 1), MAX_LEAD_MINUTES);
  const endedRaw = Date.parse(incident.resolvedAt ?? incident.closedAt ?? '');
  const end = Number.isFinite(endedRaw) && endedRaw >= fired ? endedRaw : Math.max(now.getTime(), fired);
  return { from: new Date(fired - lead * MINUTE_MS), to: new Date(end + TRAIL_MINUTES * MINUTE_MS) };
}

/** `/dashboard/tracing/sessions` filtered to an agent (or all agents) over the window. */
export function sessionsHref(window: InvestigateWindow, options: { agent?: string; failedOnly?: boolean } = {}): string {
  const query = new URLSearchParams();
  if (options.agent) query.set('agent', options.agent);
  if (options.failedOnly) query.set('status', 'error');
  query.set('from', window.from.toISOString());
  query.set('to', window.to.toISOString());
  return `/dashboard/tracing/sessions?${query.toString()}`;
}

/**
 * A model's detail page on its Logs tab, over the window. The page's date filter works in whole days,
 * so the range covers the days the window touches.
 */
export function modelLogsHref(modelPath: string, window: InvestigateWindow): string {
  const query = new URLSearchParams();
  query.set('tab', 'logs');
  applyDashboardDateFilterToSearchParams({ period: 'custom', dateRange: [window.from, window.to] }, query);
  const separator = modelPath.includes('?') ? '&' : '?';
  return `${modelPath}${separator}${query.toString()}`;
}
