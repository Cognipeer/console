import type { NextRequest } from 'next/server';
import { getDatabase, type IProject, type IUser } from '@/lib/database';
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
}

export async function requireProjectContext(
  request: NextRequest,
  ctx: { tenantDbName: string; tenantId: string; userId: string },
): Promise<ProjectContext> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const user = await db.findUserById(ctx.userId);
  if (!user) {
    throw new ProjectContextError('Unauthorized', 401);
  }

  const defaultProject = await ensureDefaultProject(
    ctx.tenantDbName,
    ctx.tenantId,
    ctx.userId,
  );
  const defaultProjectId = defaultProject._id ? String(defaultProject._id) : undefined;

  const cookieProjectId = request.cookies.get('active_project_id')?.value;
  let projectId = cookieProjectId || defaultProjectId;

  if (user.role === 'user' || user.role === 'project_admin') {
    const allowed = (user.projectIds ?? []).map(String);

    if (allowed.length === 0) {
      throw new ProjectContextError('No project assigned', 403);
    }

    if (!projectId || !allowed.includes(projectId)) {
      projectId = allowed[0];
    }

    if (!allowed.includes(projectId)) {
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

  return {
    projectId,
    project,
    user,
  };
}
