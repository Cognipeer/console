/**
 * View model of the project Members tab: a tolerant parser for
 * `GET /api/projects/:projectId/members`, the source of every row, the filter
 * chips and the bulk request. Pure of React and Next (the node tests drive it).
 */

import { asArray, asId, asNumber, asRecord, asString } from '@/components/iam/principals/client';
import { normalizeServicePermissions } from '@/lib/security/rbac';
import type { UserServicePermissions } from '@/lib/security/rbac';

export type ProjectRoleValue = 'member' | 'project_admin';
export type MemberSource = 'manual' | 'directory';

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  /** Workspace role. */
  role: string;
  projectRole: ProjectRoleValue;
  implicit: boolean;
  source: MemberSource;
  servicePermissions: UserServicePermissions | null;
  ignoredServices: string[];
}

export interface GroupGrantRow {
  groupId: string;
  name: string;
  role: ProjectRoleValue;
  memberCount: number;
  directorySynced: boolean;
}

export interface TenantAdminRow {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin';
}

export interface MemberCapabilities {
  canAssignMembers: boolean;
  canInviteMembers: boolean;
  canManagePermissions: boolean;
  canManageRoles: boolean;
  canRemoveMembers: boolean;
  isProjectAdmin: boolean;
  isTenantAdmin: boolean;
}

export const NO_CAPABILITIES: MemberCapabilities = {
  canAssignMembers: false,
  canInviteMembers: false,
  canManagePermissions: false,
  canManageRoles: false,
  canRemoveMembers: false,
  isProjectAdmin: false,
  isTenantAdmin: false,
};

export interface ProjectMembersData {
  members: MemberRow[];
  groups: GroupGrantRow[];
  tenantAdmins: TenantAdminRow[];
  capabilities: MemberCapabilities;
}

const toRole = (value: unknown): ProjectRoleValue => (value === 'project_admin' ? 'project_admin' : 'member');

export function parseMembers(raw: unknown): ProjectMembersData {
  const r = asRecord(raw);
  const caps = asRecord(r.capabilities);
  const capabilities: MemberCapabilities = { ...NO_CAPABILITIES };
  for (const key of Object.keys(NO_CAPABILITIES) as Array<keyof MemberCapabilities>) {
    capabilities[key] = caps[key] === true;
  }

  const members = asArray(r.members).flatMap((entry): MemberRow[] => {
    const m = asRecord(entry);
    const userId = asId(m.userId);
    if (!userId) return [];
    return [
      {
        userId,
        name: asString(m.name) ?? '',
        email: asString(m.email) ?? '',
        role: asString(m.role) ?? 'user',
        projectRole: toRole(m.projectRole),
        implicit: m.implicit === true,
        source: m.source === 'directory' ? 'directory' : 'manual',
        servicePermissions:
          m.servicePermissions && typeof m.servicePermissions === 'object'
            ? normalizeServicePermissions(m.servicePermissions)
            : null,
        ignoredServices: asArray(m.ignoredServices).filter((x): x is string => typeof x === 'string'),
      },
    ];
  });

  const groups = asArray(r.groups).flatMap((entry): GroupGrantRow[] => {
    const g = asRecord(entry);
    const groupId = asId(g.groupId);
    if (!groupId) return [];
    return [
      {
        groupId,
        name: asString(g.name) ?? groupId,
        role: toRole(g.role),
        memberCount: asNumber(g.memberCount) ?? 0,
        directorySynced: g.directorySynced === true,
      },
    ];
  });

  const tenantAdmins = asArray(r.tenantAdmins).flatMap((entry): TenantAdminRow[] => {
    const a = asRecord(entry);
    const userId = asId(a.userId);
    if (!userId) return [];
    return [
      { userId, name: asString(a.name) ?? '', email: asString(a.email) ?? '', role: a.role === 'owner' ? 'owner' : 'admin' },
    ];
  });

  return { members, groups, tenantAdmins, capabilities };
}

// ── grid rows ─────────────────────────────────────────────────────────────

