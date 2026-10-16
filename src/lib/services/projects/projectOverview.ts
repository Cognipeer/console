/**
 * Read model behind `GET /api/projects/:projectId/overview` and the extended
 * members response: who administers a project, which groups reach it, which
 * directory rules hand it out and what happened to it lately.
 */
import type {
  DatabaseProvider,
  IAuditLog,
  IGroup,
  IGroupMember,
  IGroupProject,
  IProject,
  IUser,
  IUserProject,
} from '@/lib/database';
import { listDirectoryProjectRules } from '@/enterprise/external-auth';
import { defaultSetProgress } from '@/lib/services/alerts/alertTemplates';
import { isGroupDirectoryManaged } from '@/lib/iam/identity';
import {
  computeReadiness,
  buildProjectStats,
  loadTenantProjectData,
  type ProjectReadiness,
  type ProjectStats,
} from './projectStats';

const ACTIVITY_LIMIT = 20;
/** Audit rows are scanned for this long back; keeps the path match cheap on large audit tables. */
const ACTIVITY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface ProjectAdminEntry {
  userId: string;
  name: string;
  email: string;
  kind: 'project_admin' | 'tenant_owner' | 'tenant_admin';
}

export interface ProjectGroupEntry {
  groupId: string;
  name: string;
  role: IGroupProject['role'];
  memberCount: number;
  directorySynced: boolean;
  source: string;
}

export interface ProjectActivityEntry {
  at: string;
  actor?: { userId: string; name: string };
  action: string;
  summary: string;
}

const userName = (user: Pick<IUser, 'name' | 'email'> | undefined, fallback: string) =>
  user?.name || user?.email || fallback;

