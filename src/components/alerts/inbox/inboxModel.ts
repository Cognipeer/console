/**
 * View model of the incident inbox: the filter set carried in the URL, the built-in and saved views,
 * grouping of the loaded page, change detection for live refresh, snooze presets and the keyboard map.
 * Pure (storage and time are passed in) so it is unit-tested without a DOM.
 */

import { INCIDENT_SEVERITIES, INCIDENT_STATUSES, severityRank } from '../incidentUi';
import type { IncidentDto, IncidentSeverity, IncidentStatus } from '../alertTypes';

export type StatusTab = IncidentStatus | 'all';
export type InboxSort = 'firedAt' | '-firedAt' | 'updatedAt' | '-updatedAt' | 'severity' | '-severity';
export type InboxGroup = 'none' | 'rule' | 'entity';
export type StatsRange = '24h' | '7d' | '30d';

export const INBOX_SORTS: InboxSort[] = ['-firedAt', 'firedAt', '-updatedAt', 'updatedAt', '-severity', 'severity'];
export const INBOX_GROUPS: InboxGroup[] = ['none', 'rule', 'entity'];
export const STATS_RANGES: StatsRange[] = ['24h', '7d', '30d'];
export const DEFAULT_SORT: InboxSort = '-firedAt';

export interface InboxFilters {
  status: StatusTab;
  severity: '' | IncidentSeverity;
  module: string;
  ruleId: string;
  entityKey: string;
  q: string;
  /** '' = anyone, 'me', 'unassigned' or a user id. */
  assignee: string;
  sort: InboxSort;
  snoozed: '' | 'true' | 'false';
  group: InboxGroup;
}

export const DEFAULT_FILTERS: InboxFilters = {
  status: 'open',
  severity: '',
  module: '',
  ruleId: '',
  entityKey: '',
  q: '',
  assignee: '',
  sort: DEFAULT_SORT,
  snoozed: '',
  group: 'none',
};

/** What "clear the filters" resets: everything that narrows the list except the status tab, the sort and the grouping. */
export const FILTER_RESET = { q: '', severity: '', module: '', ruleId: '', entityKey: '', assignee: '', snoozed: '' } as const satisfies Partial<InboxFilters>;

/** Whether the list is narrowed beyond its status tab (a search, a severity, a module, a rule, an entity, an owner or a snooze state). */
export function hasActiveFilters(filters: InboxFilters): boolean {
  return (Object.keys(FILTER_RESET) as Array<keyof typeof FILTER_RESET>).some((key) => (key === 'q' ? filters.q.trim() !== '' : filters[key] !== FILTER_RESET[key]));
}

/** The incident preview sits beside the list only when the page has room for both; its pane is this wide. */
export const PREVIEW_PANE_WIDTH = 360;
/** Page width (not window width: the sidebar takes a third of a laptop screen) from which the preview may sit beside the list. */
export const SIDE_PREVIEW_MIN_WIDTH = 1080;
/** Columns the preview pane already shows, left out of the list while the pane sits beside it. */
export const PREVIEW_HIDDEN_COLUMNS: ReadonlySet<string> = new Set(['assignee', 'duration']);

export function columnsBesidePreview<T extends { key: string }>(columns: T[], sideBySide: boolean): T[] {
  return sideBySide ? columns.filter((column) => !PREVIEW_HIDDEN_COLUMNS.has(column.key)) : columns;
}

/** The keys that make up a view (grouping is presentation, not a filter). */
const VIEW_KEYS = ['status', 'severity', 'module', 'ruleId', 'entityKey', 'q', 'assignee', 'sort', 'snoozed'] as const;

export interface InboxView {
  id: string;
  /** Translation key under `incidents.views.builtin` for built-ins; the user's name for saved views. */
  name: string;
  builtin: boolean;
  filters: Partial<InboxFilters>;
}

export const BUILTIN_VIEWS: InboxView[] = [
  { id: 'open', name: 'open', builtin: true, filters: { status: 'open' } },
  { id: 'mine', name: 'mine', builtin: true, filters: { status: 'all', assignee: 'me', sort: '-updatedAt' } },
  { id: 'unassignedCritical', name: 'unassignedCritical', builtin: true, filters: { status: 'open', severity: 'critical', assignee: 'unassigned' } },
  { id: 'snoozed', name: 'snoozed', builtin: true, filters: { status: 'all', snoozed: 'true', sort: '-updatedAt' } },
  { id: 'recentlyResolved', name: 'recentlyResolved', builtin: true, filters: { status: 'resolved', sort: '-updatedAt' } },
];

