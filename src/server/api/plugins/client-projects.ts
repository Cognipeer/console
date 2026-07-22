/**
 * Client Projects API plugin (token-authenticated admin surface).
 *
 * Manage projects (tenant-scoped containers) and their memberships via an API
 * token. Gated by the `projects` RBAC service for reads; every WRITE (container
 * create/update/delete and all member management) additionally requires the
 * token OWNER to be a tenant owner/admin — stricter than the dashboard (which
 * also allows project_admins), which is the safer posture for a token API and a
 * scoped token narrows it further. Token minting is intentionally NOT exposed.
 *
 *   GET    /client/v1/projects
 *   POST   /client/v1/projects
 *   PATCH  /client/v1/projects/:projectId
 *   DELETE /client/v1/projects/:projectId
 *   GET    /client/v1/projects/:projectId/members
 *   POST   /client/v1/projects/:projectId/members            (add: {userId|email, role?})
 *   DELETE /client/v1/projects/:projectId/members            (remove: {userId|email})
 *   PATCH  /client/v1/projects/:projectId/members            (role: {userId, role})
 *   PATCH  /client/v1/projects/:projectId/members/permissions ({userId, servicePermissions})
 */

import type { FastifyPluginAsync } from 'fastify';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { ProjectRole } from '@/lib/database/provider/types.base';
import { DEFAULT_PROJECT_KEY, generateUniqueProjectKey } from '@/lib/services/projects/projectService';
import { normalizeServicePermissions } from '@/lib/security/rbac';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { readJsonBody, sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-projects');

/** Token writes to the project surface require an owner/admin-owned token. */
function isTenantAdmin(auth: ApiTokenContext): boolean {
  return auth.user?.role === 'owner' || auth.user?.role === 'admin';
}

function legacyIds(projectIds?: string[]): string[] {
  return (projectIds ?? []).map(String).filter(Boolean);
}

export const clientProjectsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/projects', withClientApiRequestContext(async (_request, reply, auth) => {
    try {
      const db = await getDatabase();
      const projects = await db.listProjects(auth.tenantId);
      return reply.code(200).send({ projects });
    } catch (error) {
      logger.error('Client list projects error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/projects', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const body = readJsonBody<Record<string, unknown>>(request);
      const name = body.name;
      if (typeof name !== 'string' || name.trim().length < 2) {
        return reply.code(400).send({ error: 'name is required' });
      }
      const key = await generateUniqueProjectKey(auth.tenantDbName, auth.tenantId, (body.key as string | undefined) || name);
      const db = await getDatabase();
      const project = await db.createProject({
        createdBy: String(auth.tokenRecord.userId),
        description: body.description as string | undefined,
        key,
        name: name.trim(),
        tenantId: auth.tenantId,
        updatedBy: String(auth.tokenRecord.userId),
      });
      return reply.code(201).send({ project });
    } catch (error) {
      logger.error('Client create project error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/projects/:projectId', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { projectId } = request.params as { projectId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (body.name === undefined && body.description === undefined) {
        return reply.code(400).send({ error: 'At least one field (name, description) is required' });
      }
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 2)) {
        return reply.code(400).send({ error: 'name must be at least 2 characters' });
      }
      const db = await getDatabase();
      const existing = await db.findProjectById(projectId);
      if (!existing || String(existing.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      const updated = await db.updateProject(projectId, {
        description: typeof body.description === 'string' ? body.description : undefined,
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        updatedBy: String(auth.tokenRecord.userId),
      });
      return reply.code(200).send({ project: updated });
    } catch (error) {
      logger.error('Client update project error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/projects/:projectId', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { projectId } = request.params as { projectId: string };
      const db = await getDatabase();
      const existing = await db.findProjectById(projectId);
      if (!existing || String(existing.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      if (existing.key === DEFAULT_PROJECT_KEY) {
        return reply.code(400).send({ error: 'Cannot delete the default project' });
      }
      const deleted = await db.deleteProject(projectId);
      if (!deleted) return reply.code(500).send({ error: 'Failed to delete project' });
      await db.deleteUserProjectsByProject(projectId);
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client delete project error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Members ────────────────────────────────────────────────────────────
  async function loadProjectForAdmin(auth: ApiTokenContext, projectId: string) {
    const db = await getDatabase();
    const project = await db.findProjectById(projectId);
    if (!project || String(project.tenantId) !== String(auth.tenantId)) {
      return { db, project: null as null };
    }
    return { db, project };
  }

  app.get('/client/v1/projects/:projectId/members', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { projectId } = request.params as { projectId: string };
      const { db, project } = await loadProjectForAdmin(auth, projectId);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const allUsers = await db.listUsers();
      const byId = new Map(allUsers.map((u) => [String(u._id), u]));
      const privileged = allUsers
        .filter((u) => u.role === 'owner' || u.role === 'admin')
        .map((u) => ({ userId: String(u._id), email: u.email, name: u.name, role: u.role, projectRole: null, servicePermissions: null, implicit: true }));
      const memberships = await db.listUserProjectsByProject(projectId);
      const privilegedIds = new Set(privileged.map((p) => p.userId));
      const explicit = memberships
        .map((m) => {
          const u = byId.get(m.userId);
          if (!u || privilegedIds.has(String(u._id))) return null;
          return { userId: String(u._id), email: u.email, name: u.name, role: u.role, projectRole: m.role, servicePermissions: m.servicePermissions ?? null, implicit: false };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return reply.code(200).send({ members: [...privileged, ...explicit] });
    } catch (error) {
      logger.error('Client list project members error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/projects/:projectId/members', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { projectId } = request.params as { projectId: string };
      const { db, project } = await loadProjectForAdmin(auth, projectId);
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.userId !== 'string' && typeof body.email !== 'string') {
        return reply.code(400).send({ error: 'userId or email is required' });
      }
      const target = typeof body.userId === 'string'
        ? await db.findUserById(body.userId)
        : await db.findUserByEmail(String(body.email));
      if (!target || String(target.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (target.role === 'owner' || target.role === 'admin') {
        return reply.code(400).send({ error: 'Owners and admins are implicitly assigned to all projects' });
      }
      const role: ProjectRole = body.role === 'project_admin' ? 'project_admin' : 'member';
      const userProject = await db.upsertUserProject({
        tenantId: auth.tenantId, userId: String(target._id), projectId, role,
        servicePermissions: undefined, invitedBy: String(auth.tokenRecord.userId),
      });
      return reply.code(200).send({ userProject });
    } catch (error) {
      logger.error('Client add project member error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/projects/:projectId/members', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { projectId } = request.params as { projectId: string };
      const { db, project } = await loadProjectForAdmin(auth, projectId);
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const body = readJsonBody<Record<string, unknown>>(request);
      const target = typeof body.userId === 'string'
        ? await db.findUserById(body.userId)
        : typeof body.email === 'string' ? await db.findUserByEmail(body.email) : null;
      if (!target || String(target.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (target.role === 'owner' || target.role === 'admin') {
        return reply.code(400).send({ error: 'Cannot remove owners/admins from projects' });
      }
      const removed = await db.deleteUserProject(String(target._id), projectId);
      if (!removed) {
        const next = legacyIds(target.projectIds).filter((id) => id !== String(projectId));
        if (next.length === legacyIds(target.projectIds).length) {
          return reply.code(404).send({ error: 'Membership not found' });
        }
        await db.updateUser(String(target._id), { projectIds: next });
      }
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client remove project member error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/projects/:projectId/members', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { projectId } = request.params as { projectId: string };
      const { db, project } = await loadProjectForAdmin(auth, projectId);
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.userId !== 'string') return reply.code(400).send({ error: 'userId is required' });
      if (body.role !== 'member' && body.role !== 'project_admin') {
        return reply.code(400).send({ error: 'role must be "member" or "project_admin"' });
      }
      const target = await db.findUserById(body.userId);
      if (!target || String(target.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (target.role === 'owner' || target.role === 'admin') {
        return reply.code(400).send({ error: 'Cannot change role for owner/admin' });
      }
      const existing = await db.findUserProject(body.userId, projectId);
      const updated = await db.upsertUserProject({
        tenantId: auth.tenantId, userId: body.userId, projectId, role: body.role as ProjectRole,
        servicePermissions: existing?.servicePermissions, invitedBy: existing?.invitedBy ?? String(auth.tokenRecord.userId),
      });
      return reply.code(200).send({ userProject: updated });
    } catch (error) {
      logger.error('Client update project member role error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/projects/:projectId/members/permissions', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { projectId } = request.params as { projectId: string };
      const { db, project } = await loadProjectForAdmin(auth, projectId);
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.userId !== 'string') return reply.code(400).send({ error: 'userId is required' });
      const target = await db.findUserById(body.userId);
      if (!target || String(target.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }
      const servicePermissions = normalizeServicePermissions(body.servicePermissions);
      const existing = await db.findUserProject(body.userId, projectId);
      const updated = await db.upsertUserProject({
        tenantId: auth.tenantId, userId: body.userId, projectId,
        role: existing?.role ?? (target.role === 'project_admin' ? 'project_admin' : 'member'),
        servicePermissions, invitedBy: existing?.invitedBy ?? String(auth.tokenRecord.userId),
      });
      return reply.code(200).send({ userProject: updated });
    } catch (error) {
      logger.error('Client update project member permissions error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
