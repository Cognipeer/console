/**
 * Data layer of the IAM center "Audit" tab: filter model, request URLs and
 * tolerant parsers for
 *   GET /api/iam/audit?kind=denials|changes|monitor&from&to&principalType&principalId&service&limit&cursor
 *   GET /api/iam/audit/export   (same filters, text/csv)
 * Free of React and Next so it runs in the node test environment.
 */

import {
  asArray,
  asId,
  asRecord,
  asString,
  clampLimit,
  iamRequest,
  isPrincipalType,
  toIamApiError,
  type PrincipalType,
} from '../principals/client';

export const AUDIT_KINDS = ['denials', 'changes', 'monitor'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export function isAuditKind(v: unknown): v is AuditKind {
  return typeof v === 'string' && (AUDIT_KINDS as readonly string[]).includes(v);
}

const KIND_ALIASES: Record<string, AuditKind> = {
  denial: 'denials',
  denials: 'denials',
  denied: 'denials',
  change: 'changes',
  changes: 'changes',
  monitor: 'monitor',
};

/** `denials`, `changes`, `monitor` or a singular alias; null for anything else. */
export function parseAuditKind(v: unknown): AuditKind | null {
  return typeof v === 'string' ? (KIND_ALIASES[v.toLowerCase()] ?? null) : null;
}

// ── filters ───────────────────────────────────────────────────────────────

export interface AuditFilters {
  kind: AuditKind;
  /** ISO timestamps (inclusive range). */
  from: string | null;
  to: string | null;
  principalType: PrincipalType | null;
  principalId: string | null;
  service: string | null;
}

/**
 * Who a view can be filtered by. Denials know the acting user or token (and the
 * members of a group); the monitor feed records a sample user or token; for a
 * policy change the principal filter means "who made the change", which is
 * always a user.
 */
export function auditPrincipalTypes(kind: AuditKind): readonly PrincipalType[] {
  if (kind === 'changes') return ['user'];
  if (kind === 'monitor') return ['user', 'token'];
  return ['user', 'token', 'group'];
}

/** Drops a principal the view cannot be filtered by (switching to another view keeps the rest of the filters). */
export function normalizeFiltersForKind(f: AuditFilters): AuditFilters {
  if (!f.principalType) return f;
  return auditPrincipalTypes(f.kind).includes(f.principalType) ? f : { ...f, principalType: null, principalId: null };
}

export function emptyAuditFilters(kind: AuditKind = 'denials'): AuditFilters {
  return { kind, from: null, to: null, principalType: null, principalId: null, service: null };
}

export function hasActiveFilters(f: AuditFilters): boolean {
  return Boolean(f.from || f.to || f.principalId || f.service);
}

function validIso(v: string | null): string | null {
  if (!v) return null;
  return Number.isNaN(new Date(v).getTime()) ? null : v;
}

interface ParamSource {
  get(name: string): string | null;
}

/** Filters carried by the address bar (`?tab=audit&kind=…&principalType=…&principalId=…&service=…&from=…&to=…`). */
export function auditFiltersFromParams(params: ParamSource): AuditFilters {
  const principalType = params.get('principalType');
  const principalId = params.get('principalId');
  const hasPrincipal = isPrincipalType(principalType) && Boolean(principalId);
  return normalizeFiltersForKind({
    kind: parseAuditKind(params.get('kind')) ?? 'denials',
    from: validIso(params.get('from')),
    to: validIso(params.get('to')),
    principalType: hasPrincipal ? principalType : null,
    principalId: hasPrincipal ? principalId : null,
    service: params.get('service') || null,
  });
}

/** A stable key of the filters (pager reset, effect dependencies). */
export function auditFiltersKey(f: AuditFilters): string {
  return [f.kind, f.from ?? '', f.to ?? '', f.principalType ?? '', f.principalId ?? '', f.service ?? ''].join('\u0000');
}

function filterParams(f: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set('kind', f.kind);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  // A principal is only meaningful as a (type, id) pair.
  if (f.principalType && f.principalId) {
    params.set('principalType', f.principalType);
    params.set('principalId', f.principalId);
  }
  if (f.service) params.set('service', f.service);
  return params;
}

export function auditListUrl(f: AuditFilters, page: { limit?: number; cursor?: string | null } = {}): string {
  const params = filterParams(f);
  params.set('limit', String(clampLimit(page.limit)));
  if (page.cursor) params.set('cursor', page.cursor);
  return `/api/iam/audit?${params.toString()}`;
}

/** The export endpoint takes the same filters and no paging. */
export function auditExportUrl(f: AuditFilters): string {
  return `/api/iam/audit/export?${filterParams(f).toString()}`;
}

// ── date range ────────────────────────────────────────────────────────────

export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Inclusive end of the local day, so a single-day range covers that whole day. */
export function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

/** The ISO bounds of a picked local date range. */
export function rangeToIso(range: readonly [Date | null, Date | null]): { from: string | null; to: string | null } {
  const [start, end] = range;
  return {
    from: start ? startOfDay(start).toISOString() : null,
    to: end ? endOfDay(end).toISOString() : null,
  };
}

/** The inverse, for showing the active range in the picker. */
export function isoToRange(from: string | null, to: string | null): [Date | null, Date | null] {
  const parse = (v: string | null) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return [parse(from), parse(to)];
}

/** `YYYY-MM-DD` in local time (the value format of the Mantine date pickers). */
export function toYmd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** [today - (days - 1), today] as picker values; `days = 1` is "today". */
export function lastDaysRange(days: number, now: Date = new Date()): [string, string] {
  const start = new Date(now);
  start.setDate(start.getDate() - Math.max(0, days - 1));
  return [toYmd(start), toYmd(now)];
}

// ── items ─────────────────────────────────────────────────────────────────

export interface AuditPrincipal {
  /** Usually user | token | group; kept as sent so an unknown kind is still shown. */
  type: string;
  id: string;
  label: string;
}

export interface AuditItem {
  id: string;
  at: string | null;
  kind: AuditKind;
  principal: AuditPrincipal | null;
  /** Who made the change (policy changes). */
  actor: string | null;
  service: string;
  action: string;
  route: string | null;
  method: string | null;
  code: string | null;
  decisionId: string | null;
  policyId: string | null;
  summary: string;
  /** `summary` as data, so the tab can say it in the reader's language (see summaryText.ts); null for a server that sends none. */
  text: AuditText | null;
}

export interface AuditText {
  key: string;
  params: Record<string, string | number>;
}

function parseAuditText(raw: unknown): AuditText | null {
  const r = asRecord(raw);
  const key = asString(r.key);
  if (!key) return null;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(asRecord(r.params))) {
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) params[name] = value;
  }
  return { key, params };
}

export interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
  /** Why the answer may be incomplete (`group_members_truncated`, `paging_capped`). */
  warnings: string[];
}

function parseAuditPrincipal(raw: unknown): AuditPrincipal | null {
  const r = asRecord(raw);
  const id = asId(r.id);
  if (!id) return null;
  return { type: asString(r.type) ?? 'user', id, label: asString(r.label) ?? asString(r.name) ?? id };
}

function parseActor(raw: unknown): string | null {
  if (typeof raw === 'string') return asString(raw);
  const r = asRecord(raw);
  return asString(r.label) ?? asString(r.name) ?? asString(r.email) ?? asId(r.id) ?? asId(r.userId);
}

export function parseAuditItem(raw: unknown, index: number, fallbackKind: AuditKind): AuditItem {
  const r = asRecord(raw);
  const at = asString(r.at);
  return {
    id: asId(r.id) ?? `${fallbackKind}:${at ?? ''}:${index}`,
    at,
    kind: parseAuditKind(r.kind) ?? fallbackKind,
    principal: parseAuditPrincipal(r.principal),
    actor: parseActor(r.actor),
    service: asString(r.service) ?? '',
    action: asString(r.action) ?? '',
    route: asString(r.route),
    method: asString(r.method),
    code: asString(r.code),
    decisionId: asId(r.decisionId),
    policyId: asId(r.policyId),
    summary: asString(r.summary) ?? '',
    text: parseAuditText(r.text),
  };
}

export function parseAuditPage(raw: unknown, kind: AuditKind): AuditPage {
  const r = asRecord(raw);
  const items: AuditItem[] = [];
  const seen = new Set<string>();
  asArray(r.items).forEach((entry, index) => {
    // Anything that is not a record with at least one useful field would only render as a blank row.
    const rec = asRecord(entry);
    if (!asId(rec.id) && !asString(rec.at) && !asString(rec.summary) && !asString(rec.service)) return;
    const item = parseAuditItem(entry, index, kind);
    // A repeated id (a paging overlap) would collide as a React key.
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  });
  return {
    items,
    nextCursor: asString(r.nextCursor),
    warnings: asArray(r.warnings).map((w) => asString(w)).filter((w): w is string => !!w),
  };
}

export async function fetchAudit(
  filters: AuditFilters,
  page: { limit?: number; cursor?: string | null } = {},
  signal?: AbortSignal,
): Promise<AuditPage> {
  return parseAuditPage(await iamRequest(auditListUrl(filters, page), { signal }), filters.kind);
}

// ── deep links out of an audit row ────────────────────────────────────────

const LEVEL_ACTIONS = new Set(['read', 'write', 'admin']);

/**
 * The catalog action a request was checked against, for re-running the check.
 * A denial records it as the gate action (`models.write`); an older or leaner
 * source may give the required level (`write`) next to the service.
 */
export function catalogActionOf(item: Pick<AuditItem, 'service' | 'action'>): string | null {
  const { service, action } = item;
  if (action && service && action.startsWith(`${service}.`) && LEVEL_ACTIONS.has(action.slice(service.length + 1))) {
    return action;
  }
  if (service && LEVEL_ACTIONS.has(action)) return `${service}.${action}`;
  return null;
}

/**
 * The part of a recorded action worth showing under the service name:
 * `models.write` under "Model Hub" is just `write`; `agent.invoke` (a resource
 * action) and `iam.policy.create` (a change event) stay whole.
 */
export function actionLabelKey(item: Pick<AuditItem, 'service' | 'action'>): string {
  const { service, action } = item;
  return service && action.startsWith(`${service}.`) ? action.slice(service.length + 1) : action;
}

// ── CSV export ────────────────────────────────────────────────────────────

/** `filename` from a Content-Disposition header (plain or RFC 5987 form). */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:[\w-]+'[^']*')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

export function defaultExportFilename(kind: AuditKind, now: Date = new Date()): string {
  return `iam-audit-${kind}-${toYmd(now)}.csv`;
}

export interface CsvDownload {
  blob: Blob;
  filename: string;
  /** The server stopped at its row cap (the file says so too). */
  truncated: boolean;
}

export async function downloadAuditCsv(filters: AuditFilters): Promise<CsvDownload> {
  const res = await fetch(auditExportUrl(filters), { cache: 'no-store' });
  if (!res.ok) throw await toIamApiError(res);
  const blob = await res.blob();
  return {
    blob,
    filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? defaultExportFilename(filters.kind),
    truncated: res.headers.get('x-export-truncated') === 'true',
  };
}

/** Hands a downloaded file to the browser. */
export function saveBlob(download: CsvDownload): void {
  const url = URL.createObjectURL(download.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
