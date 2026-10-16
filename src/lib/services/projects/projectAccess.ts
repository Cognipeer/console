/**
 * Project access rules, shared by the dashboard and API-token authentication.
 *
 * A user reaches a project when any of these holds:
 *   - they are a tenant `owner` or `admin` (implicit access to every project);
 *   - a UserProject membership row names them;
 *   - the project id is in their legacy `projectIds` list;
 *   - a group they belong to is assigned to the project.
 *
 * The project list, the member-management screens and token authentication all
 * resolve access here, so they cannot disagree about who may work in a project.
 */
import type { DatabaseProvider, IUser, ProjectRole } from '@/lib/database';
import type { UserServicePermissions } from '@/lib/security/rbac';
import { mergeServicePermissions } from '@/lib/security/rbac';

// One implementation of "which projects can this user see", shared with the project list and the usage filter.
export { collectAccessibleProjectIds } from './accessibleProjects';

/** Roles that reach every project in the tenant without a membership. */
export function hasImplicitProjectAccess(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function getLegacyProjectIds(projectIds?: string[]): string[] {
  return (projectIds ?? []).map(String).filter(Boolean);
}

/**
 * Resolves the strongest project role + merged service overrides a user has for
 * a project, unioning direct UserProject membership, legacy projectIds, and any
 * group→project assignment the user inherits. Returns null when none apply.
 */
export async function resolveProjectMembership(
  db: DatabaseProvider,
  params: { userId: string; userRole: string; projectId: string; legacyProjectIds?: string[] },
): Promise<{ role: ProjectRole; servicePermissions?: UserServicePermissions } | null> {
  const { userId, userRole, projectId, legacyProjectIds } = params;
  const sources: Array<{ role: ProjectRole; servicePermissions?: UserServicePermissions | null }> = [];

  const direct = await db.findUserProject(userId, projectId);
  if (direct) {
    sources.push({ role: direct.role, servicePermissions: direct.servicePermissions });
  } else if (getLegacyProjectIds(legacyProjectIds).includes(String(projectId))) {
    sources.push({ role: userRole === 'project_admin' ? 'project_admin' : 'member' });
  }

  const groupMemberships = await db.listGroupMembersByUser(userId);
  if (groupMemberships.length > 0) {
    const groupIds = new Set(groupMemberships.map((m) => String(m.groupId)));
    const groupProjects = await db.listGroupProjectsByProject(projectId);
    for (const groupProject of groupProjects) {
      if (groupIds.has(String(groupProject.groupId))) {
        sources.push({ role: groupProject.role, servicePermissions: groupProject.servicePermissions });
      }
    }
  }

  if (sources.length === 0) return null;

  const role: ProjectRole = sources.some((s) => s.role === 'project_admin') ? 'project_admin' : 'member';
  const servicePermissions = mergeServicePermissions(sources.map((s) => s.servicePermissions));
  return { role, servicePermissions };
}

/**
 * Whether a user can work in a project: the same answer as
 * `resolveProjectMembership(...) !== null` (or an implicit-access role), but it
 * stops at the first source that grants access. Token authentication calls this
 * on every request, so the common cases cost no query (privileged role, legacy
 * list) or one (membership row); group lookups run only when the cheaper
 * sources do not already answer.
 */
export async function canAccessProject(
  db: DatabaseProvider,
  params: { userId: string; userRole: string | undefined; projectId: string; legacyProjectIds?: string[] },
): Promise<boolean> {
  const { userId, userRole, legacyProjectIds } = params;
  const projectId = String(params.projectId);

  if (hasImplicitProjectAccess(userRole)) return true;
  if (getLegacyProjectIds(legacyProjectIds).includes(projectId)) return true;
  if (await db.findUserProject(userId, projectId)) return true;

  const groupMemberships = await db.listGroupMembersByUser(userId);
  if (groupMemberships.length === 0) return false;

  const groupIds = new Set(groupMemberships.map((m) => String(m.groupId)));
  const groupProjects = await db.listGroupProjectsByProject(projectId);
  return groupProjects.some((groupProject) => groupIds.has(String(groupProject.groupId)));
}

/**
 * A login-disabled ("programmatic") account has no session and no project
 * picker: an API token an administrator minted for it is its only way in.
 */
export function isProgrammaticUser(user: Pick<IUser, 'canLogin'>): boolean {
  return user.canLogin === false;
}

/**
 * Whether the owner of an API token may use it in the project the token is
 * bound to. Used when a token is minted for another user and on every token
 * request.
 *
 * Login-capable owners follow the dashboard rule ({@link canAccessProject}).
 * For a programmatic owner the token itself is the project grant (it exists
 * only because an administrator minted it in that project), so there is no
 * membership to consult; removing the account from the project revokes the
 * tokens bound to it instead (see `removeProjectMember`).
 */
export async function canTokenOwnerAccessProject(
  db: DatabaseProvider,
  owner: Pick<IUser, '_id' | 'role' | 'canLogin' | 'projectIds'>,
  projectId: string,
): Promise<boolean> {
  if (isProgrammaticUser(owner)) return true;

  return canAccessProject(db, {
    userId: String(owner._id ?? ''),
    userRole: owner.role,
    projectId,
    legacyProjectIds: owner.projectIds,
  });
}