/** Group grants of one project, named, with their member counts. */
export function describeProjectGroups(params: {
  grants: IGroupProject[];
  groups: IGroup[];
  groupMembers: Pick<IGroupMember, 'groupId'>[];
}): ProjectGroupEntry[] {
  const groupById = new Map(params.groups.map((g) => [String(g._id), g]));
  const counts = new Map<string, number>();
  for (const member of params.groupMembers) {
    const key = String(member.groupId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: ProjectGroupEntry[] = [];
  for (const grant of params.grants) {
    const group = groupById.get(String(grant.groupId));
    if (!group) continue;
    out.push({
      groupId: String(group._id),
      name: group.name,
      role: grant.role,
      memberCount: counts.get(String(group._id)) ?? 0,
      directorySynced: isGroupDirectoryManaged(group),
      source: group.source ?? 'local',
    });
  }
  return out;
}

/** Owners and admins: they reach every project without a membership row. */
export function listTenantAdmins(users: IUser[]) {
  return users
    .filter((u) => u.role === 'owner' || u.role === 'admin')
    .map((u) => ({
      userId: String(u._id),
      name: u.name,
      email: u.email,
      role: u.role as 'owner' | 'admin',
    }));
}

function summarizeAudit(row: IAuditLog, projectId: string): { action: string; summary: string } {
  const method = (row.method ?? '').toUpperCase();
  const path = (row.path ?? '').split('?')[0];
  const [before, rest = ''] = path.split(`/projects/${projectId}`);
  const sub = rest.replace(/^\//, '').split('/').filter(Boolean);
  const area = sub[0] ?? 'project';
  const verb = method === 'POST' ? 'added' : method === 'DELETE' ? 'removed' : 'updated';
  // `DELETE /groups/:id/projects/:projectId` (and the client-API twin) revokes a group's grant,
  // it is not an event of the project itself.
  if (sub.length === 0 && /\/groups\/[^/]+$/.test(before ?? '')) {
    return { action: 'groups.removed', summary: 'Group access removed' };
  }
  if (area === 'members' && sub[1] === 'bulk') {
    return { action: 'members.bulk', summary: 'Members changed in bulk' };
  }
  if (area === 'members' && sub[1] === 'permissions') {
    return { action: 'members.permissions', summary: 'Member permissions updated' };
  }
  if (area === 'members') return { action: `members.${verb}`, summary: `Member ${verb}` };
  if (area === 'groups') return { action: `groups.${verb}`, summary: `Group access ${verb}` };
  if (area === 'tokens') return { action: `tokens.${verb}`, summary: `API token ${verb}` };
  if (sub.length === 0) {
    return method === 'DELETE'
      ? { action: 'project.deleted', summary: 'Project deleted' }
      : { action: 'project.updated', summary: 'Project details updated' };
  }
  return { action: `${area}.${verb}`, summary: `${area} ${verb}` };
}

/** The last events touching a project: audited changes plus directory-applied memberships and group grants. */
export async function loadProjectActivity(params: {
  db: DatabaseProvider;
  projectId: string;
  userProjects: IUserProject[];
  groupGrants: IGroupProject[];
  groups: IGroup[];
  users: Map<string, IUser>;
}): Promise<ProjectActivityEntry[]> {
  const { db, projectId, users } = params;
  const entries: Array<ProjectActivityEntry & { ts: number }> = [];

  let rows: IAuditLog[] = [];
  try {
    rows = await db.listAuditLogs({
      q: `/projects/${projectId}`,
      // failed calls never make the list: leave them out of the 200 rows read
      outcome: 'success',
      from: new Date(Date.now() - ACTIVITY_WINDOW_MS),
      limit: 200,
    });
  } catch {
    rows = [];
  }
  for (const row of rows) {
    const method = (row.method ?? '').toUpperCase();
    if (method === 'GET' || row.outcome !== 'success') continue;
    const path = (row.path ?? '').split('?')[0];
    // The path match above is a substring search: keep exact project segments only.
    const marker = `/projects/${projectId}`;
    const at0 = path.indexOf(marker);
    if (at0 === -1 || (path[at0 + marker.length] !== undefined && path[at0 + marker.length] !== '/')) continue;
    const at = row.createdAt ? new Date(row.createdAt) : null;
    if (!at) continue;
    const { action, summary } = summarizeAudit(row, projectId);
    const actorId = row.actorUserId ? String(row.actorUserId) : undefined;
    entries.push({
      ts: at.getTime(),
      at: at.toISOString(),
      ...(actorId
        ? { actor: { userId: actorId, name: userName(users.get(actorId), row.actorEmail ?? actorId) } }
        : {}),
      action,
      summary,
    });
  }

  for (const row of params.userProjects) {
    if (row.source !== 'directory' || !row.createdAt) continue;
    const at = new Date(row.createdAt);
    const via = row.invitedBy === 'directory:ldap' ? 'LDAP' : 'SSO';
    entries.push({
      ts: at.getTime(),
      at: at.toISOString(),
      action: 'members.directory_added',
      summary: `${userName(users.get(String(row.userId)), String(row.userId))} added by ${via} default`,
    });
  }

  const groupById = new Map(params.groups.map((g) => [String(g._id), g]));
  for (const grant of params.groupGrants) {
    if (!grant.createdAt) continue;
    const at = new Date(grant.createdAt);
    const group = groupById.get(String(grant.groupId));
    entries.push({
      ts: at.getTime(),
      at: at.toISOString(),
      action: 'groups.added',
      summary: `Group ${group?.name ?? grant.groupId} granted access as ${grant.role}`,
    });
  }

  return entries
    .sort((a, b) => b.ts - a.ts)
    .slice(0, ACTIVITY_LIMIT)
    .map((entry) => ({
      at: entry.at,
      ...(entry.actor ? { actor: entry.actor } : {}),
      action: entry.action,
      summary: entry.summary,
    }));
}

export interface ProjectOverview {
  project: IProject;
  stats: ProjectStats;
  readiness: ProjectReadiness;
  admins: ProjectAdminEntry[];
  directory: {
    rules: Awaited<ReturnType<typeof listDirectoryProjectRules>>;
    groups: Array<{ groupId: string; name: string; role: string; source?: string }>;
  };
  activity: ProjectActivityEntry[];
  /** The default alert rules the project has; null when that could not be read. */
  defaultAlerts: { done: number; total: number } | null;
}

export async function buildProjectOverview(
  db: DatabaseProvider,
  tenantId: string,
  project: IProject,
): Promise<ProjectOverview> {
  const projectId = String(project._id);
  const [data, users, groups, policies, rules] = await Promise.all([
    loadTenantProjectData(db, tenantId, [projectId]),
    db.listUsers({ includeExternal: true }),
    db.listGroups(tenantId),
    db.listQuotaPolicies(tenantId, projectId),
    listDirectoryProjectRules(tenantId),
  ]);

  const stats = buildProjectStats([projectId], data).get(projectId)!;
  const userIndex = new Map(users.map((u) => [String(u._id), u]));

  const [rows, grants] = await Promise.all([
    db.listUserProjectsByProject(projectId),
    db.listGroupProjectsByProject(projectId),
  ]);

  // Project admins: direct rows, legacy `role: project_admin` + projectIds users, then granted groups count for readiness only.
  const adminIds = new Set<string>();
  const admins: ProjectAdminEntry[] = [];
  const pushAdmin = (user: IUser | undefined, kind: ProjectAdminEntry['kind']) => {
    if (!user) return;
    const id = String(user._id);
    if (adminIds.has(id)) return;
    adminIds.add(id);
    admins.push({ userId: id, name: user.name, email: user.email, kind });
  };
  for (const user of users) {
    if (user.role === 'owner') pushAdmin(user, 'tenant_owner');
    else if (user.role === 'admin') pushAdmin(user, 'tenant_admin');
  }
  const projectAdminUsers = new Set<string>();
  for (const row of rows) {
    if (row.role === 'project_admin') projectAdminUsers.add(String(row.userId));
  }
  for (const user of users) {
    const legacy = (user.projectIds ?? []).map(String).includes(projectId);
    if (legacy && user.role === 'project_admin') projectAdminUsers.add(String(user._id));
  }
  for (const id of projectAdminUsers) {
    const user = userIndex.get(id);
    if (user && user.role !== 'owner' && user.role !== 'admin') pushAdmin(user, 'project_admin');
  }
  const hasProjectAdmin =
    projectAdminUsers.size > 0 || grants.some((grant) => grant.role === 'project_admin');

  const tenantDomains = [...new Set(data.providers.map((p) => p.type))];
  const readiness = computeReadiness({
    stats,
    tenantDomains,
    hasProjectAdmin,
    hasLimits: policies.some((policy) => policy.enabled !== false),
  });

  const projectRules = rules
    .map((rule) => ({
      ...rule,
      projects: rule.projects.filter((p) => String(p.projectId) === projectId),
    }))
    .filter((rule) => rule.projects.length > 0);

  const projectGroups = describeProjectGroups({ grants, groups, groupMembers: data.groupMembers });

  const activity = await loadProjectActivity({
    db,
    projectId,
    userProjects: rows,
    groupGrants: grants,
    groups,
    users: userIndex,
  });

  const defaultAlerts = await db.listAlertRules(tenantId, { projectId }).then(defaultSetProgress, () => null);

  return {
    project,
    stats,
    readiness,
    admins,
    directory: {
      rules: projectRules,
      groups: projectGroups.map((g) => ({
        groupId: g.groupId,
        name: g.name,
        role: g.role,
        source: g.source,
      })),
    },
    activity,
    defaultAlerts,
  };
}
