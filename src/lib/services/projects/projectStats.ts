/**
 * Per-project counters for the Projects list / Overview screens.
 *
 * Everything is derived from a handful of tenant-wide reads that are grouped in
 * memory (a tenant has far fewer than 100 projects), so the cost does not grow
 * with the number of projects: no per-project round trips, which matters on
 * Cosmos where each one is a billed, high-latency query.
 */
import type {
  DatabaseProvider,
  IAgent,
  IApiToken,
  IGroupMember,
  IGroupProject,
  IProject,
  IProviderRecord,
  IUserProject,
} from '@/lib/database';
import type { DirectoryProjectRule } from '@/enterprise/external-auth';

export interface ProjectStats {
  /** Direct membership rows (IUserProject). */
  members: number;
  /** Group grants (IGroupProject). */
  groups: number;
  /** Distinct users reaching the project directly or through a granted group. */
  people: number;
  /** Providers assigned to the project (all domains). */
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

export interface TenantProjectData {
  userProjects: Pick<IUserProject, 'userId' | 'projectId'>[];
  groupProjects: Pick<IGroupProject, 'groupId' | 'projectId'>[];
  groupMembers: Pick<IGroupMember, 'groupId' | 'userId'>[];
  providers: Pick<IProviderRecord, 'type' | 'projectId' | 'projectIds'>[];
  agents: Pick<IAgent, 'projectId'>[];
  tokens: Pick<IApiToken, 'projectId'>[];
}

/** Ids of the projects a provider record is assigned to (legacy single `projectId` + `projectIds`). */
export function providerProjectIds(
  provider: Pick<IProviderRecord, 'projectId' | 'projectIds'>,
): string[] {
  const ids = new Set<string>();
  if (provider.projectId) ids.add(String(provider.projectId));
  for (const id of provider.projectIds ?? []) {
    if (id) ids.add(String(id));
  }
  return [...ids];
}

function emptyStats(): ProjectStats {
  return {
    members: 0,
    groups: 0,
    people: 0,
    providers: 0,
    providersByDomain: {},
    agents: 0,
    tokens: 0,
  };
}

/** Pure computation: tenant-wide rows in, one stats object per project id out. */
export function buildProjectStats(
  projectIds: string[],
  data: TenantProjectData,
): Map<string, ProjectStats> {
  const stats = new Map<string, ProjectStats>();
  const people = new Map<string, Set<string>>();
  for (const id of projectIds) {
    stats.set(id, emptyStats());
    people.set(id, new Set());
  }

  for (const row of data.userProjects) {
    const id = String(row.projectId);
    const entry = stats.get(id);
    if (!entry) continue;
    entry.members += 1;
    people.get(id)!.add(String(row.userId));
  }

  const membersByGroup = new Map<string, string[]>();
  for (const row of data.groupMembers) {
    const key = String(row.groupId);
    const list = membersByGroup.get(key);
    if (list) list.push(String(row.userId));
    else membersByGroup.set(key, [String(row.userId)]);
  }
  for (const grant of data.groupProjects) {
    const id = String(grant.projectId);
    const entry = stats.get(id);
    if (!entry) continue;
    entry.groups += 1;
    const set = people.get(id)!;
    for (const userId of membersByGroup.get(String(grant.groupId)) ?? []) set.add(userId);
  }

  for (const provider of data.providers) {
    for (const id of providerProjectIds(provider)) {
      const entry = stats.get(id);
      if (!entry) continue;
      entry.providers += 1;
      entry.providersByDomain[provider.type] = (entry.providersByDomain[provider.type] ?? 0) + 1;
    }
  }

  for (const agent of data.agents) {
    const entry = stats.get(String(agent.projectId));
    if (entry) entry.agents += 1;
  }
  for (const token of data.tokens) {
    if (!token.projectId) continue;
    const entry = stats.get(String(token.projectId));
    if (entry) entry.tokens += 1;
  }

  for (const [id, entry] of stats) entry.people = people.get(id)!.size;
  return stats;
}

/** Loads the tenant-wide rows (a fixed number of reads) the counters are derived from. */
export async function loadTenantProjectData(
  db: DatabaseProvider,
  tenantId: string,
): Promise<TenantProjectData> {
  const [userProjects, groupProjects, groupMembers, providers, agents, tokens] = await Promise.all([
    db.listUserProjectsByTenant(tenantId),
    db.listGroupProjectsByTenant(tenantId),
    db.listGroupMembersByTenant(tenantId),
    db.listProviders(tenantId),
    db.listAgents(),
    db.listTenantApiTokens(tenantId),
  ]);
  return { userProjects, groupProjects, groupMembers, providers, agents, tokens };
}

export async function loadProjectStats(
  db: DatabaseProvider,
  tenantId: string,
  projects: Pick<IProject, '_id'>[],
): Promise<Map<string, ProjectStats>> {
  const ids = projects.map((p) => String(p._id));
  if (ids.length === 0) return new Map();
  return buildProjectStats(ids, await loadTenantProjectData(db, tenantId));
}

/** The SSO/LDAP rules that hand `projectId` to a user on sign-in, one entry per rule. */
export function directoryDefaultsFor(
  rules: DirectoryProjectRule[],
  projectId: string,
): ProjectDirectoryDefault[] {
  const out: ProjectDirectoryDefault[] = [];
  for (const rule of rules) {
    const target = rule.projects.find((p) => String(p.projectId) === String(projectId));
    if (!target) continue;
    out.push({
      source: rule.source,
      ...(rule.label ? { label: rule.label } : {}),
      role: target.role,
      mode: rule.mode,
    });
  }
  return out;
}

export interface ProjectReadiness {
  hasModelProvider: boolean;
  /** Domains the project could use but has no provider for: always `model`, plus every domain the tenant has providers in. */
  missingDomains: string[];
  hasProjectAdmin: boolean;
  hasLimits: boolean;
}

export function computeReadiness(params: {
  stats: ProjectStats;
  tenantDomains: string[];
  hasProjectAdmin: boolean;
  hasLimits: boolean;
}): ProjectReadiness {
  const { stats, tenantDomains, hasProjectAdmin, hasLimits } = params;
  const wanted = new Set<string>(['model', ...tenantDomains]);
  const missingDomains = [...wanted].filter((domain) => !stats.providersByDomain[domain]);
  return {
    hasModelProvider: (stats.providersByDomain.model ?? 0) > 0,
    missingDomains,
    hasProjectAdmin,
    hasLimits,
  };
}
