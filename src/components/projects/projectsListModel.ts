import { includesFolded } from '@/lib/shared/searchFold';

/**
 * The Projects list's view model (pure: no React, unit-tested in node).
 *
 * Rows are what `GET /api/projects?include=stats` returns. Search and the quick
 * filters live in the address (`?q=&f=manage,noProvider`) so a refresh or a
 * back link restores the same view.
 */

export interface ProjectListStats {
  members: number;
  groups: number;
  people: number;
  providers: number;
  providersByDomain: Record<string, number>;
  agents: number;
  tokens: number;
}

export interface ProjectDirectoryDefault {
  source: 'oidc' | 'ldap';
  label?: string;
  role: 'project_admin' | 'member';
  mode: 'fallback' | 'always';
}

export interface ProjectListRow {
  _id: string;
  name: string;
  key: string;
  description?: string;
  createdAt?: string;
  /** The caller may administer this project (tenant owner/admin, or project_admin directly or via a group). */
  canManage: boolean;
  stats: ProjectListStats;
  directoryDefault: ProjectDirectoryDefault[];
}

export const QUICK_FILTERS = ['manage', 'noProvider', 'noMembers'] as const;
export type QuickFilter = (typeof QUICK_FILTERS)[number];

export interface ProjectListFilters {
  query: string;
  quick: ReadonlySet<QuickFilter>;
}

export const NO_PROJECT_FILTERS: ProjectListFilters = { query: '', quick: new Set() };

const EMPTY_STATS: ProjectListStats = {
  members: 0,
  groups: 0,
  people: 0,
  providers: 0,
  providersByDomain: {},
  agents: 0,
  tokens: 0,
};

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** One row of the API answer; undefined when it is not a usable project. */
export function parseProjectRow(raw: unknown): ProjectListRow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const id = p._id !== undefined && p._id !== null ? String(p._id) : '';
  if (!id || typeof p.name !== 'string') return undefined;

  const rawStats = (p.stats && typeof p.stats === 'object' ? p.stats : {}) as Record<string, unknown>;
  const byDomain: Record<string, number> = {};
  if (rawStats.providersByDomain && typeof rawStats.providersByDomain === 'object') {
    for (const [domain, count] of Object.entries(rawStats.providersByDomain as Record<string, unknown>)) {
      if (num(count) > 0) byDomain[domain] = num(count);
    }
  }
  const stats: ProjectListStats = {
    ...EMPTY_STATS,
    members: num(rawStats.members),
    groups: num(rawStats.groups),
    people: num(rawStats.people),
    providers: num(rawStats.providers),
    providersByDomain: byDomain,
    agents: num(rawStats.agents),
    tokens: num(rawStats.tokens),
  };

  const defaults = Array.isArray(p.directoryDefault) ? p.directoryDefault : [];
  return {
    _id: id,
    name: p.name,
    key: typeof p.key === 'string' ? p.key : '',
    ...(typeof p.description === 'string' && p.description ? { description: p.description } : {}),
    ...(typeof p.createdAt === 'string' ? { createdAt: p.createdAt } : {}),
    canManage: p.canManage === true,
    stats,
    directoryDefault: defaults.flatMap((d): ProjectDirectoryDefault[] => {
      const rule = d as Partial<ProjectDirectoryDefault> | null;
      if (!rule || (rule.source !== 'oidc' && rule.source !== 'ldap')) return [];
      return [
        {
          source: rule.source,
          ...(rule.label ? { label: rule.label } : {}),
          role: rule.role === 'project_admin' ? 'project_admin' : 'member',
          mode: rule.mode === 'always' ? 'always' : 'fallback',
        },
      ];
    }),
  };
}

export function parseProjectRows(body: unknown): ProjectListRow[] {
  const list = body && typeof body === 'object' ? (body as { projects?: unknown }).projects : undefined;
  return (Array.isArray(list) ? list : []).map(parseProjectRow).filter((row): row is ProjectListRow => row !== undefined);
}

// ── filters ←→ address ───────────────────────────────────────────────────

interface ParamReader {
  get(name: string): string | null;
}

export function parseProjectFilters(params: ParamReader): ProjectListFilters {
  const quick = new Set<QuickFilter>();
  for (const part of (params.get('f') ?? '').split(',')) {
    const name = part.trim();
    if ((QUICK_FILTERS as readonly string[]).includes(name)) quick.add(name as QuickFilter);
  }
  return { query: params.get('q') ?? '', quick };
}

