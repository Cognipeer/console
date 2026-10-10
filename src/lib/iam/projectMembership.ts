/**
 * The caller's membership in ONE project, resolved exactly like the live project
 * endpoints do (plugins/projects.ts `resolveProjectMembership`): the direct
 * assignment (else the legacy `projectIds` entry), plus every group assignment of
 * the user's groups; the strongest role wins and the service levels are merged
 * (highest level per service).
 *
 * Pure: the assignment rows come with the cached principal context
 * (principalCache.ts), which loads them once per TTL and drops them on the same
 * invalidation events as the rest of the principal. Resolving a membership is
 * therefore a few array scans, not a database round trip - the gate resolves one
 * on every request of a member.
 *
 * The explicit `none` entries of rows that predate the engine are read as "not
 * set" (projectLevels.ts): `since` is the workspace's activation instant.
 */

import {
  mergeServicePermissions,
  type ProjectRole,
  type RbacProjectLike,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { effectiveProjectLevels } from './projectLevels';

/** One project assignment, direct (user -> project) or inherited (group -> project). */
export interface ProjectAssignmentRow {
  projectId: string;
  role: ProjectRole;
  servicePermissions?: UserServicePermissions | null;
  /** Last save of the row: decides whether its explicit `none` entries count (projectLevels.ts). */
  updatedAt?: Date | string | null;
  /** Group assignments only. */
  groupId?: string;
}

export interface ProjectMembershipInput {
  projectId: string;
  userRole: string;
  /** `projectIds` on the user row (assignments made before project memberships had their own table). */
  legacyProjectIds?: string[];
  /** The user's direct assignments (all projects). */
  userProjects: ReadonlyArray<ProjectAssignmentRow>;
  /** The assignments of the user's groups (all projects). */
  groupProjects: ReadonlyArray<ProjectAssignmentRow>;
  /** Activation instant of the workspace (projectLevels.ts). */
  since: number;
}

export function resolveProjectMembership(input: ProjectMembershipInput): RbacProjectLike | null {
  const projectId = String(input.projectId);
  const sources: Array<{ role: ProjectRole; servicePermissions: UserServicePermissions }> = [];

  const direct = input.userProjects.find((row) => String(row.projectId) === projectId);
  if (direct) {
    sources.push({ role: direct.role, servicePermissions: effectiveProjectLevels(direct, input.since) });
  } else if ((input.legacyProjectIds ?? []).map(String).includes(projectId)) {
    sources.push({ role: input.userRole === 'project_admin' ? 'project_admin' : 'member', servicePermissions: {} });
  }
  for (const row of input.groupProjects) {
    if (String(row.projectId) === projectId) {
      sources.push({ role: row.role, servicePermissions: effectiveProjectLevels(row, input.since) });
    }
  }
  if (sources.length === 0) return null;
  const role: ProjectRole = sources.some((s) => s.role === 'project_admin') ? 'project_admin' : 'member';
  return { role, servicePermissions: mergeServicePermissions(sources.map((s) => s.servicePermissions)) };
}
