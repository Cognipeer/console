/**
 * View model of the project Overview tab: a tolerant parser for
 * `GET /api/projects/:projectId/overview`, the readiness checklist and the
 * small pure helpers the cards need. Pure of React and Next (the node tests
 * drive it directly).
 */

import { asArray, asId, asNumber, asRecord, asString } from '@/components/iam/principals/client';
import { newLimitHref } from '@/components/iam/limits/links';

export type ProjectRoleValue = 'member' | 'project_admin';

export interface OverviewStats {
  members: number;
  groups: number;
  people: number;
  providers: number;
  providersByDomain: Record<string, number>;
  agents: number;
  tokens: number;
}

export interface OverviewReadiness {
  hasModelProvider: boolean;
  missingDomains: string[];
  hasProjectAdmin: boolean;
  hasLimits: boolean;
}

export interface OverviewAdmin {
  userId: string;
  name: string;
  email: string;
  kind: 'project_admin' | 'tenant_owner' | 'tenant_admin';
}

export interface OverviewRule {
  source: 'oidc' | 'ldap';
  label: string | null;
  mode: 'fallback' | 'always';
  applyOn: 'first_sign_in' | 'every_sign_in';
  /** Only the entries of this project (the server filters them). */
  projects: Array<{ projectId: string; role: ProjectRoleValue }>;
}

export interface OverviewGroup {
  groupId: string;
  name: string;
  role: ProjectRoleValue;
  /** `local`, or the directory that manages the group. */
  source: string;
}

export interface OverviewActivity {
  at: string;
  actor: { userId: string; name: string } | null;
  action: string;
  summary: string;
}

export interface OverviewProject {
  id: string;
  key: string;
  name: string;
  description: string;
  createdAt: string | null;
}

export interface ProjectOverviewData {
  project: OverviewProject;
  stats: OverviewStats;
  readiness: OverviewReadiness;
  admins: OverviewAdmin[];
  rules: OverviewRule[];
  groups: OverviewGroup[];
  activity: OverviewActivity[];
}

const EMPTY_STATS: OverviewStats = {
  members: 0,
  groups: 0,
  people: 0,
  providers: 0,
  providersByDomain: {},
  agents: 0,
  tokens: 0,
};

const strings = (value: unknown): string[] =>
  asArray(value).filter((entry): entry is string => typeof entry === 'string' && entry !== '');

const toRole = (value: unknown): ProjectRoleValue => (value === 'project_admin' ? 'project_admin' : 'member');

function parseStats(raw: unknown): OverviewStats {
  const r = asRecord(raw);
  const byDomain: Record<string, number> = {};
  for (const [domain, count] of Object.entries(asRecord(r.providersByDomain))) {
    const n = asNumber(count);
    if (n !== null && n > 0) byDomain[domain] = n;
  }
  return {
    members: asNumber(r.members) ?? 0,
    groups: asNumber(r.groups) ?? 0,
    people: asNumber(r.people) ?? 0,
    providers: asNumber(r.providers) ?? 0,
    providersByDomain: byDomain,
    agents: asNumber(r.agents) ?? 0,
    tokens: asNumber(r.tokens) ?? 0,
  };
}

function parseDate(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  return null;
}

/** Parses the overview payload; returns `null` when it carries no project at all. */
export function parseOverview(raw: unknown): ProjectOverviewData | null {
  const r = asRecord(raw);
  const project = asRecord(r.project);
  const id = asId(project._id) ?? asId(project.id);
  if (!id) return null;

  const readiness = asRecord(r.readiness);
  const directory = asRecord(r.directory);

  return {
    project: {
      id,
      key: asString(project.key) ?? '',
      name: asString(project.name) ?? '',
      description: asString(project.description) ?? '',
      createdAt: parseDate(project.createdAt),
    },
    stats: r.stats ? parseStats(r.stats) : { ...EMPTY_STATS },
    readiness: {
      hasModelProvider: readiness.hasModelProvider === true,
      missingDomains: strings(readiness.missingDomains),
      hasProjectAdmin: readiness.hasProjectAdmin === true,
      hasLimits: readiness.hasLimits === true,
    },
    admins: asArray(r.admins).flatMap((entry): OverviewAdmin[] => {
      const a = asRecord(entry);
      const userId = asId(a.userId);
      if (!userId) return [];
      const kind = a.kind === 'tenant_owner' || a.kind === 'tenant_admin' ? a.kind : 'project_admin';
      return [{ userId, name: asString(a.name) ?? '', email: asString(a.email) ?? '', kind }];
    }),
    rules: asArray(directory.rules).flatMap((entry): OverviewRule[] => {
      const rule = asRecord(entry);
      const source = rule.source === 'ldap' ? 'ldap' : rule.source === 'oidc' ? 'oidc' : null;
      if (!source) return [];
      const projects = asArray(rule.projects).flatMap((p) => {
        const item = asRecord(p);
        const projectId = asId(item.projectId);
        return projectId ? [{ projectId, role: toRole(item.role) }] : [];
      });
      if (projects.length === 0) return [];
      return [
        {
          source,
          label: asString(rule.label),
          mode: rule.mode === 'always' ? 'always' : 'fallback',
          applyOn: rule.applyOn === 'every_sign_in' ? 'every_sign_in' : 'first_sign_in',
          projects,
        },
      ];
    }),
    groups: asArray(directory.groups).flatMap((entry): OverviewGroup[] => {
      const g = asRecord(entry);
      const groupId = asId(g.groupId);
      if (!groupId) return [];
      return [{ groupId, name: asString(g.name) ?? groupId, role: toRole(g.role), source: asString(g.source) ?? 'local' }];
    }),
    activity: asArray(r.activity).flatMap((entry): OverviewActivity[] => {
      const a = asRecord(entry);
      const at = parseDate(a.at);
      if (!at) return [];
      const actor = asRecord(a.actor);
      const actorId = asId(actor.userId);
      return [
        {
          at,
          actor: actorId ? { userId: actorId, name: asString(actor.name) ?? actorId } : null,
          action: asString(a.action) ?? '',
          summary: asString(a.summary) ?? '',
        },
      ];
    }),
  };
}

