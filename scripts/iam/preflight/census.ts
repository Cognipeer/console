/**
 * Data census: what is stored, and how much of it the upgrade touches.
 *
 * Counts only; no engine. It answers the questions an operator asks before
 * reading the per-person list: how many project assignments carry service
 * levels at all, how many of those will narrow someone on the first request,
 * how many carry a "No access" that the upgrade ignores until the row is saved
 * again, and how many API tokens belong to people in groups that grant something.
 */

import {
  getEffectiveServicePermissionWithGroups,
  normalizeServicePermissions,
  type GroupTenantGrant,
  type PermissionService,
} from '@/lib/security/rbac';
import { isPrivilegedRole, type GroupRow, type TenantData } from './data';
import { RANK, type Level } from './model';
import { ignoredNoneEntries, rowLevels, type AssignmentRow } from './oracle';

export function groupGrantOf(group: GroupRow): GroupTenantGrant | null {
  const hasServiceGrant = !!group.servicePermissions && Object.keys(group.servicePermissions as object).length > 0;
  if (group.tenantRole || hasServiceGrant) {
    return {
      tenantRole: group.tenantRole as GroupTenantGrant['tenantRole'],
      servicePermissions: group.servicePermissions as GroupTenantGrant['servicePermissions'],
    };
  }
  return null;
}

export function grantsOfUser(data: Pick<TenantData, 'groups' | 'groupIdsByUser'>, userId: string): GroupTenantGrant[] {
  const byId = new Map(data.groups.map((g) => [g.id, g]));
  const grants: GroupTenantGrant[] = [];
  for (const groupId of data.groupIdsByUser.get(userId) ?? []) {
    const group = byId.get(groupId);
    const grant = group ? groupGrantOf(group) : null;
    if (grant) grants.push(grant);
  }
  return grants;
}

export interface Census {
  users: {
    total: number;
    byRole: Record<string, number>;
    programmatic: number;
    disabled: number;
    withWorkspaceLevels: number;
    nonPrivilegedWithoutAnyProject: number;
    /** Non-privileged people who can open a project only through a group: they gain access. */
    reachProjectsOnlyThroughAGroup: number;
  };
  projects: { total: number };
  userProjects: {
    rows: number;
    withServiceLevels: number;
    /** Rows that lower somebody's workspace level from the first request. */
    narrowingFromDayOne: number;
    /** Rows whose service levels change nothing (they equal or raise the workspace level). */
    noOp: number;
    /** Rows on owners and admins (never narrowed). */
    onPrivileged: number;
    /** Rows with an explicit "No access" that the upgrade ignores until the row is saved again. */
    withIgnoredNoAccess: number;
    ignoredNoAccessEntries: number;
    /** Rows that would narrow if every ignored "No access" counted. */
    narrowingIfResaved: number;
  };
  groups: {
    total: number;
    bySource: Record<string, number>;
    withWorkspaceRole: number;
    withServiceGrants: number;
    projectAssignments: number;
    assignmentsWithServiceLevels: number;
    assignmentsWithIgnoredNoAccess: number;
    assignmentsToMissingProject: number;
  };
  tokens: {
    total: number;
    unscoped: number;
    scoped: number;
    scopedEmpty: number;
    projectBound: number;
    withoutProject: number;
    ownerMissing: number;
    ownerDisabled: number;
    expired: number;
    /** Tokens whose owner is in a group that grants something: they gain it. */
    ownerInAGroupWithGrants: number;
  };
}

const levelsIn = (raw: unknown): Record<string, Level> => normalizeServicePermissions(raw) as Record<string, Level>;

