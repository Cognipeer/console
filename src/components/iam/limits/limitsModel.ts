/**
 * The Limits tab's data model (pure: no React, unit-tested in node).
 *
 * A "limit" is a quota policy as `GET /api/quota/policies?include=targets`
 * returns it: the policy plus the resolved name of whatever it points at.
 */
import {
  isTenantWideKind,
  quotaGroupMode,
  type QuotaDomain,
  type QuotaGroupMode,
  type QuotaLimits,
  type QuotaPolicy,
  type QuotaScope,
} from '@/lib/quota/types';

export interface LimitTarget {
  type: 'tenant' | 'group' | 'user' | 'token' | 'agent' | 'resource' | 'provider';
  id?: string;
  label?: string;
  sublabel?: string;
  /** The user / group / token / agent no longer exists, so the limit matches nobody. */
  missing?: boolean;
}

export interface LimitRow extends QuotaPolicy {
  target: LimitTarget;
  projectName?: string;
  projectKey?: string;
}

// ── parsing ──────────────────────────────────────────────────────────────

const TARGET_TYPES: ReadonlySet<string> = new Set(['tenant', 'group', 'user', 'token', 'agent', 'resource', 'provider']);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** One row of the API answer; undefined when it is not a usable policy. */
export function parseLimitRow(raw: unknown): LimitRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const policy = raw as Record<string, unknown>;
  const id = policy._id !== undefined && policy._id !== null ? String(policy._id) : undefined;
  const scope = str(policy.scope) as QuotaScope | undefined;
  const domain = str(policy.domain) as QuotaDomain | undefined;
  if (!id || !scope || !domain) return undefined;

  const rawTarget = (policy.target && typeof policy.target === 'object' ? policy.target : {}) as Record<string, unknown>;
  const targetType = str(rawTarget.type);
  const target: LimitTarget = {
    type: (targetType && TARGET_TYPES.has(targetType) ? targetType : scope === 'tenant' ? 'tenant' : scope) as LimitTarget['type'],
    ...(str(rawTarget.id) ?? str(policy.scopeId) ? { id: str(rawTarget.id) ?? str(policy.scopeId) } : {}),
    ...(str(rawTarget.label) ? { label: str(rawTarget.label) } : {}),
    ...(str(rawTarget.sublabel) ? { sublabel: str(rawTarget.sublabel) } : {}),
    ...(rawTarget.missing === true ? { missing: true } : {}),
  };

  return {
    ...(policy as unknown as QuotaPolicy),
    _id: id,
    scope,
    domain,
    priority: typeof policy.priority === 'number' ? policy.priority : 0,
    enabled: policy.enabled !== false,
    limits: (policy.limits && typeof policy.limits === 'object' ? policy.limits : {}) as QuotaLimits,
    projectId: str(policy.projectId),
    groupMode: scope === 'group' ? (policy.groupMode === 'shared' ? 'shared' : 'perMember') : undefined,
    target,
    projectName: str(policy.projectName),
    projectKey: str(policy.projectKey),
  };
}

export function parseLimitRows(body: unknown): LimitRow[] {
  const list = body && typeof body === 'object' ? (body as { policies?: unknown }).policies : undefined;
  return (Array.isArray(list) ? list : []).map(parseLimitRow).filter((row): row is LimitRow => row !== undefined);
}

// ── classification ───────────────────────────────────────────────────────

/**
 * A limit of an older kind with no project is never loaded by the guard (only
 * group and agent-run limits may be tenant-wide), so it limits nothing.
 */
export function isInertLimit(row: Pick<QuotaPolicy, 'scope' | 'domain' | 'projectId'>): boolean {
  return !row.projectId && !isTenantWideKind(row);
}

export function limitGroupMode(row: Pick<QuotaPolicy, 'scope' | 'groupMode'>): QuotaGroupMode | undefined {
  return quotaGroupMode(row);
}

export interface LimitStats {
  total: number;
  groupLimits: number;
  agentLimits: number;
  inert: number;
}

export function limitStats(rows: readonly LimitRow[]): LimitStats {
  return {
    total: rows.length,
    groupLimits: rows.filter((r) => r.scope === 'group').length,
    agentLimits: rows.filter((r) => r.domain === 'agent').length,
    inert: rows.filter(isInertLimit).length,
  };
}

// ── filtering ────────────────────────────────────────────────────────────

export interface LimitFilters {
  scope: QuotaScope | 'all';
  domain: QuotaDomain | 'all';
  query: string;
}

export const NO_FILTERS: LimitFilters = { scope: 'all', domain: 'all', query: '' };

/** What a search matches: the policy's name, what it points at (name, e-mail, id) and its project. */
export function limitSearchText(row: LimitRow): string {
  return [row.label, row.description, row.target.label, row.target.sublabel, row.target.id, row.projectName, row.projectKey]
    .filter(Boolean)
    .join(' ');
}

