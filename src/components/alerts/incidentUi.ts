/**
 * Incident presentation rules shared by the list, the detail page and the overview card.
 * Pure: the status lifecycle mirrors `STATUS_TRANSITIONS` in the incident service.
 */

import { formatMetricValue, metricUnit, operatorSymbol, type AlertCatalog, type TFn } from './alertCatalog';
import type { AlertConditionMode, IncidentDto, IncidentSeverity, IncidentStatus } from './alertTypes';
import { pluralKey } from './plural';

export const INCIDENT_STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'investigating', 'resolved', 'closed'];
export const INCIDENT_SEVERITIES: IncidentSeverity[] = ['critical', 'warning', 'info'];

/** Which status an incident may move to from each status (the server answers 409 for anything else). */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['acknowledged', 'investigating', 'resolved', 'closed'],
  acknowledged: ['investigating', 'resolved', 'closed'],
  investigating: ['resolved', 'closed'],
  resolved: ['closed', 'open'],
  closed: ['open'],
};

export type BulkAction = 'acknowledge' | 'resolve' | 'close' | 'assign' | 'snooze' | 'unsnooze' | 'reopen';
/** The plain status-transition bulk actions (the inbox's original bulk bar). */
export const BULK_ACTIONS: BulkAction[] = ['acknowledge', 'resolve', 'close'];
/** Every bulk action the server accepts (`POST /alerts/incidents/bulk`). */
export const ALL_BULK_ACTIONS: BulkAction[] = ['acknowledge', 'resolve', 'close', 'assign', 'snooze', 'unsnooze', 'reopen'];

const BULK_TARGET: Partial<Record<BulkAction, IncidentStatus>> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  close: 'closed',
};

/** Statuses bulk reopen takes (mirrors `REOPENABLE_STATUSES` in the incident service). */
const REOPENABLE: IncidentStatus[] = ['acknowledged', 'investigating', 'resolved', 'closed'];
/** Statuses a snooze applies to: the incident is still live (mirrors `SNOOZABLE_STATUSES`). */
const SNOOZABLE: IncidentStatus[] = ['open', 'acknowledged', 'investigating'];

/** A snooze is active while its end is in the future. */
export function isSnoozed(incident: Pick<IncidentDto, 'snoozedUntil'>, now: number = Date.now()): boolean {
  if (!incident.snoozedUntil) return false;
  const until = Date.parse(incident.snoozedUntil);
  return Number.isFinite(until) && until > now;
}

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The incidents of a selection a bulk action applies to (the rest would be refused by the server). */
export function bulkEligible(incidents: IncidentDto[], action: BulkAction, now: number = Date.now()): IncidentDto[] {
  switch (action) {
    case 'assign':
      return incidents;
    case 'snooze':
      return incidents.filter((incident) => SNOOZABLE.includes(incident.status));
    case 'unsnooze':
      return incidents.filter((incident) => isSnoozed(incident, now));
    case 'reopen':
      return incidents.filter((incident) => REOPENABLE.includes(incident.status));
    default: {
      const target = BULK_TARGET[action] as IncidentStatus;
      return incidents.filter((incident) => canTransition(incident.status, target));
    }
  }
}

export function isOpenStatus(status: IncidentStatus): boolean {
  return status === 'open' || status === 'acknowledged' || status === 'investigating';
}

export function statusBadgeClass(status: IncidentStatus): string {
  switch (status) {
    case 'open':
      return 'ds-badge ds-badge-err';
    case 'acknowledged':
      return 'ds-badge ds-badge-info';
    case 'investigating':
      return 'ds-badge ds-badge-warn';
    case 'resolved':
      return 'ds-badge ds-badge-ok';
    default:
      return 'ds-badge';
  }
}

export function severityBadgeClass(severity: IncidentSeverity): string {
  switch (severity) {
    case 'critical':
      return 'ds-badge ds-badge-err';
    case 'warning':
      return 'ds-badge ds-badge-warn';
    default:
      return 'ds-badge ds-badge-info';
  }
}

/** Sort key: worst first. */
export function severityRank(severity: IncidentSeverity): number {
  return severity === 'critical' ? 0 : severity === 'warning' ? 1 : 2;
}

/** The `PATCH /alerts/incidents/:id` verb of a transition. */
export function statusActionKey(status: IncidentStatus, current: IncidentStatus): string {
  if (status === 'open' && (current === 'resolved' || current === 'closed')) return 'reopen';
  switch (status) {
    case 'acknowledged':
      return 'acknowledge';
    case 'investigating':
      return 'investigate';
    case 'resolved':
      return 'resolve';
    case 'closed':
      return 'close';
    default:
      return 'reopen';
  }
}

/** Who resolved an incident: the system (auto-resolve) or a user id. */
export function resolvedBySystem(incident: Pick<IncidentDto, 'autoResolved' | 'resolvedBy'>): boolean {
  return Boolean(incident.autoResolved) || incident.resolvedBy === 'system';
}

export interface TimelineEntry {
  kind: 'fired' | 'acknowledged' | 'resolved' | 'closed' | 'note';
  at: string;
  /** Acting user id (or 'system'); the author name for a note. */
  by?: string | null;
  /** The server-resolved name of `by`, when it sent one. */
  byName?: string | null;
  /** Resolved by the system (auto-resolve), not by a person. */
  system?: boolean;
  content?: string;
}