export function buildCensus(data: TenantData, now: number, since: number): Census {
  const userById = new Map(data.users.map((u) => [u.id, u]));
  const projectIds = new Set(data.projects.map((p) => p.id));

  const byRole: Record<string, number> = {};
  for (const u of data.users) byRole[u.role || '(none)'] = (byRole[u.role || '(none)'] ?? 0) + 1;

  const workspaceLevel = (userId: string, service: PermissionService): Level => {
    const user = userById.get(userId);
    if (!user) return 'none';
    return getEffectiveServicePermissionWithGroups(user, grantsOfUser(data, userId), service);
  };
  const narrowsAnyone = (userId: string, levels: Record<string, Level>): boolean =>
    Object.entries(levels).some(([service, level]) => RANK[level] < RANK[workspaceLevel(userId, service as PermissionService)]);
  const privilegedThroughGroup = (userId: string) =>
    grantsOfUser(data, userId).some((g) => isPrivilegedRole(g.tenantRole));

  let upRows = 0;
  let upWithLevels = 0;
  let upNarrow = 0;
  let upNoop = 0;
  let upPrivileged = 0;
  let upIgnoredRows = 0;
  let upIgnoredEntries = 0;
  let upNarrowIfResaved = 0;
  for (const [userId, rows] of data.userProjects) {
    const user = userById.get(userId);
    for (const row of rows as readonly AssignmentRow[]) {
      upRows++;
      const stored = levelsIn(row.servicePermissions);
      if (Object.keys(stored).length === 0) continue;
      upWithLevels++;
      const ignored = ignoredNoneEntries(row, since);
      if (ignored.length > 0) {
        upIgnoredRows++;
        upIgnoredEntries += ignored.length;
      }
      if ((user && isPrivilegedRole(user.role)) || privilegedThroughGroup(userId)) {
        upPrivileged++;
        continue;
      }
      if (narrowsAnyone(userId, rowLevels(row, since) as Record<string, Level>)) upNarrow++;
      else upNoop++;
      if (ignored.length > 0 && narrowsAnyone(userId, stored)) upNarrowIfResaved++;
    }
  }

  let gpRows = 0;
  let gpWithLevels = 0;
  let gpIgnored = 0;
  let gpMissingProject = 0;
  for (const rows of data.groupProjects.values()) {
    for (const row of rows) {
      gpRows++;
      if (!projectIds.has(String(row.projectId))) gpMissingProject++;
      if (Object.keys(levelsIn(row.servicePermissions)).length > 0) gpWithLevels++;
      if (ignoredNoneEntries(row, since).length > 0) gpIgnored++;
    }
  }

  const nonPrivileged = data.users.filter((u) => !isPrivilegedRole(u.role));
  const hasOwnProject = (u: (typeof data.users)[number]) =>
    (u.projectIds ?? []).length > 0 || (data.userProjects.get(u.id) ?? []).length > 0;
  const withoutAnyProject = nonPrivileged.filter((u) => !hasOwnProject(u));
  const groupOnly = withoutAnyProject.filter((u) =>
    (data.groupIdsByUser.get(u.id) ?? []).some((groupId) => (data.groupProjects.get(groupId) ?? []).length > 0));

  const scoped = data.tokens.filter((t) => t.servicePermissions != null);
  const hasGrantingGroup = (userId: string) => grantsOfUser(data, userId).length > 0;
  const expired = (t: (typeof data.tokens)[number]) =>
    !!t.expiresAt && new Date(t.expiresAt as never).getTime() <= now;

  const groupsBySource: Record<string, number> = {};
  for (const g of data.groups) groupsBySource[g.source ?? 'local'] = (groupsBySource[g.source ?? 'local'] ?? 0) + 1;

  return {
    users: {
      total: data.users.length,
      byRole,
      programmatic: data.users.filter((u) => u.canLogin === false).length,
      disabled: data.users.filter((u) => u.status === 'disabled').length,
      withWorkspaceLevels: data.users.filter((u) => Object.keys(levelsIn(u.servicePermissions)).length > 0).length,
      nonPrivilegedWithoutAnyProject: withoutAnyProject.length,
      reachProjectsOnlyThroughAGroup: groupOnly.length,
    },
    projects: { total: data.projects.length },
    userProjects: {
      rows: upRows,
      withServiceLevels: upWithLevels,
      narrowingFromDayOne: upNarrow,
      noOp: upNoop,
      onPrivileged: upPrivileged,
      withIgnoredNoAccess: upIgnoredRows,
      ignoredNoAccessEntries: upIgnoredEntries,
      narrowingIfResaved: upNarrowIfResaved,
    },
    groups: {
      total: data.groups.length,
      bySource: groupsBySource,
      withWorkspaceRole: data.groups.filter((g) => !!g.tenantRole).length,
      withServiceGrants: data.groups.filter((g) => Object.keys(levelsIn(g.servicePermissions)).length > 0).length,
      projectAssignments: gpRows,
      assignmentsWithServiceLevels: gpWithLevels,
      assignmentsWithIgnoredNoAccess: gpIgnored,
      assignmentsToMissingProject: gpMissingProject,
    },
    tokens: {
      total: data.tokens.length,
      unscoped: data.tokens.length - scoped.length,
      scoped: scoped.length,
      scopedEmpty: scoped.filter((t) => Object.keys((t.servicePermissions ?? {}) as object).length === 0).length,
      projectBound: data.tokens.filter((t) => !!t.projectId).length,
      withoutProject: data.tokens.filter((t) => !t.projectId).length,
      ownerMissing: data.tokens.filter((t) => !userById.has(t.userId)).length,
      ownerDisabled: data.tokens.filter((t) => userById.get(t.userId)?.status === 'disabled').length,
      expired: data.tokens.filter(expired).length,
      ownerInAGroupWithGrants: data.tokens.filter((t) => hasGrantingGroup(t.userId)).length,
    },
  };
}