export type GridRow =
  | { key: string; kind: 'user'; member: MemberRow }
  | { key: string; kind: 'group'; group: GroupGrantRow };

export type SourceFilter = 'all' | 'direct' | 'group' | 'directory' | 'admins';
export const SOURCE_FILTERS: readonly SourceFilter[] = ['all', 'direct', 'group', 'directory', 'admins'];

export const userKey = (userId: string) => `u:${userId}`;
export const groupKey = (groupId: string) => `g:${groupId}`;

/** Implicit access (owners and admins) is shown apart: it has no row to change. */
export function buildRows(data: Pick<ProjectMembersData, 'members' | 'groups'>): GridRow[] {
  const users = data.members
    .filter((m) => !m.implicit)
    .map((member): GridRow => ({ key: userKey(member.userId), kind: 'user', member }));
  const groups = data.groups.map((group): GridRow => ({ key: groupKey(group.groupId), kind: 'group', group }));
  return [...users, ...groups];
}

/** Where a row comes from: by hand, through a group, or through the SSO / LDAP default project. */
export function rowSource(row: GridRow): 'direct' | 'group' | 'directory' {
  if (row.kind === 'group') return 'group';
  return row.member.source === 'directory' ? 'directory' : 'direct';
}

export function rowRole(row: GridRow): ProjectRoleValue {
  return row.kind === 'group' ? row.group.role : row.member.projectRole;
}

export function matchesFilter(row: GridRow, filter: SourceFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'admins':
      return rowRole(row) === 'project_admin';
    default:
      return rowSource(row) === filter;
  }
}

export function matchesQuery(row: GridRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = row.kind === 'group' ? [row.group.name] : [row.member.name, row.member.email];
  return hay.some((value) => value.toLowerCase().includes(q));
}

export function filterRows(rows: GridRow[], filter: SourceFilter, query: string): GridRow[] {
  return rows.filter((row) => matchesFilter(row, filter) && matchesQuery(row, query));
}

export function filterCounts(rows: GridRow[]): Record<SourceFilter, number> {
  const counts: Record<SourceFilter, number> = { all: rows.length, direct: 0, group: 0, directory: 0, admins: 0 };
  for (const row of rows) {
    counts[rowSource(row)] += 1;
    if (rowRole(row) === 'project_admin') counts.admins += 1;
  }
  return counts;
}

// ── bulk ──────────────────────────────────────────────────────────────────

export interface BulkSelection {
  /** Ids of selected people (rows that can be changed). */
  userIds: string[];
  /** Ids of selected groups. */
  groupIds: string[];
}

export function splitSelection(rows: GridRow[], selected: ReadonlySet<string>): BulkSelection {
  const userIds: string[] = [];
  const groupIds: string[] = [];
  for (const row of rows) {
    if (!selected.has(row.key)) continue;
    if (row.kind === 'user') userIds.push(row.member.userId);
    else groupIds.push(row.group.groupId);
  }
  return { userIds, groupIds };
}

export interface BulkRequestBody {
  add?: Array<{ userId: string; role: ProjectRoleValue }>;
  remove?: string[];
  setRole?: Array<{ userId: string; role: ProjectRoleValue }>;
}

export function bulkRoleBody(userIds: readonly string[], role: ProjectRoleValue): BulkRequestBody {
  return { setRole: userIds.map((userId) => ({ userId, role })) };
}

export function bulkRemoveBody(userIds: readonly string[]): BulkRequestBody {
  return { remove: [...userIds] };
}

export interface BulkResult {
  added: number;
  removed: number;
  updated: number;
  warnings: string[];
}

export function parseBulkResult(raw: unknown): BulkResult {
  const r = asRecord(raw);
  return {
    added: asNumber(r.added) ?? 0,
    removed: asNumber(r.removed) ?? 0,
    updated: asNumber(r.updated) ?? 0,
    warnings: asArray(r.warnings).filter((x): x is string => typeof x === 'string'),
  };
}