/** Fired, acknowledged, resolved, closed and every note, oldest first. */
export function timelineEntries(incident: IncidentDto): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ kind: 'fired', at: incident.firedAt }];
  if (incident.acknowledgedAt) entries.push({ kind: 'acknowledged', at: incident.acknowledgedAt, by: incident.acknowledgedBy ?? null, byName: incident.acknowledgedByName ?? null });
  if (incident.resolvedAt) {
    entries.push({ kind: 'resolved', at: incident.resolvedAt, by: incident.resolvedBy ?? null, byName: incident.resolvedByName ?? null, system: resolvedBySystem(incident) });
  }
  if (incident.closedAt) entries.push({ kind: 'closed', at: incident.closedAt });
  for (const note of incident.notes ?? []) {
    entries.push({ kind: 'note', at: note.createdAt, by: note.userName, content: note.content });
  }
  return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ── Condition mode of a row ─────────────────────────────────────────────────

const CONDITION_MODES: AlertConditionMode[] = ['threshold', 'baseline', 'absence', 'slo_burn'];

/**
 * The condition type an incident or alert event was raised by: the context the incident captured,
 * then the event metadata the evaluator wrote, then `threshold` (rows from before the modes existed).
 * Absence and SLO-burn rows carry a request count and a placeholder threshold, so the screens must
 * not print them as "value vs limit".
 */
export function rowMode(row: {
  context?: { mode?: string } | null;
  metadata?: Record<string, unknown>;
}): AlertConditionMode {
  const candidate = row.context?.mode ?? (typeof row.metadata?.mode === 'string' ? row.metadata.mode : undefined);
  return CONDITION_MODES.includes(candidate as AlertConditionMode) ? (candidate as AlertConditionMode) : 'threshold';
}

export interface RowValueText {
  value: string;
  /** The line under the value, or null when there is nothing meaningful to compare against. */
  compare: string | null;
}

/**
 * The value of an incident or event and what it is compared with, per condition type. `t` is the
 * `alerts` translator. An absence row stores a request count (not a metric value) and an SLO
 * row's limit is a burn rate, so neither can be printed as "value vs threshold".
 */
export function describeRowValue(
  row: {
    metric: string;
    actualValue: number;
    threshold: number;
    baselineValue?: number | null;
    context?: { mode?: string } | null;
    metadata?: Record<string, unknown>;
  },
  catalog: AlertCatalog,
  t: TFn,
  locale?: string,
): RowValueText {
  const mode = rowMode(row);
  const unit = metricUnit(catalog, row.metric);
  if (mode === 'absence') {
    return { value: t(pluralKey('rowValue.absenceValue', row.actualValue), { count: formatMetricValue(row.actualValue, '', locale) }), compare: t('rowValue.absenceCompare') };
  }
  const value = formatMetricValue(row.actualValue, unit, locale);
  if (mode === 'slo_burn') return { value, compare: t('rowValue.sloCompare') };
  if (row.baselineValue != null) {
    return { value, compare: t('rowValue.vsBaseline', { baseline: formatMetricValue(row.baselineValue, unit, locale) }) };
  }
  if (mode === 'baseline') return { value, compare: null };
  const operator = row.metadata?.operator as string | undefined;
  return {
    value,
    compare: t('rowValue.vsThreshold', { operator: operatorSymbol(operator), threshold: formatMetricValue(row.threshold, unit, locale) }),
  };
}

// ── Server notes ────────────────────────────────────────────────────────────

const NOTE_PATTERNS: Array<{ pattern: RegExp; key: string; params?: (match: RegExpMatchArray) => Record<string, string> }> = [
  { pattern: /^Showing (\d+) of (\d+) entities$/, key: 'notes.showing', params: (m) => ({ shown: m[1]!, total: m[2]! }) },
  { pattern: /^No entity has data in the evaluation window yet$/, key: 'notes.noData' },
  { pattern: /^Only the (\d+) busiest entities are evaluated$/, key: 'notes.busiest', params: (m) => ({ count: m[1]! }) },
  { pattern: /^The (\w+) mode needs an enterprise licence$/, key: 'notes.modeLicense', params: (m) => ({ mode: m[1]! }) },
  { pattern: /^The (\w+) mode is not available in this edition$/, key: 'notes.modeBuild', params: (m) => ({ mode: m[1]! }) },
  { pattern: /^Unknown metric "(.*)"$/, key: 'notes.unknownMetric', params: (m) => ({ metric: m[1]! }) },
];

/**
 * The server writes its evaluation notes in English. The ones it is known to produce are shown
 * through the translations; any other text is dropped rather than shown untranslated (unless `keepUnknown`).
 */
export function translateServerNote(note: string, t: TFn, keepUnknown = false): string | null {
  for (const entry of NOTE_PATTERNS) {
    const match = note.match(entry.pattern);
    if (match) {
      const values = entry.params?.(match);
      if (values?.mode) values.mode = t(`mode.${values.mode}`);
      return t(entry.key, values);
    }
  }
  return keepUnknown ? note : null;
}

/** `keepUnknown`: show a note the server wrote that has no translation as it is (right for the English UI only). */
export function translateServerNotes(notes: string[] | undefined | null, t: TFn, keepUnknown = false): string[] {
  const out: string[] = [];
  for (const note of notes ?? []) {
    const translated = translateServerNote(note, t, keepUnknown);
    if (translated && !out.includes(translated)) out.push(translated);
  }
  return out;
}

// ── Links ───────────────────────────────────────────────────────────────────

/**
 * A link target the server produced for the UI. Only an in-app dashboard path is rendered as a
 * link: no scheme, no protocol-relative form (browsers read a backslash as a slash), no control
 * characters.
 */
export function internalPath(path: string | null | undefined): string | null {
  if (!path || !path.startsWith('/dashboard/')) return null;
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return null;
  }
  return path;
}
