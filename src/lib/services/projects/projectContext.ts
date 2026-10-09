import type { NextRequest } from '@/server/api/http';
import { getDatabase, type IProject, type IUser, type IUserProject } from '@/lib/database';
import { resolveEnforcement } from '@/lib/iam/shadow/mode';
import { collectAccessibleProjectIds, findGroupProjectMembership } from './accessibleProjects';
import { ensureDefaultProject } from './projectService';

export class ProjectContextError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ProjectContextError';
    this.status = status;
  }
}

export interface ProjectContext {
  projectId: string;
  project: IProject;
  user: IUser;
  /** Membership record for the active project. Null for owners/admins (implicit access). */
  userProject: IUserProject | null;
}

export async function resolveProjectContext(
  ctx: {
    tenantDbName: string;
    tenantId: string;
    userId: string;
    activeProjectId?: string;
  },
): Promise<ProjectContext> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const user = await db.findUserById(ctx.userId);
  if (!user) {
    throw new ProjectContextError('Unauthorized', 401);
  }

  const isPrivileged = user.role === 'owner' || user.role === 'admin';

  const defaultProject = await ensureDefaultProject(
    ctx.tenantDbName,
    ctx.tenantId,
    ctx.userId,
  );
  const defaultProjectId = defaultProject._id ? String(defaultProject._id) : undefined;

  let projectId = ctx.activeProjectId || defaultProjectId;

  // Enforce-mode tenants (authorization engine, see lib/iam): project access
  // also comes through groups. Legacy tenants keep the UserProject/legacy
  // `projectIds` resolution below, byte for byte.
  const groupAware = !isPrivileged && await resolveEnforcement(ctx.tenantDbName);

  if (!isPrivileged) {
    // Resolve project access via UserProject membership records
    const legacyProjectIds = (user.projectIds ?? []).map(String).filter(Boolean);
    const memberProjectIds = groupAware
      ? await collectAccessibleProjectIds(db, ctx.userId, user.projectIds)
      : Array.from(new Set([
        ...legacyProjectIds,
        ...(await db.listUserProjectsByUser(ctx.userId)).map((membership) => membership.projectId),
      ]));

    if (memberProjectIds.length === 0) {
      throw new ProjectContextError('No project assigned', 403);
    }

    if (!projectId || !memberProjectIds.includes(projectId)) {
      projectId = memberProjectIds[0];
    }

    if (!projectId || !memberProjectIds.includes(projectId)) {
      throw new ProjectContextError('Forbidden', 403);
    }
  }

  if (!projectId) {
    throw new ProjectContextError('Project context is missing', 400);
  }

  const project = await db.findProjectById(projectId);
  if (!project) {
    throw new ProjectContextError('Project not found', 404);
  }

  const userProject = isPrivileged
    ? null
    : (
      (await db.findUserProject(ctx.userId, projectId))
      ?? (
        (user.projectIds ?? []).map(String).includes(projectId)
          ? {
              projectId,
              role: user.role === 'project_admin' ? 'project_admin' : 'member',
              servicePermissions: undefined,
              tenantId: ctx.tenantId,
              userId: ctx.userId,
            }
          : null
      )
      ?? (groupAware ? await groupProjectMembership(db, ctx, projectId) : null)
    );

  return {
    projectId,
    project,
    user,
    userProject,
  };
}

/** A membership synthesized from the user's group assignments (enforce-mode tenants only). */
async function groupProjectMembership(
  db: Awaited<ReturnType<typeof getDatabase>>,
  ctx: { tenantId: string; userId: string },
  projectId: string,
): Promise<IUserProject | null> {
  const membership = await findGroupProjectMembership(db, ctx.userId, projectId);
  if (!membership) return null;
  return {
    projectId,
    role: membership.role,
    servicePermissions: membership.servicePermissions,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  } as IUserProject;
}

export async function requireProjectContext(
  request: NextRequest,
  ctx: { tenantDbName: string; tenantId: string; userId: string },
): Promise<ProjectContext> {
  return resolveProjectContext({
    ...ctx,
    activeProjectId: request.cookies.get('active_project_id')?.value,
  });
}
