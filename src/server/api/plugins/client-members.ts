/**
 * Client Members API plugin (token-authenticated admin surface).
 *
 * Manage tenant users (members), their roles/permissions, and groups via an API
 * token. Gated by the `members` RBAC service AND an explicit owner/admin check
 * on the token owner — user/role management is owner/admin only (a scoped token
 * narrows it further). Responses use the same serializers as the dashboard
 * (never raw records → no password hashes). Directory (`ldap`) groups reject
 * manual membership/rename/delete. API-token minting is intentionally NOT here.
 */

import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IGroup, IUser } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import {
  normalizeServicePermissions,
  RBAC_SERVICE_DEFINITIONS,
  SERVICE_PERMISSION_LEVELS,
  type UserRole,
} from '@/lib/security/rbac';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { readJsonBody, sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-members');

const GRANTABLE_TENANT_ROLES: UserRole[] = ['admin', 'project_admin', 'user'];

/** Member management requires an owner/admin-owned token. */
function isTenantAdmin(auth: ApiTokenContext): boolean {
  return auth.user?.role === 'owner' || auth.user?.role === 'admin';
}

function serializeUser(user: IUser) {
  return {
    _id: user._id,
    createdAt: user.createdAt,
    email: user.email,
    inviteAcceptedAt: user.inviteAcceptedAt,
    invitedAt: user.invitedAt,
    invitedBy: user.invitedBy,
    name: user.name,
    projectIds: user.projectIds ?? [],
    role: user.role,
    servicePermissions: normalizeServicePermissions(user.servicePermissions),
    updatedAt: user.updatedAt,
  };
}

function serializeGroup(group: IGroup, counts?: { members: number; projects: number }) {
  return {
    _id: String(group._id),
    name: group.name,
    description: group.description ?? null,
    tenantRole: group.tenantRole ?? null,
    servicePermissions: normalizeServicePermissions(group.servicePermissions),
    source: group.source ?? 'local',
    externalId: group.externalId ?? null,
    createdBy: group.createdBy,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    ...(counts ? { memberCount: counts.members, projectCount: counts.projects } : {}),
  };
}

function parseTenantRole(value: unknown): { ok: true; role: UserRole | undefined } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, role: undefined };
  if (typeof value === 'string' && (GRANTABLE_TENANT_ROLES as string[]).includes(value)) {
    return { ok: true, role: value as UserRole };
  }
  return { ok: false };
}

