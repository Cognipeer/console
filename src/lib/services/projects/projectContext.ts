import type { NextRequest } from '@/server/api/http';
import { getDatabase, type IProject, type IUser, type IUserProject } from '@/lib/database';
import { getPrincipalContext } from '@/lib/iam/principalCache';
import type { ProjectAssignmentRow } from '@/lib/iam/projectMembership';
import { mergeServicePermissions } from '@/lib/security/rbac';
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

  // The projects a member can open: the legacy `projectIds`, the member's own
  // assignments (read fresh, so a project the member just created or joined is
  // usable at once) and the assignments of the member's groups. The group part
  // comes with the cached principal context (at most 15 s old on another node,
  // dropped at once on every group or assignment change on this node): it costs
  // no round trip on a warm request, however many groups the member is in.
  let directRows: IUserProject[] = [];
  let groupRows: ProjectAssignmentRow[] = [];
  if (!isPrivileged) {
    const [direct, principal] = await Promise.all([
      db.listUserProjectsByUser(ctx.userId),
      getPrincipalContext({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        user,
        withProjects: true,
      }),
    ]);
    directRows = direct;
    groupRows = principal.groupProjects ?? [];

    const legacyProjectIds = (user.projectIds ?? []).map(String).filter(Boolean);
    const memberProjectIds = Array.from(new Set([
      ...legacyProjectIds,
      ...directRows.map((membership) => String(membership.projectId)),
      ...groupRows.map((row) => row.projectId),
    ].filter(Boolean)));

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
      directRows.find((membership) => String(membership.projectId) === projectId)
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
      ?? groupProjectMembership(groupRows, ctx, projectId)
    );

  return {
    projectId,
    project,
    user,
    userProject,
  };
}

/** A membership synthesized from the user's group assignments of one project (null when no group of the user is assigned to it). */
function groupProjectMembership(
  rows: ReadonlyArray<ProjectAssignmentRow>,
  ctx: { tenantId: string; userId: string },
  projectId: string,
): IUserProject | null {
  const assignments = rows.filter((row) => row.projectId === projectId);
  if (assignments.length === 0) return null;
  return {
    projectId,
    role: assignments.some((row) => row.role === 'project_admin') ? 'project_admin' : 'member',
    servicePermissions: mergeServicePermissions(assignments.map((row) => row.servicePermissions)),
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