/** The query string (no leading `?`) for a view; empty for the default view. */
export function projectFiltersToSearch(filters: ProjectListFilters): string {
  const out = new URLSearchParams();
  if (filters.query.trim()) out.set('q', filters.query);
  const quick = QUICK_FILTERS.filter((name) => filters.quick.has(name));
  if (quick.length > 0) out.set('f', quick.join(','));
  return out.toString();
}

export function toggleQuickFilter(filters: ProjectListFilters, name: QuickFilter): ProjectListFilters {
  const quick = new Set(filters.quick);
  if (quick.has(name)) quick.delete(name);
  else quick.add(name);
  return { ...filters, quick };
}

// ── filtering ────────────────────────────────────────────────────────────

/** A project nobody can use for model calls yet: no providers at all. */
export const hasNoProvider = (row: ProjectListRow): boolean => row.stats.providers === 0;

/** Nobody but tenant admins reaches it: no direct members and no group grants. */
export const hasNoMembers = (row: ProjectListRow): boolean => row.stats.people === 0;

export function filterProjectRows(rows: readonly ProjectListRow[], filters: ProjectListFilters): ProjectListRow[] {
  const query = filters.query.trim();
  return rows.filter((row) => {
    if (filters.quick.has('manage') && !row.canManage) return false;
    if (filters.quick.has('noProvider') && !hasNoProvider(row)) return false;
    if (filters.quick.has('noMembers') && !hasNoMembers(row)) return false;
    if (!query) return true;
    return includesFolded([row.name, row.key, row.description ?? ''].join(' '), query);
  });
}

/** How many rows each quick filter would show (for the chip counters). */
export function quickFilterCounts(rows: readonly ProjectListRow[]): Record<QuickFilter, number> {
  return {
    manage: rows.filter((r) => r.canManage).length,
    noProvider: rows.filter(hasNoProvider).length,
    noMembers: rows.filter(hasNoMembers).length,
  };
}

/** Providers of a row as `[domain, count]`, the biggest first, then by name. */
export function providerBreakdown(row: Pick<ProjectListRow, 'stats'>): Array<[string, number]> {
  return Object.entries(row.stats.providersByDomain).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ── back link ────────────────────────────────────────────────────────────

export const LAST_LIST_URL_KEY = 'projects:lastListUrl';
const LIST_PATH = '/dashboard/projects';

/** Only a path under the list itself is a usable back link (it comes from sessionStorage). */
export function sanitizeListUrl(value: string | null | undefined): string {
  if (typeof value === 'string' && (value === LIST_PATH || value.startsWith(`${LIST_PATH}?`))) return value;
  return LIST_PATH;
}

// ── create: readiness ────────────────────────────────────────────────────

export type ProjectRoleValue = 'project_admin' | 'member';

export interface CreateReadinessInput {
  name: string;
  /** Domains of the selected providers. */
  providerDomains: readonly string[];
  roles: readonly ProjectRoleValue[];
}

export interface CreateReadinessItem {
  id: 'name' | 'modelProvider' | 'projectAdmin';
  done: boolean;
  /** `warn` items never block creating. */
  blocking: boolean;
}

export function createReadiness(input: CreateReadinessInput): CreateReadinessItem[] {
  return [
    { id: 'name', done: input.name.trim().length >= 2, blocking: true },
    { id: 'modelProvider', done: input.providerDomains.includes('model'), blocking: false },
    { id: 'projectAdmin', done: input.roles.includes('project_admin'), blocking: false },
  ];
}

export const canCreateProject = (items: readonly CreateReadinessItem[]): boolean =>
  items.every((item) => item.done || !item.blocking);

/** A row to send in `members[]` / `groups[]`. */
export function roleEntries(
  picked: ReadonlyMap<string, ProjectRoleValue>,
  idField: 'userId' | 'groupId',
): Array<Record<string, string>> {
  return [...picked.entries()].map(([id, role]) => ({ [idField]: id, role }));
}

/** Providers grouped by domain, domains with the model domain first, then alphabetical. */
export function groupProvidersByDomain<T extends { type: string; label?: string; key?: string }>(
  providers: readonly T[],
): Array<{ domain: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const provider of providers) {
    const list = groups.get(provider.type) ?? [];
    list.push(provider);
    groups.set(provider.type, list);
  }
  const name = (p: T) => (p.label || p.key || '').toLowerCase();
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'model' ? -1 : b === 'model' ? 1 : a.localeCompare(b)))
    .map(([domain, items]) => ({ domain, items: [...items].sort((x, y) => name(x).localeCompare(name(y))) }));
}