// ── readiness ─────────────────────────────────────────────────────────────

export type ReadinessFix = 'providers' | 'members' | 'limits';

export interface ReadinessItem {
  /** `model`, `domain:<domain>`, `admin` or `limits`. */
  id: string;
  ok: boolean;
  /** The provider domain the row is about (`model`, `embedding`, ...). */
  domain?: string;
  /** How many providers of that domain the project has. */
  count?: number;
  /** The one-click fix offered while the row is not ok. */
  fix?: ReadinessFix;
}

/**
 * The checklist rows: the model provider first, then the other provider domains
 * (the ones the project has, then the ones the workspace uses and it lacks),
 * a project admin, and a limit.
 */
export function buildReadinessItems(readiness: OverviewReadiness, stats: OverviewStats): ReadinessItem[] {
  const items: ReadinessItem[] = [
    {
      id: 'model',
      ok: readiness.hasModelProvider,
      domain: 'model',
      count: stats.providersByDomain.model ?? 0,
      ...(readiness.hasModelProvider ? {} : { fix: 'providers' as const }),
    },
  ];

  const present = Object.keys(stats.providersByDomain)
    .filter((domain) => domain !== 'model')
    .sort();
  for (const domain of present) {
    items.push({ id: `domain:${domain}`, ok: true, domain, count: stats.providersByDomain[domain] });
  }
  const missing = readiness.missingDomains.filter((domain) => domain !== 'model' && !present.includes(domain)).sort();
  for (const domain of missing) {
    items.push({ id: `domain:${domain}`, ok: false, domain, count: 0, fix: 'providers' });
  }

  items.push({ id: 'admin', ok: readiness.hasProjectAdmin, ...(readiness.hasProjectAdmin ? {} : { fix: 'members' as const }) });
  items.push({ id: 'limits', ok: readiness.hasLimits, ...(readiness.hasLimits ? {} : { fix: 'limits' as const }) });
  return items;
}

export function readinessSummary(items: readonly ReadinessItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.ok).length, total: items.length };
}

export function projectTabHref(projectId: string, tab: string): string {
  return `/dashboard/projects/${encodeURIComponent(projectId)}?tab=${encodeURIComponent(tab)}`;
}

/** Where the one-click fix of a readiness row leads. */
export function readinessFixHref(fix: ReadinessFix, projectId: string): string {
  switch (fix) {
    case 'providers':
      return projectTabHref(projectId, 'providers');
    case 'members':
      return projectTabHref(projectId, 'members');
    case 'limits':
      return newLimitHref({ projectId });
  }
}

// ── directory ─────────────────────────────────────────────────────────────

/** The directory integrations' settings pages (enterprise edition). */
export function directorySettingsHref(source: 'oidc' | 'ldap'): string {
  return source === 'ldap' ? '/dashboard/ldap' : '/dashboard/sso';
}

/** A directory-managed group: anything that is not a local one. */
export function isDirectoryGroup(group: Pick<OverviewGroup, 'source'>): boolean {
  return group.source !== '' && group.source !== 'local';
}

/** The Directory card is shown only when a rule or a synced group reaches this project. */
export function hasDirectoryContent(data: Pick<ProjectOverviewData, 'rules' | 'groups'>): boolean {
  return data.rules.length > 0 || data.groups.some(isDirectoryGroup);
}

// ── activity ──────────────────────────────────────────────────────────────

/** Actions whose server text is a fixed sentence the UI can translate; others keep the server's text (it names people). */
export const TRANSLATABLE_ACTIONS: readonly string[] = [
  'members.added',
  'members.removed',
  'members.updated',
  'members.bulk',
  'members.permissions',
  'groups.added',
  'groups.removed',
  'groups.updated',
  'tokens.added',
  'tokens.removed',
  'tokens.updated',
  'project.updated',
  'project.deleted',
];

export function isTranslatableAction(action: string): boolean {
  return TRANSLATABLE_ACTIONS.includes(action);
}
