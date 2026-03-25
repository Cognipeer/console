import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import {
  DEFAULT_PROJECT_KEY,
  ensureDefaultProject,
  generateUniqueProjectKey,
  listAccessibleProjects,
} from '@/lib/services/projects/projectService';
import {
  readJsonBody,
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:projects');

function canManageProjects(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

async function loadTenantUser(session: ReturnType<typeof requireSessionContext>) {
  const db = await getDatabase();
  await db.switchToTenant(session.tenantDbName);
  const user = await db.findUserById(session.userId);

  return { db, user };
}

async function assertProjectAccess(params: {
  projectId: string;
  requireAdmin?: boolean;
  session: ReturnType<typeof requireSessionContext>;
}) {
  const { projectId, requireAdmin = false, session } = params;
  const db = await getDatabase();
  await db.switchToTenant(session.tenantDbName);

  const project = await db.findProjectById(projectId);
  if (!project || String(project.tenantId) !== String(session.tenantId)) {
    return { error: 'Project not found' as const, ok: false as const, status: 404 as const };
  }

  if (session.userRole === 'owner' || session.userRole === 'admin') {
    return { db, ok: true as const, project };
  }

  const user = await db.findUserById(session.userId);
  if (!user) {
    return { error: 'Unauthorized' as const, ok: false as const, status: 401 as const };
  }

  const allowedProjectIds = (user.projectIds ?? []).map(String);
  if (!allowedProjectIds.includes(String(projectId))) {
    return { error: 'Forbidden' as const, ok: false as const, status: 403 as const };
  }

  if (requireAdmin && session.userRole !== 'project_admin') {
    return { error: 'Forbidden' as const, ok: false as const, status: 403 as const };
  }

  return { db, ok: true as const, project, user };
}

export const projectsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/projects', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { user } = await loadTenantUser(session);

      if (!user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      await ensureDefaultProject(session.tenantDbName, session.tenantId, session.userId);

      const projects = await listAccessibleProjects(session.tenantDbName, session.tenantId, {
        projectIds: user.projectIds,
        role: user.role,
      });

      const activeCookie = request.cookies.active_project_id;
      const cookieIsValid = Boolean(
        activeCookie && projects.some((project) => String(project._id) === String(activeCookie)),
      );
      const cookieProject = cookieIsValid
        ? projects.find((project) => String(project._id) === String(activeCookie))
        : undefined;
      const hasNonDefaultProjects = projects.some((project) => project.key !== DEFAULT_PROJECT_KEY);
      const cookieIsDefault = Boolean(
        cookieProject?.key === DEFAULT_PROJECT_KEY && hasNonDefaultProjects,
      );

      const preferredProject = cookieIsValid && !cookieIsDefault
        ? projects.find((project) => String(project._id) === String(activeCookie))
        : (projects.find((project) => project.key !== DEFAULT_PROJECT_KEY) ?? projects[0]);

      const activeProjectId = preferredProject?._id ? String(preferredProject._id) : undefined;

      if ((activeCookie && !cookieIsValid) || cookieIsDefault) {
        if (activeProjectId) {
          reply.setCookie('active_project_id', activeProjectId, {
            httpOnly: false,
            maxAge: 60 * 60 * 24 * 30,
            path: '/',
            sameSite: 'lax',
            secure: getConfig().nodeEnv === 'production',
          });
        } else {
          reply.clearCookie('active_project_id', { path: '/' });
        }
      }

      return reply.code(200).send({ activeProjectId, projects });
    } catch (error) {
      logger.error('List projects error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/projects', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageProjects(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const name = body.name;

      if (typeof name !== 'string' || name.trim().length < 2) {
        return reply.code(400).send({ error: 'name is required' });
      }

      const projectKey = await generateUniqueProjectKey(
        session.tenantDbName,
        session.tenantId,
        (body.key as string | undefined) || name,
      );

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const project = await db.createProject({
        createdBy: session.userId,
        description: body.description as string | undefined,
        key: projectKey,
        name: name.trim(),
        tenantId: session.tenantId,
        updatedBy: session.userId,
      });

      return reply.code(201).send({ project });
    } catch (error) {
      logger.error('Create project error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/projects/active', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { user } = await loadTenantUser(session);
      if (!user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.projectId !== 'string' || body.projectId === '') {
        return reply.code(400).send({ error: 'projectId is required' });
      }

      await ensureDefaultProject(session.tenantDbName, session.tenantId, session.userId);
      const projects = await listAccessibleProjects(session.tenantDbName, session.tenantId, {
        projectIds: user.projectIds,
        role: user.role,
      });

      const allowed = projects.some((project) => String(project._id) === String(body.projectId));
      if (!allowed) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      reply.setCookie('active_project_id', body.projectId, {
        httpOnly: false,
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
        sameSite: 'lax',
        secure: getConfig().nodeEnv === 'production',
      });

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Set active project error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/projects/:projectId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageProjects(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = request.params as { projectId: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.name === undefined && body.description === undefined) {
        return reply.code(400).send({
          error: 'At least one field (name, description) is required',
        });
      }

      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 2)) {
        return reply.code(400).send({ error: 'name must be at least 2 characters' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const existing = await db.findProjectById(projectId);

      if (!existing) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const updated = await db.updateProject(projectId, {
        description: typeof body.description === 'string' ? body.description : undefined,
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        updatedBy: session.userId,
      });

      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update project' });
      }

      return reply.code(200).send({ project: updated });
    } catch (error) {
      logger.error('Update project error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/projects/:projectId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageProjects(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = request.params as { projectId: string };
      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);
      const existing = await db.findProjectById(projectId);

      if (!existing) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      if (existing.key === DEFAULT_PROJECT_KEY) {
        return reply.code(400).send({ error: 'Cannot delete the default project' });
      }

      const deleted = await db.deleteProject(projectId);
      if (!deleted) {
        return reply.code(500).send({ error: 'Failed to delete project' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete project error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/projects/:projectId/members', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const users = await access.db.listUsers();
      const members = users.filter((user) => {
        if (user.role === 'owner' || user.role === 'admin') {
          return true;
        }

        const allowed = (user.projectIds ?? []).map(String);
        return allowed.includes(String(projectId));
      });

      return reply.code(200).send({ users: members });
    } catch (error) {
      logger.error('List project members error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/projects/:projectId/members', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!['owner', 'admin', 'project_admin'].includes(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session, requireAdmin: false });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.userId !== 'string' && typeof body.email !== 'string') {
        return reply.code(400).send({ error: 'userId or email is required' });
      }

      const target = typeof body.userId === 'string'
        ? await access.db.findUserById(body.userId)
        : await access.db.findUserByEmail(String(body.email));

      if (!target || String(target.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (target.role === 'owner' || target.role === 'admin') {
        return reply.code(400).send({
          error: 'Owners and admins are implicitly assigned to all projects',
        });
      }

      const nextProjectIds = new Set((target.projectIds ?? []).map(String));
      nextProjectIds.add(String(projectId));

      const updated = await access.db.updateUser(String(target._id), {
        projectIds: Array.from(nextProjectIds),
      });

      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update user' });
      }

      return reply.code(200).send({ user: updated });
    } catch (error) {
      logger.error('Add project member error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/projects/:projectId/members', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!['owner', 'admin', 'project_admin'].includes(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session, requireAdmin: false });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.userId !== 'string' && typeof body.email !== 'string') {
        return reply.code(400).send({ error: 'userId or email is required' });
      }

      const target = typeof body.userId === 'string'
        ? await access.db.findUserById(body.userId)
        : await access.db.findUserByEmail(String(body.email));

      if (!target || String(target.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (target.role === 'owner' || target.role === 'admin') {
        return reply.code(400).send({ error: 'Cannot remove owners/admins from projects' });
      }

      const nextProjectIds = (target.projectIds ?? []).map(String).filter((id) => id !== String(projectId));
      const updated = await access.db.updateUser(String(target._id), {
        projectIds: nextProjectIds,
      });

      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update user' });
      }

      return reply.code(200).send({ user: updated });
    } catch (error) {
      logger.error('Remove project member error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/projects/:projectId/members', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageProjects(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.userId !== 'string' || typeof body.role !== 'string') {
        return reply.code(400).send({ error: 'userId and role are required' });
      }

      if (body.role !== 'user' && body.role !== 'project_admin') {
        return reply.code(400).send({ error: 'Invalid role' });
      }

      const target = await access.db.findUserById(body.userId);
      if (!target || String(target.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (target.role === 'owner' || target.role === 'admin') {
        return reply.code(400).send({ error: 'Cannot change role for owner/admin' });
      }

      const updated = await access.db.updateUser(String(target._id), {
        role: body.role,
      });

      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update user' });
      }

      return reply.code(200).send({ user: updated });
    } catch (error) {
      logger.error('Update project member role error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/projects/:projectId/member-candidates', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const query = (request.query ?? {}) as { q?: string };
      const search = query.q?.trim().toLowerCase() ?? '';
      if (search.length < 2) {
        return reply.code(200).send({ users: [] });
      }

      const users = await access.db.listUsers();
      const candidates = users
        .filter((user) => {
          if (user.role === 'owner' || user.role === 'admin') {
            return false;
          }

          return !(user.projectIds ?? []).map(String).includes(String(projectId));
        })
        .filter((user) => {
          const email = (user.email ?? '').toLowerCase();
          const name = (user.name ?? '').toLowerCase();
          return email.includes(search) || name.includes(search);
        })
        .slice(0, 10)
        .map((user) => ({
          _id: String(user._id),
          email: user.email,
          name: user.name,
        }));

      return reply.code(200).send({ users: candidates });
    } catch (error) {
      logger.error('List project member candidates error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/projects/:projectId/tokens', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageProjects(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session });
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const db = await getDatabase();
      const existingTokens = await db.listProjectApiTokens(session.tenantId, projectId);
      const quotaCheck = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: session.licenseType as LicenseType,
          projectId,
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        'apiTokens',
        existingTokens.length,
      );

      if (!quotaCheck.allowed) {
        return reply.code(429).send({
          error: quotaCheck.reason || 'API token quota exceeded',
        });
      }

      const tokens = existingTokens.map((token) => ({
        _id: token._id,
        canDelete: true,
        createdAt: token.createdAt,
        label: token.label,
        lastUsed: token.lastUsed,
        userId: token.userId,
      }));

      return reply.code(200).send({ tokens });
    } catch (error) {
      logger.error('List project tokens error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/projects/:projectId/tokens', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageProjects(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.label !== 'string' || body.label.trim().length < 3) {
        return reply.code(400).send({ error: 'Label must be at least 3 characters' });
      }

      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session });
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const db = await getDatabase();
      const token = `cpeer_${crypto.randomBytes(32).toString('hex')}`;
      const apiToken = await db.createApiToken({
        label: body.label.trim(),
        projectId,
        tenantId: session.tenantId,
        token,
        userId: session.userId,
      });

      return reply.code(201).send({
        id: apiToken._id,
        label: apiToken.label,
        message: 'API token created successfully',
        token,
      });
    } catch (error) {
      logger.error('Create project token error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/projects/:projectId/tokens/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!canManageProjects(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { id, projectId } = request.params as { id: string; projectId: string };
      const access = await assertProjectAccess({ projectId, session });
      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const db = await getDatabase();
      const deleted = await db.deleteProjectApiToken(id, session.tenantId, projectId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      return reply.code(200).send({ message: 'API token deleted successfully' });
    } catch (error) {
      logger.error('Delete project token error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
