/**
 * Groups API — tenant user groups that grant access at two levels:
 *   - tenant-wide: a `tenantRole` + `servicePermissions` applied to every member
 *   - per-project: IGroupProject assignments (role + service overrides)
 *
 * Effective permissions are the union of a user's direct grants and the grants
 * of every group they belong to (highest level wins — see lib/security/rbac).
 *
 * Owner/admin only. Directory-sourced groups (`source: 'ldap'`) have their
 * membership reconciled by the external-auth sync and reject manual membership
 * edits / deletion here; their grants remain editable.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IGroup } from '@/lib/database';
import {
  normalizeServicePermissions,
  type UserRole,
} from '@/lib/security/rbac';
import {
  readJsonBody,
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:groups');

/** Roles a group may grant tenant-wide. `owner` is intentionally excluded —
 *  ownership is unique to the tenant owner and never group-derived. */
const GRANTABLE_TENANT_ROLES: UserRole[] = ['admin', 'project_admin', 'user'];

function isUserAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
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
  if (value === undefined || value === null || value === '') {
    return { ok: true, role: undefined };
  }
  if (typeof value === 'string' && (GRANTABLE_TENANT_ROLES as string[]).includes(value)) {
    return { ok: true, role: value as UserRole };
  }
  return { ok: false };
}