function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

function hasFilterKeys(params: URLSearchParams): boolean {
  return [...VIEW_KEYS, 'highlight'].some((key) => params.has(key));
}

/** Read the inbox filters from a URL query. `?view=<builtin id>` seeds a built-in view when no raw filter is present. */
export function parseFilters(params: URLSearchParams): InboxFilters {
  const preset = !hasFilterKeys(params) ? BUILTIN_VIEWS.find((view) => view.id === params.get('view')) : undefined;
  const base: InboxFilters = { ...DEFAULT_FILTERS, ...(preset?.filters ?? {}) };
  if (!preset && params.get('highlight')) base.status = 'all';
  const status = params.get('status');
  const assignee = (params.get('assignee') ?? '').trim();
  return {
    status: status === 'all' ? 'all' : (oneOf(status, INCIDENT_STATUSES) ?? base.status),
    severity: oneOf(params.get('severity'), INCIDENT_SEVERITIES) ?? (params.has('severity') ? '' : base.severity),
    module: params.get('module') ?? base.module,
    ruleId: params.get('ruleId') ?? base.ruleId,
    entityKey: params.get('entityKey') ?? base.entityKey,
    q: (params.get('q') ?? base.q).slice(0, 200),
    assignee: assignee ? assignee.slice(0, 120) : params.has('assignee') ? '' : base.assignee,
    sort: oneOf(params.get('sort'), INBOX_SORTS) ?? base.sort,
    snoozed: oneOf(params.get('snoozed'), ['true', 'false'] as const) ?? (params.has('snoozed') ? '' : base.snoozed),
    group: oneOf(params.get('group'), INBOX_GROUPS) ?? base.group,
  };
}

/** The browser URL query of a filter set (status is always explicit; defaults of the rest are omitted). */
export function filtersToQuery(filters: InboxFilters, extra?: { range?: StatsRange; highlight?: string | null }): URLSearchParams {
  const params = new URLSearchParams();
  params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.module) params.set('module', filters.module);
  if (filters.ruleId) params.set('ruleId', filters.ruleId);
  if (filters.entityKey) params.set('entityKey', filters.entityKey);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  if (filters.snoozed) params.set('snoozed', filters.snoozed);
  if (filters.group !== 'none') params.set('group', filters.group);
  if (extra?.range && extra.range !== '24h') params.set('range', extra.range);
  if (extra?.highlight) params.set('highlight', extra.highlight);
  return params;
}

/** The `GET /alerts/incidents` query of a filter set and page. */
export function listQuery(filters: InboxFilters, page: number, pageSize: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.module) params.set('module', filters.module);
  if (filters.ruleId) params.set('ruleId', filters.ruleId);
  if (filters.entityKey) params.set('entityKey', filters.entityKey);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.assignee) params.set('assignee', filters.assignee);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  if (filters.snoozed) params.set('snoozed', filters.snoozed);
  params.set('limit', String(pageSize));
  params.set('skip', String((page - 1) * pageSize));
  return params;
}

export function statsRangeParam(value: string | null | undefined): StatsRange {
  return oneOf(value, STATS_RANGES) ?? '24h';
}

/** Whether two filter sets select the same incidents (grouping ignored). */
export function sameView(a: InboxFilters, b: InboxFilters): boolean {
  return VIEW_KEYS.every((key) => (a[key] ?? '') === (b[key] ?? ''));
}

export function viewFilters(view: InboxView): InboxFilters {
  return { ...DEFAULT_FILTERS, ...view.filters };
}

export function activeView(filters: InboxFilters, views: InboxView[]): InboxView | null {
  return views.find((view) => sameView(filters, viewFilters(view))) ?? null;
}

// ── Saved views (localStorage) ──────────────────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const MAX_SAVED_VIEWS = 20;

export function savedViewsKey(tenantKey: string, userId: string): string {
  return `alerts:views:${tenantKey}:${userId}`;
}

