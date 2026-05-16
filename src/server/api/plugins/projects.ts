import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import {
  DEFAULT_PROJECT_KEY,
  ensureDefaultProject,
  generateUniqueProjectKey,
  listAccessibleProjects,
} from '@/lib/services/projects/projectService';
import type { ProjectRole } from '@/lib/database/provider/types.base';
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

/**
 * Checks project existence + tenant match, then verifies the requesting user has access.
 * Owners and admins always pass. Regular users must have a UserProject membership record.
 */
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
    return { db, ok: true as const, project, userProject: null };
  }

  const userProject = await db.findUserProject(session.userId, projectId);
  if (!userProject) {
    return { error: 'Forbidden' as const, ok: false as const, status: 403 as const };
  }

  if (requireAdmin && userProject.role !== 'project_admin') {
    return { error: 'Forbidden' as const, ok: false as const, status: 403 as const };
  }

  return { db, ok: true as const, project, userProject };
}

export const projectsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/projects', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { db, user } = await loadTenantUser(session);

      if (!user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      await ensureDefaultProject(session.tenantDbName, session.tenantId, session.userId);

      // Collect project IDs accessible to this user
      let projectIds: string[] | undefined;
      if (user.role !== 'owner' && user.role !== 'admin') {
        const memberships = await db.listUserProjectsByUser(session.userId);
        projectIds = memberships.map((m) => m.projectId);
      }

      const projects = await listAccessibleProjects(session.tenantDbName, session.tenantId, {
        projectIds,
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

      const existingProjects = await db.listProjects(session.tenantId);
      const quotaCheck = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: session.licenseType as LicenseType,
          projectId: existingProjects[0]?._id ? String(existingProjects[0]._id) : 'tenant',
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        'projects',
        existingProjects.length,
      );

      if (!quotaCheck.allowed) {
        return reply.code(429).send({
          error: quotaCheck.reason || 'Project quota exceeded',
        });
      }

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
      const { db, user } = await loadTenantUser(session);
      if (!user) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.projectId !== 'string' || body.projectId === '') {
        return reply.code(400).send({ error: 'projectId is required' });
      }

      await ensureDefaultProject(session.tenantDbName, session.tenantId, session.userId);

      let projectIds: string[] | undefined;
      if (user.role !== 'owner' && user.role !== 'admin') {
        const memberships = await db.listUserProjectsByUser(session.userId);
        projectIds = memberships.map((m) => m.projectId);
      }

      const projects = await listAccessibleProjects(session.tenantDbName, session.tenantId, {
        projectIds,
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

      // Clean up all membership records for this project
      await db.deleteUserProjectsByProject(projectId);

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete project error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Project Members ──────────────────────────────────────────────────────

  app.get('/projects/:projectId/members', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      // Load all tenant users to enrich membership records
      const allUsers = await access.db.listUsers();
      const userById = new Map(allUsers.map((u) => [String(u._id), u]));

      // Owners and admins are always implicit members
      const privileged = allUsers
        .filter((u) => u.role === 'owner' || u.role === 'admin')
        .map((u) => ({
          userId: String(u._id),
          email: u.email,
          name: u.name,
          role: u.role as string,
          projectRole: null as ProjectRole | null,
          servicePermissions: null,
          implicit: true,
        }));

      // Explicit members via UserProject records
      const memberships = await access.db.listUserProjectsByProject(projectId);
      const explicit = memberships
        .map((m) => {
          const user = userById.get(m.userId);
          if (!user) return null;
          return {
            userId: String(user._id),
            email: user.email,
            name: user.name,
            role: user.role as string,
            projectRole: m.role,
            servicePermissions: m.servicePermissions ?? null,
            implicit: false,
          };
        })
        .filter(Boolean);

      // Deduplicate: privileged users already covered above
      const privilegedIds = new Set(privileged.map((p) => p.userId));
      const members = [
        ...privileged,
        ...explicit.filter((m) => m && !privilegedIds.has(m.userId)),
      ];

      return reply.code(200).send({ members });
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

      // project_admin can only add if they are themselves a member
      if (session.userRole === 'project_admin' && !access.userProject) {
        return reply.code(403).send({ error: 'Forbidden' });
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

      const role: ProjectRole = (body.role === 'project_admin') ? 'project_admin' : 'member';

      const userProject = await access.db.upsertUserProject({
        tenantId: session.tenantId,
        userId: String(target._id),
        projectId,
        role,
        servicePermissions: undefined,
        invitedBy: session.userId,
      });

      return reply.code(200).send({ userProject });
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

      const removed = await access.db.deleteUserProject(String(target._id), projectId);
      if (!removed) {
        return reply.code(404).send({ error: 'Membership not found' });
      }

      return reply.code(200).send({ success: true });
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
      if (typeof body.userId !== 'string') {
        return reply.code(400).send({ error: 'userId is required' });
      }

      if (body.role !== 'member' && body.role !== 'project_admin') {
        return reply.code(400).send({ error: 'role must be "member" or "project_admin"' });
      }

      const target = await access.db.findUserById(body.userId);
      if (!target || String(target.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (target.role === 'owner' || target.role === 'admin') {
        return reply.code(400).send({ error: 'Cannot change role for owner/admin' });
      }

      const existing = await access.db.findUserProject(body.userId, projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Membership not found' });
      }

      const updated = await access.db.upsertUserProject({
        tenantId: session.tenantId,
        userId: body.userId,
        projectId,
        role: body.role as ProjectRole,
        servicePermissions: existing.servicePermissions,
        invitedBy: existing.invitedBy,
      });

      return reply.code(200).send({ userProject: updated });
    } catch (error) {
      logger.error('Update project member role error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/projects/:projectId/members/permissions', withApiRequestContext(async (request, reply) => {
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
      if (typeof body.userId !== 'string') {
        return reply.code(400).send({ error: 'userId is required' });
      }

      const target = await access.db.findUserById(body.userId);
      if (!target || String(target.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const existing = await access.db.findUserProject(body.userId, projectId);
      if (!existing) {
        return reply.code(404).send({ error: 'Membership not found' });
      }

      const updated = await access.db.upsertUserProject({
        tenantId: session.tenantId,
        userId: body.userId,
        projectId,
        role: existing.role,
        servicePermissions: (body.servicePermissions as Record<string, string> | undefined) ?? {},
        invitedBy: existing.invitedBy,
      });

      return reply.code(200).send({ userProject: updated });
    } catch (error) {
      logger.error('Update project member permissions error', { error });
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

      // Users who already have an explicit membership in this project
      const memberships = await access.db.listUserProjectsByProject(projectId);
      const alreadyMemberIds = new Set(memberships.map((m) => m.userId));

      const users = await access.db.listUsers();
      const candidates = users
        .filter((user) => {
          if (user.role === 'owner' || user.role === 'admin') return false;
          return !alreadyMemberIds.has(String(user._id));
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

  // ── Project API Tokens ───────────────────────────────────────────────────

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
        tokenPrefix: token.tokenPrefix,
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

      const token = createApiTokenSecret();
      const apiToken = await db.createApiToken({
        label: body.label.trim(),
        projectId,
        tenantId: session.tenantId,
        tokenHash: hashApiToken(token),
        tokenPrefix: getApiTokenPrefix(token),
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