export const groupsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── List ──────────────────────────────────────────────────────────────────
  app.get('/groups', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const groups = await db.listGroups(session.tenantId);
      const enriched = await Promise.all(
        groups.map(async (group) => {
          const [members, projects] = await Promise.all([
            db.listGroupMembers(String(group._id)),
            db.listGroupProjectsByGroup(String(group._id)),
          ]);
          return serializeGroup(group, { members: members.length, projects: projects.length });
        }),
      );

      return reply.code(200).send({ groups: enriched });
    } catch (error) {
      return handleError(error, reply, 'List groups');
    }
  }));

  // ── Create ──────────────────────────────────────────────────────────────────
  app.post('/groups', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can create groups' });
      }

      const body = readJsonBody<{
        name?: string;
        description?: string;
        tenantRole?: unknown;
        servicePermissions?: unknown;
      }>(request);

      const name = String(body.name ?? '').trim();
      if (!name) {
        return reply.code(400).send({ error: 'Group name is required' });
      }

      const tenantRole = parseTenantRole(body.tenantRole);
      if (!tenantRole.ok) {
        return reply.code(400).send({ error: 'Invalid tenantRole. Must be admin, project_admin, user, or empty' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.createGroup({
        tenantId: session.tenantId,
        name,
        description: body.description ? String(body.description) : undefined,
        tenantRole: tenantRole.role,
        servicePermissions: normalizeServicePermissions(body.servicePermissions),
        source: 'local',
        createdBy: session.userId,
      });

      return reply.code(201).send({ group: serializeGroup(group) });
    } catch (error) {
      return handleError(error, reply, 'Create group');
    }
  }));

  // ── Detail (group + members + project assignments) ──────────────────────────
  app.get('/groups/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const { id } = request.params as { id: string };

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.findGroupById(id);
      if (!group || String(group.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const [memberRows, projectRows, allUsers] = await Promise.all([
        db.listGroupMembers(id),
        db.listGroupProjectsByGroup(id),
        db.listUsers(),
      ]);
      const userById = new Map(allUsers.map((u) => [String(u._id), u]));

      const members = memberRows.map((m) => {
        const user = userById.get(String(m.userId));
        return {
          userId: String(m.userId),
          name: user?.name ?? null,
          email: user?.email ?? null,
          role: m.role,
          source: m.source ?? 'local',
        };
      });

      const projects = projectRows.map((p) => ({
        projectId: String(p.projectId),
        role: p.role,
        servicePermissions: normalizeServicePermissions(p.servicePermissions),
      }));

      return reply.code(200).send({ group: serializeGroup(group), members, projects });
    } catch (error) {
      return handleError(error, reply, 'Get group');
    }
  }));

  // ── Update grants/metadata ──────────────────────────────────────────────────
  app.patch('/groups/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can edit groups' });
      }
      const { id } = request.params as { id: string };
      const body = readJsonBody<{
        name?: string;
        description?: string;
        tenantRole?: unknown;
        servicePermissions?: unknown;
      }>(request);

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.findGroupById(id);
      if (!group || String(group.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const patch: Parameters<typeof db.updateGroup>[1] = { updatedBy: session.userId };

      // Name is directory-managed for LDAP groups; grants stay editable.
      if (body.name !== undefined) {
        if ((group.source ?? 'local') === 'ldap') {
          return reply.code(409).send({ error: 'Cannot rename a directory-synced group' });
        }
        const name = String(body.name).trim();
        if (!name) return reply.code(400).send({ error: 'Group name cannot be empty' });
        patch.name = name;
      }
      if (body.description !== undefined) patch.description = body.description ? String(body.description) : undefined;
      if (body.tenantRole !== undefined) {
        const tenantRole = parseTenantRole(body.tenantRole);
        if (!tenantRole.ok) {
          return reply.code(400).send({ error: 'Invalid tenantRole. Must be admin, project_admin, user, or empty' });
        }
        patch.tenantRole = tenantRole.role;
      }
      if (body.servicePermissions !== undefined) {
        patch.servicePermissions = normalizeServicePermissions(body.servicePermissions);
      }

      const updated = await db.updateGroup(id, patch);
      if (!updated) return reply.code(500).send({ error: 'Failed to update group' });

      return reply.code(200).send({ group: serializeGroup(updated) });
    } catch (error) {
      return handleError(error, reply, 'Update group');
    }
  }));

  // ── Delete ──────────────────────────────────────────────────────────────────
  app.delete('/groups/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can delete groups' });
      }
      const { id } = request.params as { id: string };

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.findGroupById(id);
      if (!group || String(group.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Group not found' });
      }
      if ((group.source ?? 'local') === 'ldap') {
        return reply.code(409).send({ error: 'Directory-synced groups are managed by LDAP and cannot be deleted here' });
      }

      await db.deleteGroupMembersByGroup(id);
      await db.deleteGroupProjectsByGroup(id);
      await db.deleteGroup(id);

      return reply.code(200).send({ message: 'Group deleted successfully' });
    } catch (error) {
      return handleError(error, reply, 'Delete group');
    }
  }));

  // ── Membership ──────────────────────────────────────────────────────────────
  app.post('/groups/:id/members', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can manage group members' });
      }
      const { id } = request.params as { id: string };
      const body = readJsonBody<{ userId?: string; role?: string }>(request);

      const userId = String(body.userId ?? '').trim();
      if (!userId) return reply.code(400).send({ error: 'userId is required' });
      const role: 'admin' | 'member' = body.role === 'admin' ? 'admin' : 'member';

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.findGroupById(id);
      if (!group || String(group.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Group not found' });
      }
      if ((group.source ?? 'local') === 'ldap') {
        return reply.code(409).send({ error: 'Membership of directory-synced groups is managed by LDAP' });
      }

      const target = await db.findUserById(userId);
      if (!target || String(target.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await db.addGroupMember({
        tenantId: session.tenantId,
        groupId: id,
        userId,
        role,
        source: 'local',
        addedBy: session.userId,
      });

      return reply.code(201).send({ message: 'Member added', member: { userId, role, source: 'local' } });
    } catch (error) {
      return handleError(error, reply, 'Add group member');
    }
  }));

  app.delete('/groups/:id/members/:userId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can manage group members' });
      }
      const { id, userId } = request.params as { id: string; userId: string };

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.findGroupById(id);
      if (!group || String(group.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Group not found' });
      }
      if ((group.source ?? 'local') === 'ldap') {
        return reply.code(409).send({ error: 'Membership of directory-synced groups is managed by LDAP' });
      }

      const removed = await db.removeGroupMember(id, userId);
      if (!removed) return reply.code(404).send({ error: 'Membership not found' });

      return reply.code(200).send({ message: 'Member removed' });
    } catch (error) {
      return handleError(error, reply, 'Remove group member');
    }
  }));

  // ── Project assignments ─────────────────────────────────────────────────────
  app.post('/groups/:id/projects', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can assign group projects' });
      }
      const { id } = request.params as { id: string };
      const body = readJsonBody<{ projectId?: string; role?: string; servicePermissions?: unknown }>(request);

      const projectId = String(body.projectId ?? '').trim();
      if (!projectId) return reply.code(400).send({ error: 'projectId is required' });
      if (body.role !== undefined && body.role !== 'member' && body.role !== 'project_admin') {
        return reply.code(400).send({ error: 'role must be "member" or "project_admin"' });
      }
      const role: 'member' | 'project_admin' = body.role === 'project_admin' ? 'project_admin' : 'member';

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.findGroupById(id);
      if (!group || String(group.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const project = await db.findProjectById(projectId);
      if (!project || String(project.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const assignment = await db.upsertGroupProject({
        tenantId: session.tenantId,
        groupId: id,
        projectId,
        role,
        servicePermissions: normalizeServicePermissions(body.servicePermissions),
      });

      return reply.code(201).send({
        assignment: {
          projectId: String(assignment.projectId),
          role: assignment.role,
          servicePermissions: normalizeServicePermissions(assignment.servicePermissions),
        },
      });
    } catch (error) {
      return handleError(error, reply, 'Assign group project');
    }
  }));

  app.delete('/groups/:id/projects/:projectId', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can assign group projects' });
      }
      const { id, projectId } = request.params as { id: string; projectId: string };

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const group = await db.findGroupById(id);
      if (!group || String(group.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'Group not found' });
      }

      const removed = await db.removeGroupProject(id, projectId);
      if (!removed) return reply.code(404).send({ error: 'Assignment not found' });

      return reply.code(200).send({ message: 'Assignment removed' });
    } catch (error) {
      return handleError(error, reply, 'Remove group project');
    }
  }));
};

function handleError(error: unknown, reply: FastifyReply, label: string) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  logger.error(`${label} error`, { error });
  return reply.code(500).send({ error: 'Internal server error' });
}