/** Case-insensitive match on `limitSearchText`, narrowed by scope and domain. */
export function filterLimitRows(rows: readonly LimitRow[], filters: LimitFilters): LimitRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.scope !== 'all' && row.scope !== filters.scope) return false;
    if (filters.domain !== 'all' && row.domain !== filters.domain) return false;
    return !query || limitSearchText(row).toLowerCase().includes(query);
  });
}

const SCOPE_ORDER: Record<QuotaScope, number> = { tenant: 0, group: 1, user: 2, token: 3, resource: 4, provider: 5 };

/** Broad to narrow (tenant, group, user, ...), then the most recently changed first. */
export function sortLimitRows(rows: readonly LimitRow[]): LimitRow[] {
  const time = (row: LimitRow) => (row.updatedAt ? new Date(row.updatedAt).getTime() || 0 : 0);
  return [...rows].sort(
    (a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9) || time(b) - time(a),
  );
}

// ── amounts (what a limit actually says) ─────────────────────────────────

export const RATE_KINDS = ['requests', 'tokens', 'vectors', 'files', 'storage'] as const;
export const RATE_WINDOWS = ['perSecond', 'perMinute', 'perHour', 'perDay', 'perMonth'] as const;

/** One number a limit sets, addressed by its path in `QuotaLimits`. */
export interface LimitAmount {
  /** e.g. `rateLimit.requests.perMinute`, `budget.dailySpendLimit`, `perRequest.maxInputTokens`. */
  path: string;
  group: 'rate' | 'budget' | 'perRequest' | 'quotas';
  /** `-1` is "unlimited". */
  value: number;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Every number the policy sets, rate limits first, then budget, per-request caps and resource caps. */
export function limitAmounts(limits: QuotaLimits | undefined): LimitAmount[] {
  const out: LimitAmount[] = [];
  for (const kind of RATE_KINDS) {
    const windows = limits?.rateLimit?.[kind];
    for (const window of RATE_WINDOWS) {
      const value = windows?.[window];
      if (finite(value)) out.push({ path: `rateLimit.${kind}.${window}`, group: 'rate', value });
    }
  }
  const budget = limits?.budget;
  if (finite(budget?.dailySpendLimit)) out.push({ path: 'budget.dailySpendLimit', group: 'budget', value: budget.dailySpendLimit });
  if (finite(budget?.monthlySpendLimit)) out.push({ path: 'budget.monthlySpendLimit', group: 'budget', value: budget.monthlySpendLimit });
  for (const [name, value] of Object.entries(limits?.perRequest ?? {})) {
    if (finite(value)) out.push({ path: `perRequest.${name}`, group: 'perRequest', value });
  }
  for (const [name, value] of Object.entries(limits?.quotas ?? {})) {
    if (finite(value)) out.push({ path: `quotas.${name}`, group: 'quotas', value });
  }
  return out;
}

/** `maxInputTokens` -> `Max input tokens`: the label for a number that has no translation of its own. */
export function humanizeKey(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MB = 1024 * 1024;

/** The number as a person reads it: `∞`, thousands separators, MB for byte sizes, seconds for milliseconds, `$` for spend. */
export function formatAmountValue(amount: LimitAmount, locale?: string): string {
  if (amount.value === -1) return '∞';
  const number = (n: number, digits = 2) => n.toLocaleString(locale, { maximumFractionDigits: digits });
  if (amount.group === 'budget') return `$${number(amount.value)}`;
  const leaf = amount.path.split('.').pop() ?? '';
  if (leaf === 'maxFileSize' || leaf === 'maxStorageBytes' || amount.path === 'rateLimit.storage' || amount.path.startsWith('rateLimit.storage.')) {
    return `${number(amount.value / MB)} MB`;
  }
  if (leaf === 'maxSessionDurationMs') return `${number(amount.value / 1000)} s`;
  return number(amount.value, 0);
}

// ── editor seed ──────────────────────────────────────────────────────────

/** A copy of a limit to start a new one from: same amounts and target, a distinguishable name. */
export function duplicateSeed(row: LimitRow, copyLabel: (label: string) => string): Pick<
  LimitRow,
  'scope' | 'scopeId' | 'groupMode' | 'domain' | 'priority' | 'enabled' | 'label' | 'description' | 'limits' | 'projectId'
> {
  return {
    scope: row.scope,
    scopeId: row.scopeId,
    groupMode: row.groupMode,
    domain: row.domain,
    priority: row.priority,
    enabled: row.enabled,
    label: copyLabel(row.label ?? ''),
    description: row.description,
    limits: structuredClone(row.limits),
    projectId: row.projectId,
  };
}
