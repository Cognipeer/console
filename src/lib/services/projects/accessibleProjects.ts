import type { DatabaseProvider } from '@/lib/database';
import { mergeServicePermissions, type UserServicePermissions } from '@/lib/security/rbac';

function getLegacyProjectIds(projectIds?: string[]): string[] {
  return (projectIds ?? []).map(String).filter(Boolean);
}

/**
 * Ids of the projects a non-admin user can access: the legacy `projectIds` on
 * the user, direct project memberships and projects inherited through groups.
 * Single source for `GET /api/projects` and the resource-usage visibility
 * filter, so the two can never disagree about "which projects can I see".
 * (Tenant owners/admins see every project and do not call this.)
 */
export async function collectAccessibleProjectIds(
  db: Pick<DatabaseProvider, 'listUserProjectsByUser' | 'listGroupMembersByUser' | 'listGroupProjectsByGroup'>,
  userId: string,
  legacyProjectIds?: string[],
): Promise<string[]> {
  const projectIds = new Set(getLegacyProjectIds(legacyProjectIds));
  const memberships = await db.listUserProjectsByUser(userId);

  for (const membership of memberships) {
    if (membership.projectId) {
      projectIds.add(String(membership.projectId));
    }
  }

  // Projects inherited through group membership (one read per group, all at once).
  const groupMemberships = await db.listGroupMembersByUser(userId);
  const assignments = await Promise.all(
    groupMemberships.map((groupMembership) => db.listGroupProjectsByGroup(String(groupMembership.groupId))),
  );
  for (const groupProjects of assignments) {
    for (const groupProject of groupProjects) {
      if (groupProject.projectId) {
        projectIds.add(String(groupProject.projectId));
      }
    }
  }

  return Array.from(projectIds);
}

/**
 * The caller's membership in ONE project, as a role plus merged service
 * overrides, built from the project assignments of the user's groups only.
 * Used by the project resolution for a user whose access to the project comes
 * through a group (no direct UserProject / legacy `projectIds` entry). Null when
 * no group of the user is assigned to the project.
 */
export async function findGroupProjectMembership(
  db: Pick<DatabaseProvider, 'listGroupMembersByUser' | 'listGroupProjectsByProject'>,
  userId: string,
  projectId: string,
): Promise<{ role: 'project_admin' | 'member'; servicePermissions: UserServicePermissions } | null> {
  const memberships = await db.listGroupMembersByUser(userId);
  if (memberships.length === 0) return null;
  const groupIds = new Set(memberships.map((m) => String(m.groupId)));
  const assignments = (await db.listGroupProjectsByProject(projectId))
    .filter((gp) => groupIds.has(String(gp.groupId)));
  if (assignments.length === 0) return null;
  return {
    role: assignments.some((gp) => gp.role === 'project_admin') ? 'project_admin' : 'member',
    servicePermissions: mergeServicePermissions(assignments.map((gp) => gp.servicePermissions)),
  };
}