/** Stored views, tolerant of a missing, blocked or corrupted store. */
export function loadSavedViews(storage: StorageLike | null | undefined, key: string): InboxView[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: InboxView[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, name, query } = entry as { id?: unknown; name?: unknown; query?: unknown };
      if (typeof id !== 'string' || typeof name !== 'string' || typeof query !== 'string' || !name.trim()) continue;
      out.push({ id, name: name.slice(0, 60), builtin: false, filters: parseFilters(new URLSearchParams(query)) });
    }
    return out.slice(0, MAX_SAVED_VIEWS);
  } catch {
    return [];
  }
}

/** Returns false when the store refused the write. */
export function storeSavedViews(storage: StorageLike | null | undefined, key: string, views: InboxView[]): boolean {
  if (!storage) return false;
  try {
    const payload = views.slice(0, MAX_SAVED_VIEWS).map((view) => ({
      id: view.id,
      name: view.name,
      query: filtersToQuery(viewFilters(view)).toString(),
    }));
    storage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function newSavedView(name: string, filters: InboxFilters, id: string): InboxView {
  return { id, name: name.trim().slice(0, 60), builtin: false, filters: { ...filters, group: 'none' } };
}

// ── Live refresh ────────────────────────────────────────────────────────────

/** Signature of the parts of a row a user can see change. */
function rowSignature(incident: IncidentDto): string {
  return [incident.updatedAt ?? '', incident.status, incident.assignedTo ?? '', incident.snoozedUntil ?? '', incident.severity].join('|');
}

/** Ids of rows that are new or changed compared with the previous load (nothing on the first load). */
export function changedIds(previous: IncidentDto[] | null, next: IncidentDto[]): Set<string> {
  const out = new Set<string>();
  if (!previous || previous.length === 0) return out;
  const before = new Map(previous.map((incident) => [incident._id, rowSignature(incident)]));
  for (const incident of next) {
    const known = before.get(incident._id);
    if (known === undefined || known !== rowSignature(incident)) out.add(incident._id);
  }
  return out;
}

// ── Grouping ────────────────────────────────────────────────────────────────

export interface IncidentGroupModel {
  key: string;
  incidents: IncidentDto[];
  worstSeverity: IncidentSeverity;
  latestFiredAt: string;
  entityCount: number;
}

function groupKeyOf(incident: IncidentDto, by: Exclude<InboxGroup, 'none'>): string {
  return by === 'rule' ? incident.ruleId : `${incident.entityType ?? ''}:${incident.entityKey ?? ''}`;
}

/** Group the loaded rows by rule or entity: worst severity first, then the most recent firing. */
export function groupIncidents(incidents: IncidentDto[], by: Exclude<InboxGroup, 'none'>): IncidentGroupModel[] {
  const map = new Map<string, IncidentDto[]>();
  for (const incident of incidents) {
    const key = groupKeyOf(incident, by);
    const list = map.get(key);
    if (list) list.push(incident);
    else map.set(key, [incident]);
  }
  const groups: IncidentGroupModel[] = [...map.entries()].map(([key, rows]) => ({
    key,
    incidents: rows,
    worstSeverity: rows.reduce<IncidentSeverity>((worst, row) => (severityRank(row.severity) < severityRank(worst) ? row.severity : worst), 'info'),
    latestFiredAt: rows.reduce((latest, row) => (Date.parse(row.firedAt) > Date.parse(latest) ? row.firedAt : latest), rows[0]!.firedAt),
    entityCount: new Set(rows.map((row) => `${row.entityType ?? ''}:${row.entityKey ?? ''}`)).size,
  }));
  return groups.sort(
    (a, b) => severityRank(a.worstSeverity) - severityRank(b.worstSeverity) || Date.parse(b.latestFiredAt) - Date.parse(a.latestFiredAt),
  );
}

/** The rows in the order they are drawn (flat, or group after group). */
export function visibleOrder(incidents: IncidentDto[], by: InboxGroup, collapsed: ReadonlySet<string> = new Set()): IncidentDto[] {
  if (by === 'none') return incidents;
  return groupIncidents(incidents, by).flatMap((group) => (collapsed.has(group.key) ? [] : group.incidents));
}

// ── Snooze / mute presets ───────────────────────────────────────────────────

export const MAX_SNOOZE_MS = 30 * 24 * 3_600_000;

export type SnoozePreset = '1h' | '4h' | 'tomorrow';
export type MutePreset = '1h' | '4h' | '24h' | '7d';

export const SNOOZE_PRESETS: SnoozePreset[] = ['1h', '4h', 'tomorrow'];
export const MUTE_PRESETS: MutePreset[] = ['1h', '4h', '24h', '7d'];

/** End of a snooze preset; "tomorrow" is 09:00 local time on the next calendar day. */
export function snoozePresetUntil(preset: SnoozePreset, now: Date = new Date()): Date {
  if (preset === '1h') return new Date(now.getTime() + 3_600_000);
  if (preset === '4h') return new Date(now.getTime() + 4 * 3_600_000);
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

export function mutePresetUntil(preset: MutePreset, now: Date = new Date()): Date {
  const hours = preset === '1h' ? 1 : preset === '4h' ? 4 : preset === '24h' ? 24 : 168;
  return new Date(now.getTime() + hours * 3_600_000);
}

export type UntilCheck = 'ok' | 'invalid' | 'past' | 'tooFar';

/** The server refuses a past end, and one more than 30 days ahead; check before sending. */
export function checkUntil(value: Date | null, now: number = Date.now()): UntilCheck {
  if (!value || !Number.isFinite(value.getTime())) return 'invalid';
  const ms = value.getTime();
  if (ms <= now) return 'past';
  if (ms - now > MAX_SNOOZE_MS) return 'tooFar';
  return 'ok';
}

/** Value of a `datetime-local` input (local time, no zone) as a Date; null when empty or malformed. */
export function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  const date = new Date(y!, mo! - 1, d!, h!, mi!, 0, 0);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** A Date as the value of a `datetime-local` input. */
export function toLocalDateTimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── Durations ───────────────────────────────────────────────────────────────

/** Compact duration of a millisecond span (`—` without one): `<1m`, `42m`, `3h 5m`, `2d 4h`. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

// ── Keyboard ────────────────────────────────────────────────────────────────

export type ShortcutAction = 'next' | 'prev' | 'select' | 'acknowledge' | 'resolve' | 'snooze' | 'assignMe' | 'search' | 'open' | 'help' | 'escape';

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Tag name of the event target. */
  targetTag?: string;
  targetEditable?: boolean;
  targetRole?: string | null;
  /** `type` of an input target (a checkbox does not take typed text). */
  targetType?: string | null;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Whether the target of a key event is somewhere the user is typing (or operating a control that owns the key). */
export function isTypingTarget(event: Pick<KeyLike, 'targetTag' | 'targetEditable' | 'targetRole' | 'targetType'>): boolean {
  if (event.targetEditable) return true;
  if (event.targetTag?.toUpperCase() === 'INPUT' && ['checkbox', 'radio', 'button', 'submit'].includes((event.targetType ?? '').toLowerCase())) return false;
  if (event.targetTag && TYPING_TAGS.has(event.targetTag.toUpperCase())) return true;
  return event.targetRole === 'textbox' || event.targetRole === 'combobox' || event.targetRole === 'searchbox';
}

const KEY_MAP: Record<string, ShortcutAction> = {
  j: 'next',
  ArrowDown: 'next',
  k: 'prev',
  ArrowUp: 'prev',
  x: 'select',
  a: 'acknowledge',
  r: 'resolve',
  s: 'snooze',
  e: 'assignMe',
  '/': 'search',
  Enter: 'open',
  '?': 'help',
  Escape: 'escape',
};

/** The action of a key press, or null when it must be left alone (modifiers, typing, other keys). */
export function resolveShortcut(event: KeyLike): ShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const action = KEY_MAP[event.key];
  if (!action) return null;
  if (isTypingTarget(event) && action !== 'escape') return null;
  // Enter on a link or button belongs to that control (it activates it).
  if (action === 'open' && (event.targetTag === 'A' || event.targetTag === 'BUTTON')) return null;
  return action;
}

/** The id `delta` steps from `current` in `ids` (the first when nothing is focused; clamped at the ends). */
export function moveFocus(ids: string[], current: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const index = current ? ids.indexOf(current) : -1;
  if (index === -1) return ids[delta === 1 ? 0 : ids.length - 1]!;
  return ids[Math.max(0, Math.min(ids.length - 1, index + delta))]!;
}