export const clientMembersApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Users ────────────────────────────────────────────────────────────────
  app.get('/client/v1/members/permissions/services', withClientApiRequestContext(async (_request, reply, auth) => {
    if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
    return reply.code(200).send({ levels: SERVICE_PERMISSION_LEVELS, services: RBAC_SERVICE_DEFINITIONS });
  }));

  app.get('/client/v1/members', withClientApiRequestContext(async (_request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const db = await getDatabase();
      const users = await db.listUsers();
      return reply.code(200).send({ users: users.map(serializeUser) });
    } catch (error) {
      logger.error('Client list members error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/members/:id/permissions', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id } = request.params as { id: string };
      const body = readJsonBody<{ servicePermissions?: unknown }>(request);
      const servicePermissions = normalizeServicePermissions(body.servicePermissions);
      const db = await getDatabase();
      const target = await db.findUserById(id);
      if (!target || String(target.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (target.role === 'owner') return reply.code(403).send({ error: 'Owner permissions cannot be changed' });
      const updated = await db.updateUser(id, { servicePermissions });
      if (!updated) return reply.code(500).send({ error: 'Failed to update permissions' });
      return reply.code(200).send({ user: serializeUser(updated) });
    } catch (error) {
      logger.error('Client update member permissions error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/members/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id } = request.params as { id: string };
      if (id === String(auth.tokenRecord.userId)) {
        return reply.code(400).send({ error: 'You cannot delete your own account' });
      }
      const db = await getDatabase();
      const target = await db.findUserById(id);
      if (!target || String(target.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (target.role === 'owner') return reply.code(403).send({ error: 'Cannot delete the owner account' });
      const deleted = await db.deleteUser(id);
      if (!deleted) return reply.code(500).send({ error: 'Failed to delete user' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client delete member error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/members/invite', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const body = readJsonBody<{ email?: string; name?: string; projectId?: string; role?: string; servicePermissions?: unknown }>(request);
      if (!body.name || !body.email || !body.role) {
        return reply.code(400).send({ error: 'Name, email, and role are required' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
        return reply.code(400).send({ error: 'Invalid email format' });
      }
      if (!['user', 'admin', 'project_admin'].includes(body.role)) {
        return reply.code(400).send({ error: 'Invalid role. Must be user, project_admin, or admin' });
      }
      const db = await getDatabase();
      const tenant = await db.findTenantById(auth.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });
      const existing = await db.findUserByEmail(body.email);
      if (existing) return reply.code(409).send({ error: 'User with this email already exists in your organization' });

      const defaultProject = await ensureDefaultProject(auth.tenantDbName, auth.tenantId, String(auth.tokenRecord.userId));
      const defaultProjectId = defaultProject._id ? String(defaultProject._id) : undefined;
      if (!defaultProjectId) return reply.code(400).send({ error: 'Project context is missing' });

      const existingUsers = await db.listUsers();
      const quota = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: tenant.licenseType as LicenseType,
          projectId: defaultProjectId,
          tenantDbName: auth.tenantDbName,
          tenantId: auth.tenantId,
          userId: String(auth.tokenRecord.userId),
        },
        'users',
        existingUsers.length,
      );
      if (!quota.allowed) return reply.code(429).send({ error: quota.reason || 'User quota exceeded' });

      const tempPassword = Math.random().toString(36).slice(-12);
      const hashedPassword = await bcrypt.hash(tempPassword, 10);
      const initialProjectIds = (body.role === 'user' || body.role === 'project_admin') && body.projectId
        ? [body.projectId] : undefined;

      const user = await db.createUser({
        email: body.email,
        features: [],
        invitedAt: new Date(),
        invitedBy: String(auth.tokenRecord.userId),
        licenseId: tenant.licenseType,
        mustChangePassword: true,
        name: body.name,
        password: hashedPassword,
        projectIds: initialProjectIds,
        role: body.role as 'user' | 'admin' | 'project_admin',
        servicePermissions: normalizeServicePermissions(body.servicePermissions),
        tenantId: auth.tenantId,
      });

      if (body.projectId && (body.role === 'user' || body.role === 'project_admin')) {
        await db.upsertUserProject({
          invitedBy: String(auth.tokenRecord.userId),
          projectId: body.projectId,
          role: body.role === 'project_admin' ? 'project_admin' : 'member',
          servicePermissions: undefined,
          tenantId: auth.tenantId,
          userId: String(user._id),
        });
      }

      // Fire-and-forget invitation email carrying the temp password. The plaintext
      // password is deliberately NOT returned in the API response.
      sendEmail(body.email, 'user-invitation', {
        companyName: tenant.companyName,
        email: body.email,
        inviterName: auth.user?.role ?? 'admin',
        loginUrl: `${getConfig().app.url}/login`,
        name: body.name,
        slug: tenant.slug,
        tempPassword,
      }).catch((error: Error) => logger.error('Failed to send invitation email', { error }));

      return reply.code(201).send({ user: serializeUser(user) });
    } catch (error) {
      logger.error('Client invite member error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Groups ─────────────────────────────────────────────────────────────────
  app.get('/client/v1/members/groups', withClientApiRequestContext(async (_request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const db = await getDatabase();
      const groups = await db.listGroups(auth.tenantId);
      const enriched = await Promise.all(groups.map(async (group) => {
        const [members, projects] = await Promise.all([
          db.listGroupMembers(String(group._id)),
          db.listGroupProjectsByGroup(String(group._id)),
        ]);
        return serializeGroup(group, { members: members.length, projects: projects.length });
      }));
      return reply.code(200).send({ groups: enriched });
    } catch (error) {
      logger.error('Client list groups error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/members/groups', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim().length < 2) {
        return reply.code(400).send({ error: 'name is required' });
      }
      const roleParsed = parseTenantRole(body.tenantRole);
      if (!roleParsed.ok) return reply.code(400).send({ error: 'Invalid tenantRole' });
      const db = await getDatabase();
      const group = await db.createGroup({
        createdBy: String(auth.tokenRecord.userId),
        description: typeof body.description === 'string' ? body.description : undefined,
        name: body.name.trim(),
        servicePermissions: normalizeServicePermissions(body.servicePermissions),
        tenantId: auth.tenantId,
        tenantRole: roleParsed.role,
      });
      return reply.code(201).send({ group: serializeGroup(group) });
    } catch (error) {
      logger.error('Client create group error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  async function loadGroup(auth: ApiTokenContext, id: string) {
    const db = await getDatabase();
    const group = await db.findGroupById(id);
    if (!group || String(group.tenantId) !== String(auth.tenantId)) return { db, group: null as null };
    return { db, group };
  }

  app.get('/client/v1/members/groups/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id } = request.params as { id: string };
      const { db, group } = await loadGroup(auth, id);
      if (!group) return reply.code(404).send({ error: 'Group not found' });
      const [members, projects] = await Promise.all([db.listGroupMembers(id), db.listGroupProjectsByGroup(id)]);
      return reply.code(200).send({ group: serializeGroup(group, { members: members.length, projects: projects.length }), members, projects });
    } catch (error) {
      logger.error('Client get group error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/members/groups/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id } = request.params as { id: string };
      const { db, group } = await loadGroup(auth, id);
      if (!group) return reply.code(404).send({ error: 'Group not found' });
      const body = readJsonBody<Record<string, unknown>>(request);
      const patch: Parameters<typeof db.updateGroup>[1] = { updatedBy: String(auth.tokenRecord.userId) };
      if (typeof body.name === 'string') {
        if (group.source === 'ldap') return reply.code(409).send({ error: 'Directory groups cannot be renamed here' });
        patch.name = body.name.trim();
      }
      if (typeof body.description === 'string') patch.description = body.description;
      if (body.tenantRole !== undefined) {
        const roleParsed = parseTenantRole(body.tenantRole);
        if (!roleParsed.ok) return reply.code(400).send({ error: 'Invalid tenantRole' });
        patch.tenantRole = roleParsed.role;
      }
      if (body.servicePermissions !== undefined) patch.servicePermissions = normalizeServicePermissions(body.servicePermissions);
      const updated = await db.updateGroup(id, patch);
      if (!updated) return reply.code(500).send({ error: 'Failed to update group' });
      return reply.code(200).send({ group: serializeGroup(updated) });
    } catch (error) {
      logger.error('Client update group error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/members/groups/:id', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id } = request.params as { id: string };
      const { db, group } = await loadGroup(auth, id);
      if (!group) return reply.code(404).send({ error: 'Group not found' });
      if (group.source === 'ldap') return reply.code(409).send({ error: 'Directory groups cannot be deleted here' });
      await db.deleteGroupMembersByGroup(id);
      await db.deleteGroupProjectsByGroup(id);
      await db.deleteGroup(id);
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client delete group error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/members/groups/:id/members', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id } = request.params as { id: string };
      const { db, group } = await loadGroup(auth, id);
      if (!group) return reply.code(404).send({ error: 'Group not found' });
      if (group.source === 'ldap') return reply.code(409).send({ error: 'Directory group membership is managed by sync' });
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.userId !== 'string') return reply.code(400).send({ error: 'userId is required' });
      const role: 'admin' | 'member' = body.role === 'admin' ? 'admin' : 'member';
      const target = await db.findUserById(body.userId);
      if (!target || String(target.tenantId) !== String(auth.tenantId)) return reply.code(404).send({ error: 'User not found' });
      await db.addGroupMember({ groupId: id, userId: body.userId, tenantId: auth.tenantId, role, source: 'local', addedBy: String(auth.tokenRecord.userId) });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client add group member error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/members/groups/:id/members/:userId', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id, userId } = request.params as { id: string; userId: string };
      const { group } = await loadGroup(auth, id);
      if (!group) return reply.code(404).send({ error: 'Group not found' });
      if (group.source === 'ldap') return reply.code(409).send({ error: 'Directory group membership is managed by sync' });
      const db = await getDatabase();
      const removed = await db.removeGroupMember(id, userId);
      if (!removed) return reply.code(404).send({ error: 'Membership not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client remove group member error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/members/groups/:id/projects', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id } = request.params as { id: string };
      const { db, group } = await loadGroup(auth, id);
      if (!group) return reply.code(404).send({ error: 'Group not found' });
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.projectId !== 'string') return reply.code(400).send({ error: 'projectId is required' });
      const roleParsed = parseTenantRole(body.role);
      const assignment = await db.upsertGroupProject({
        groupId: id,
        projectId: body.projectId,
        role: body.role === 'project_admin' ? 'project_admin' : 'member',
        servicePermissions: normalizeServicePermissions(body.servicePermissions),
        tenantId: auth.tenantId,
      });
      void roleParsed;
      return reply.code(200).send({ assignment });
    } catch (error) {
      logger.error('Client assign group project error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/client/v1/members/groups/:id/projects/:projectId', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });
      const { id, projectId } = request.params as { id: string; projectId: string };
      const { db, group } = await loadGroup(auth, id);
      if (!group) return reply.code(404).send({ error: 'Group not found' });
      const removed = await db.removeGroupProject(id, projectId);
      if (!removed) return reply.code(404).send({ error: 'Assignment not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Client remove group project error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
