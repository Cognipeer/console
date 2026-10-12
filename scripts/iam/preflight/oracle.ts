/**
 * An independent check of what the engine will decide, worked out from the
 * stored rows with plain arithmetic - no Cedar, no principal cache, no
 * project-narrowing module:
 *
 *   effective = min( workspace level            (role, own permissions, group grants),
 *                    token scope                (tokens only: a cap),
 *                    project level              (members who are not owners or admins) )
 *
 * where the workspace level of an API token includes its owner's group grants,
 * and a project level is the highest level any of the member's assignments to
 * the project names for the service (a row saved before the upgrade does not
 * count its explicit "No access").
 *
 * The report compares this with the engine on every decision. They are written
 * apart on purpose: if they ever disagree, one of them is wrong, and the report
 * says so instead of printing a confident table.
 */

import {
  getEffectiveServicePermissionWithGroups,
  getRequiredPermissionLevel,
  minPermission,
  normalizeServicePermissions,
  type GroupTenantGrant,
  type PermissionService,
  type RbacUserLike,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { CHECKS, RANK, type Checks, type Level } from './model';

export interface AssignmentRow {
  projectId: string;
  servicePermissions?: unknown;
  updatedAt?: Date | string | number | null;
}

export interface OracleInput {
  user: RbacUserLike & { projectIds?: readonly string[] };
  kind: 'session' | 'token';
  /** Grants of the groups that apply: a person's groups; for a token the OWNER's groups. */
  groupGrants: readonly GroupTenantGrant[];
  /** The token scope (a cap); null / undefined = a person or an unscoped token. */
  tokenScope?: UserServicePermissions | null;
  /** The project the request names: the cookie (person), or the token's own / the default project (token). */
  requestedProjectId: string | null;
  defaultProjectId: string | null;
  direct: readonly AssignmentRow[];
  group: readonly AssignmentRow[];
  /** Activation instant (ms): a row last saved before it does not count its explicit "No access". */
  since: number;
}

const isOwnerOrAdmin = (role: string | undefined) => role === 'owner' || role === 'admin';

/** Was the row last saved before `since`? A row without a usable date counts as older than everything. */
export function savedBefore(updatedAt: AssignmentRow['updatedAt'], since: number): boolean {
  if (updatedAt === null || updatedAt === undefined || updatedAt === '') return true;
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return !Number.isFinite(ms) || ms < since;
}

/** The levels of one assignment row as the upgrade reads them. */
export function rowLevels(row: AssignmentRow, since: number): UserServicePermissions {
  const levels = normalizeServicePermissions(row.servicePermissions);
  if (!savedBefore(row.updatedAt, since)) return levels;
  const kept: UserServicePermissions = {};
  for (const [service, level] of Object.entries(levels) as Array<[PermissionService, Level]>) {
    if (level !== 'none') kept[service] = level;
  }
  return kept;
}

/** Entries an upgrade ignores: the explicit "No access" of a row saved before `since`. */
export function ignoredNoneEntries(row: AssignmentRow, since: number): PermissionService[] {
  if (!savedBefore(row.updatedAt, since)) return [];
  const levels = normalizeServicePermissions(row.servicePermissions);
  return (Object.entries(levels) as Array<[PermissionService, Level]>)
    .filter(([, level]) => level === 'none')
    .map(([service]) => service);
}

export function highestPerService(maps: ReadonlyArray<UserServicePermissions>): UserServicePermissions {
  const out: UserServicePermissions = {};
  for (const map of maps) {
    for (const [service, level] of Object.entries(map) as Array<[PermissionService, Level]>) {
      const current = out[service];
      if (!current || RANK[level] > RANK[current]) out[service] = level;
    }
  }
  return out;
}

export interface OracleMembership {
  projectId: string;
  levels: UserServicePermissions;
}

/** Owners, admins and members who are admin through a group are never narrowed by a project. */
export function isNeverNarrowed(user: RbacUserLike, groupGrants: readonly GroupTenantGrant[]): boolean {
  return isOwnerOrAdmin(user.role) || groupGrants.some((g) => isOwnerOrAdmin(g.tenantRole));
}

/** The membership that narrows the request, or null when nothing does. */
export function oracleMembership(input: OracleInput): OracleMembership | null {
  if (isNeverNarrowed(input.user, input.groupGrants)) return null;

  const legacy = (input.user.projectIds ?? []).map(String).filter(Boolean);
  const members: string[] = [];
  for (const id of [...legacy, ...input.direct.map((r) => String(r.projectId)), ...input.group.map((r) => String(r.projectId))]) {
    if (id && !members.includes(id)) members.push(id);
  }
  if (members.length === 0) return null;

  let projectId: string | undefined;
  if (input.kind === 'token') {
    projectId = input.requestedProjectId && members.includes(input.requestedProjectId) ? input.requestedProjectId : undefined;
  } else {
    const wanted = input.requestedProjectId || input.defaultProjectId || undefined;
    projectId = wanted && members.includes(wanted) ? wanted : members[0];
  }
  if (!projectId) return null;

  const sources: UserServicePermissions[] = [];
  let any = false;
  const direct = input.direct.find((r) => String(r.projectId) === projectId);
  if (direct) {
    any = true;
    sources.push(rowLevels(direct, input.since));
  } else if (legacy.includes(projectId)) {
    any = true;
  }
  for (const row of input.group) {
    if (String(row.projectId) === projectId) {
      any = true;
      sources.push(rowLevels(row, input.since));
    }
  }
  return any ? { projectId, levels: highestPerService(sources) } : null;
}

/** The level the rules above give one service. */
export function oracleLevel(input: OracleInput, service: PermissionService, membership: OracleMembership | null): Level {
  let level = getEffectiveServicePermissionWithGroups(input.user, [...input.groupGrants], service);
  if (input.tokenScope != null) {
    level = minPermission(level, normalizeServicePermissions(input.tokenScope)[service] ?? 'none');
  }
  const explicit = membership?.levels[service];
  if (explicit && RANK[explicit] < RANK[level]) level = explicit;
  return level;
}

export function oracleChecks(input: OracleInput, service: PermissionService, membership: OracleMembership | null): Checks {
  const level = oracleLevel(input, service, membership);
  const out: Checks = { read: false, write: false, admin: false };
  for (const check of CHECKS) {
    const required: Level = check.level ?? getRequiredPermissionLevel(check.method, service);
    out[check.id] = RANK[level] >= RANK[required];
  }
  return out;
}
