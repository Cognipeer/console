import type { DatabaseProvider } from '@/lib/database';

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

  // Projects inherited through group membership.
  const groupMemberships = await db.listGroupMembersByUser(userId);
  for (const groupMembership of groupMemberships) {
    const groupProjects = await db.listGroupProjectsByGroup(String(groupMembership.groupId));
    for (const groupProject of groupProjects) {
      if (groupProject.projectId) {
        projectIds.add(String(groupProject.projectId));
      }
    }
  }

  return Array.from(projectIds);
}
