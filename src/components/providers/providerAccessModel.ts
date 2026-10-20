/**
 * View-model logic of the provider screens that deal with projects and connection tests:
 * which projects are "Recommended" for a new provider, what a test result means, the impact of
 * unassigning, and the assignment diff. Pure functions, no React, so they are unit tested.
 */

/** A tenant project as `GET /api/projects?include=stats` returns it (only what the screens read). */
export interface AccessProject {
  _id: string;
  key: string;
  name: string;
  stats?: {
    people?: number;
    providers?: number;
    providersByDomain?: Record<string, number>;
  };
}

/** One step of a file provider's connection check (`details.steps` of a test result). */
export interface ProviderTestStep {
  step: string;
  ok: boolean;
  message?: string;
}

/** `POST /api/providers/test` and `POST /api/providers/:id/test`. */
export interface ProviderTestResult {
  /** `null`: the driver has no test. */
  ok: boolean | null;
  latencyMs: number;
  message: string;
  details?: {
    deployments?: string[];
    models?: string[];
    /** File providers: the steps their check ran (list, write, read, delete) and how each ended. */
    steps?: ProviderTestStep[];
  };
}

/** `lastTest` of a stored provider (`at` arrives as an ISO string over JSON). */
export interface StoredProviderTest {
  ok: boolean | null;
  at: string | Date;
  latencyMs: number;
  message: string;
  deployments?: number;
}

/** One project of `GET /api/providers/:id/usage`. */
export interface ProviderUsageEntry {
  projectId: string;
  name: string;
  assigned: boolean;
  models: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
  requests7d?: number;
  lastUsedAt?: string;
}

/** How many providers of the domain a project already has (0 when its stats are unknown). */
export function providersInDomain(project: AccessProject, domain: string): number {
  return project.stats?.providersByDomain?.[domain] ?? 0;
}

/** Order projects by name, locale aware, without mutating the input. */
function byName(projects: readonly AccessProject[]): AccessProject[] {
  return [...projects].sort((a, b) => a.name.localeCompare(b.name));
}

/** Case-insensitive match on name and key; an empty query matches everything. */
export function filterProjects<T extends { name: string; key: string }>(
  projects: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q));
}

export interface AssignGroups {
  /** Projects that cannot yet use any provider of this domain: where the new provider helps most. */
  recommended: AccessProject[];
  others: AccessProject[];
}

/**
 * Split the projects for the "Assign to projects" step: those without a provider of the domain first
 * ("Recommended"), then the rest, each group by name. `excludeIds` (already assigned) are left out.
 */
export function groupAssignCandidates(
  projects: readonly AccessProject[],
  domain: string,
  options: { query?: string; excludeIds?: ReadonlySet<string> } = {},
): AssignGroups {
  const visible = filterProjects(
    projects.filter((p) => !options.excludeIds?.has(p._id)),
    options.query ?? '',
  );
  const sorted = byName(visible);
  return {
    recommended: sorted.filter((p) => providersInDomain(p, domain) === 0),
    others: sorted.filter((p) => providersInDomain(p, domain) > 0),
  };
}

/** Add or remove an id, returning a new set. */
export function toggleId(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Select every id in `ids` (keeping what is already selected), or clear exactly those ids. */
export function setAll(current: ReadonlySet<string>, ids: readonly string[], selected: boolean): Set<string> {
  const next = new Set(current);
  for (const id of ids) {
    if (selected) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** The projects a provider record is assigned to: the legacy single `projectId` plus `projectIds`. */
export function effectiveProjectIds(provider: { projectId?: string | null; projectIds?: string[] | null }): string[] {
  const ids = [...(provider.projectId ? [provider.projectId] : []), ...(provider.projectIds ?? [])].map(String);
  return [...new Set(ids)];
}

/** A provider no project can use yet. */
export function isProviderUnassigned(provider: { projectId?: string | null; projectIds?: string[] | null }): boolean {
  return effectiveProjectIds(provider).length === 0;
}

export type TestState = 'ok' | 'failed' | 'unsupported';

export function testState(result: { ok: boolean | null }): TestState {
  if (result.ok === true) return 'ok';
  if (result.ok === false) return 'failed';
  return 'unsupported';
}

/** Deployments or models a probe found (deployments win: they are what a model provider is added from). */
export function foundCount(details: ProviderTestResult['details']): number | undefined {
  if (!details) return undefined;
  if (details.deployments) return details.deployments.length;
  if (details.models) return details.models.length;
  return undefined;
}

/** `412 ms`, or `1.2 s` from a second up. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  return `${Math.round(ms)} ms`;
}

/**
 * A relative time ("2 min ago") in the given locale; falls back to the date for anything older than
 * a month and to an empty string for an unparseable value.
 */
export function formatRelativeTime(input: string | Date | null | undefined, locale: string, now: Date = new Date()): string {
  if (!input) return '';
  const at = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(at.getTime())) return '';
  const seconds = Math.round((at.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(seconds / 86_400), 'day');
  return at.toLocaleDateString(locale);
}

export interface UnassignImpact {
  models: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
  requests7d: number;
  /** Something in the project runs on the provider and would stop working. */
  hasImpact: boolean;
}

/** What would stop working if the provider were taken away from the project. */
export function unassignImpact(entry: Pick<ProviderUsageEntry, 'models' | 'agents' | 'requests7d'>): UnassignImpact {
  return {
    models: entry.models,
    agents: entry.agents,
    requests7d: entry.requests7d ?? 0,
    hasImpact: entry.models.length > 0 || entry.agents.length > 0,
  };
}

/** "Used by N of M projects". */
export function usageSummary(entries: readonly Pick<ProviderUsageEntry, 'assigned'>[]): { assigned: number; total: number } {
  return { assigned: entries.filter((e) => e.assigned).length, total: entries.length };
}

export interface AssignmentDiff {
  added: string[];
  removed: string[];
  next: string[];
}

/** The change from one assignment to another, and the resulting list (stable order, deduped). */
export function diffAssignment(before: readonly string[], after: readonly string[]): AssignmentDiff {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((id) => !b.has(id)),
    removed: [...b].filter((id) => !a.has(id)),
    next: [...a],
  };
}

/**
 * The model flow after "Assign & add models": the project to open it in. The active project when the
 * provider was assigned to it (no switch needed), otherwise the first of the assigned projects.
 */
export function pickModelFlowProject(
  assignedIds: readonly string[],
  activeProjectId: string | undefined,
): { projectId: string; needsSwitch: boolean } | null {
  if (assignedIds.length === 0) return null;
  if (activeProjectId && assignedIds.includes(activeProjectId)) {
    return { projectId: activeProjectId, needsSwitch: false };
  }
  return { projectId: assignedIds[0]!, needsSwitch: true };
}

export function modelFlowHref(providerKey: string): string {
  return `/dashboard/models?addModelsFor=${encodeURIComponent(providerKey)}`;
}
