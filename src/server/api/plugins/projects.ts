import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { getProjectLevelsSince, ignoredProjectLevels } from '@/lib/iam/projectLevels';
import { dropTokenDelegation } from '@/lib/iam/tokenDelegation';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { invalidateApiTokenAuthCache } from '@/lib/services/apiTokenAuth';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { filterManageableTokens, resolveManageableProjectToken } from '@/lib/services/apiTokens/tokenGovernance';
import {
  loadTokenPolicyForDisplay,
  prepareTokenCreate,
  presentAllowedIpRanges,
  presentApiToken,
  tokenExceedsPolicy,
} from '@/lib/services/apiTokens/tokenPolicy';
import { isUserDisabled } from '@/lib/services/users/userAuthState';
import {
  DEFAULT_PROJECT_KEY,
  ensureDefaultProject,
  generateUniqueProjectKey,
  listAccessibleProjects,
} from '@/lib/services/projects/projectService';
import type { ProjectRole } from '@/lib/database/provider/types.base';
import type { UserServicePermissions } from '@/lib/security/rbac';
import { mergeServicePermissions } from '@/lib/security/rbac';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import { foldSearchText } from '@/lib/shared/searchFold';
import { listDirectoryProjectRules } from '@/enterprise/external-auth';
import {
  applyBulkMembers,
  applyProjectExtras,
  parseIdList,
  parseRoleEntries,
} from '@/lib/services/projects/projectMembership';
import {
  buildProjectOverview,
  describeProjectGroups,
  listTenantAdmins,
} from '@/lib/services/projects/projectOverview';
import { directoryDefaultsFor, loadProjectStats } from '@/lib/services/projects/projectStats';
import {
  readJsonBody,
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';
import { auditTokenRestrictionChange, editApiTokenForSession, readBodyObject } from './tokens';

const logger = createLogger('api:projects');

function canManageProjects(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function getLegacyProjectIds(projectIds?: string[]): string[] {
  return (projectIds ?? []).map(String).filter(Boolean);
}

/**
 * Resolves the strongest project role + merged service overrides a user has for
 * a project, unioning direct UserProject membership, legacy projectIds, and any
 * group→project assignment the user inherits. Returns null when none apply.
 */
async function resolveProjectMembership(
  db: Awaited<ReturnType<typeof getDatabase>>,
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

  const user = await db.findUserById(session.userId);
  if (!user) {
    return { error: 'Unauthorized' as const, ok: false as const, status: 401 as const };
  }

  // Effective access unions direct membership, legacy projectIds and groups.
  const membership = await resolveProjectMembership(db, {
    userId: session.userId,
    userRole: session.userRole,
    projectId,
    legacyProjectIds: user.projectIds,
  });

  if (!membership) {
    return { error: 'Forbidden' as const, ok: false as const, status: 403 as const };
  }

  if (requireAdmin && membership.role !== 'project_admin') {
    return { error: 'Forbidden' as const, ok: false as const, status: 403 as const };
  }

  return {
    db,
    ok: true as const,
    project,
    userProject: {
      projectId,
      role: membership.role,
      servicePermissions: membership.servicePermissions,
      tenantId: session.tenantId,
      userId: session.userId,
    },
  };
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
        projectIds = await collectAccessibleProjectIds(db, session.userId, user.projectIds);
      }

      const projects = await listAccessibleProjects(session.tenantDbName, session.tenantId, {
        projectIds,
        role: user.role,
      });

      const activeCookie = request.cookies.active_project_id;
      const cookieIsValid = Boolean(
        activeCookie && projects.some((project) => String(project._id) === String(activeCookie)),
      );

      // If the cookie points to an accessible project, honor it as-is — the
      // user (or a previous fallback) explicitly selected it. Only fall back
      // to a non-default project when there is no valid selection yet.
      const preferredProject = cookieIsValid
        ? projects.find((project) => String(project._id) === String(activeCookie))
        : (projects.find((project) => project.key !== DEFAULT_PROJECT_KEY) ?? projects[0]);

      const activeProjectId = preferredProject?._id ? String(preferredProject._id) : undefined;

      if (activeCookie && !cookieIsValid) {
        if (activeProjectId) {
          reply.setCookie('active_project_id', activeProjectId, {
            httpOnly: true,
            maxAge: 60 * 60 * 24 * 30,
            path: '/',
            sameSite: 'lax',
            secure: getConfig().nodeEnv === 'production',
          });
        } else {
          reply.clearCookie('active_project_id', { path: '/' });
        }
      }

      const include = String((request.query as { include?: unknown } | undefined)?.include ?? '');
      if (include.split(',').map((part) => part.trim()).includes('stats')) {
        const [stats, rules] = await Promise.all([
          loadProjectStats(db, session.tenantId, projects),
          listDirectoryProjectRules(session.tenantId),
        ]);
        // Which projects the caller administers (the list's "I manage" filter): every project for a
        // tenant owner/admin, otherwise the ones where they (or a group of theirs) are project_admin.
        const managed = new Set<string>();
        if (user.role !== 'owner' && user.role !== 'admin') {
          const [direct, groupMemberships] = await Promise.all([
            db.listUserProjectsByUser(session.userId),
            db.listGroupMembersByUser(session.userId),
          ]);
          for (const row of direct) {
            if (row.role === 'project_admin') managed.add(String(row.projectId));
          }
          const grants = await Promise.all(
            groupMemberships.map((m) => db.listGroupProjectsByGroup(String(m.groupId))),
          );
          for (const grant of grants.flat()) {
            if (grant.role === 'project_admin') managed.add(String(grant.projectId));
          }
        }
        const adminsAll = user.role === 'owner' || user.role === 'admin';
        const enriched = projects.map((project) => {
          const id = String(project._id);
          return {
            ...project,
            canManage: adminsAll || managed.has(id),
            stats: stats.get(id),
            directoryDefault: directoryDefaultsFor(rules, id),
          };
        });
        return reply.code(200).send({ activeProjectId, projects: enriched });
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

      const warnings: string[] = [];
      const members = parseRoleEntries(body.members, 'userId', 'Members', warnings);
      const groups = parseRoleEntries(body.groups, 'groupId', 'Groups', warnings);
      const providerIds = parseIdList(body.providerIds, 'Providers', warnings);

      const project = await db.createProject({
        createdBy: session.userId,
        description: body.description as string | undefined,
        key: projectKey,
        name: name.trim(),
        tenantId: session.tenantId,
        updatedBy: session.userId,
      });

      // Best effort: the project exists whatever happens to the optional extras.
      try {
        warnings.push(...await applyProjectExtras(db, {
          actorUserId: session.userId,
          groups,
          members,
          projectId: String(project._id),
          providerIds,
          tenantId: session.tenantId,
        }));
      } catch (extrasError) {
        logger.error('Apply project extras error', { error: extrasError });
        warnings.push('Some people, groups or providers could not be applied; check the project and add them again.');
      }

      return reply.code(201).send({ project, warnings });
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
        projectIds = await collectAccessibleProjectIds(db, session.userId, user.projectIds);
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
        httpOnly: true,
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
          ignoredServices: [] as string[],
          implicit: true,
          source: 'manual' as 'manual' | 'directory',
        }));

      // Explicit members via UserProject records. The engine reads a stored "no access" of a row that
      // predates the workspace's activation instant as not set (projectLevels.ts): the row names those
      // services so the screens do not show them as live limits (and a save does not turn them into
      // fresh ones).
      const memberships = await access.db.listUserProjectsByProject(projectId);
      const since = await getProjectLevelsSince(session.tenantDbName);
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
            ignoredServices: ignoredProjectLevels(m, since),
            implicit: false,
            source: (m.source === 'directory' ? 'directory' : 'manual') as 'manual' | 'directory',
          };
        })
        .filter((member): member is {
          userId: string;
          email: string;
          implicit: boolean;
          ignoredServices: string[];
          name: string;
          projectRole: ProjectRole;
          role: string;
          servicePermissions: Record<string, string> | null;
          source: 'manual' | 'directory';
        } => member !== null);

      const explicitIds = new Set(explicit.map((member) => member.userId));
      const legacy = allUsers
        .filter((user) => user.role !== 'owner' && user.role !== 'admin')
        .filter((user) => getLegacyProjectIds(user.projectIds).includes(String(projectId)))
        .filter((user) => !explicitIds.has(String(user._id)))
        .map((user) => ({
          userId: String(user._id),
          email: user.email,
          implicit: false,
          name: user.name,
          projectRole: user.role === 'project_admin' ? 'project_admin' : 'member',
          role: user.role as string,
          servicePermissions: null,
          ignoredServices: [] as string[],
          source: 'manual' as 'manual' | 'directory',
        }));

      // Deduplicate: privileged users already covered above
      const privilegedIds = new Set(privileged.map((p) => p.userId));
      const members = [
        ...privileged,
        ...legacy.filter((member) => !privilegedIds.has(member.userId)),
        ...explicit.filter((m) => m && !privilegedIds.has(m.userId)),
      ];

      const isProjectAdmin = access.userProject?.role === 'project_admin';
      const canManageProjectAccess = canManageProjects(session.userRole) || isProjectAdmin;

      const [grants, tenantGroups, groupMembers] = await Promise.all([
        access.db.listGroupProjectsByProject(projectId),
        access.db.listGroups(session.tenantId),
        access.db.listGroupMembersByTenant(session.tenantId),
      ]);

      return reply.code(200).send({
        capabilities: {
          canAssignMembers: canManageProjectAccess,
          canInviteMembers: canManageProjects(session.userRole),
          canManagePermissions: canManageProjectAccess,
          canManageRoles: canManageProjectAccess,
          canRemoveMembers: canManageProjectAccess,
          isProjectAdmin,
          isTenantAdmin: canManageProjects(session.userRole),
        },
        members,
        groups: describeProjectGroups({ grants, groupMembers, groups: tenantGroups })
          .map((group) => ({
            directorySynced: group.directorySynced,
            groupId: group.groupId,
            memberCount: group.memberCount,
            name: group.name,
            role: group.role,
          })),
        tenantAdmins: listTenantAdmins(allUsers),
      });
    } catch (error) {
      logger.error('List project members error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/projects/:projectId/members', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, requireAdmin: true, session });

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

      // A host application's person belongs to no project.
      if (target.kind === 'external') {
        return reply.code(400).send({ error: 'External users cannot be project members', code: 'external_user' });
      }

      const role: ProjectRole = (body.role === 'project_admin') ? 'project_admin' : 'member';

      const userProject = await access.db.upsertUserProject({
        tenantId: session.tenantId,
        userId: String(target._id),
        projectId,
        role,
        servicePermissions: undefined,
        invitedBy: session.userId,
        source: 'manual',
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
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, requireAdmin: true, session });

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
        const nextProjectIds = getLegacyProjectIds(target.projectIds).filter((id) => id !== String(projectId));
        const legacyAssigned = nextProjectIds.length !== getLegacyProjectIds(target.projectIds).length;

        if (!legacyAssigned) {
          return reply.code(404).send({ error: 'Membership not found' });
        }

        const updated = await access.db.updateUser(String(target._id), {
          projectIds: nextProjectIds,
        });

        if (!updated) {
          return reply.code(500).send({ error: 'Failed to update membership' });
        }
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
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, requireAdmin: true, session });

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
        const legacyAssigned = getLegacyProjectIds(target.projectIds).includes(String(projectId));
        if (!legacyAssigned) {
          return reply.code(404).send({ error: 'Membership not found' });
        }

        const created = await access.db.upsertUserProject({
          invitedBy: session.userId,
          projectId,
          role: body.role as ProjectRole,
          servicePermissions: undefined,
          source: 'manual',
          tenantId: session.tenantId,
          userId: body.userId,
        });

        return reply.code(200).send({ userProject: created });
      }

      const updated = await access.db.upsertUserProject({
        tenantId: session.tenantId,
        userId: body.userId,
        projectId,
        role: body.role as ProjectRole,
        servicePermissions: existing.servicePermissions,
        invitedBy: existing.invitedBy,
        // A hand-edited role makes a directory-applied row a manual one.
        source: 'manual',
      });

      return reply.code(200).send({ userProject: updated });
    } catch (error) {
      logger.error('Update project member role error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/projects/:projectId/members/bulk', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, requireAdmin: true, session });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const warnings: string[] = [];
      const add = parseRoleEntries(body.add, 'userId', 'Add', warnings);
      const setRole = parseRoleEntries(body.setRole, 'userId', 'Set role', warnings);
      const remove = parseIdList(body.remove, 'Remove', warnings);

      if (add.length + setRole.length + remove.length === 0) {
        return reply.code(400).send({ error: 'add, remove or setRole must contain at least one entry' });
      }

      const result = await applyBulkMembers(access.db, {
        actorUserId: session.userId,
        add,
        projectId,
        remove,
        setRole,
        tenantId: session.tenantId,
      });

      return reply.code(200).send({ ...result, warnings: [...warnings, ...result.warnings] });
    } catch (error) {
      logger.error('Bulk project members error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/projects/:projectId/overview', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, session });

      if (!access.ok) {
        return reply.code(access.status).send({ error: access.error });
      }

      const overview = await buildProjectOverview(access.db, session.tenantId, access.project);
      return reply.code(200).send(overview);
    } catch (error) {
      logger.error('Project overview error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/projects/:projectId/members/permissions', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = request.params as { projectId: string };
      const access = await assertProjectAccess({ projectId, requireAdmin: true, session });

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
        const legacyAssigned = getLegacyProjectIds(target.projectIds).includes(String(projectId));
        if (!legacyAssigned) {
          return reply.code(404).send({ error: 'Membership not found' });
        }

        const created = await access.db.upsertUserProject({
          invitedBy: session.userId,
          projectId,
          role: target.role === 'project_admin' ? 'project_admin' : 'member',
          servicePermissions: (body.servicePermissions as Record<string, string> | undefined) ?? {},
          tenantId: session.tenantId,
          userId: body.userId,
        });

        return reply.code(200).send({ userProject: created });
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
      // Folded like every other picker search: "ismail" finds "İsmail", "ısparta" finds "ISPARTA".
      const search = foldSearchText(query.q?.trim() ?? '');
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
          if (isUserDisabled(user)) return false;
          if (alreadyMemberIds.has(String(user._id))) return false;
          return !getLegacyProjectIds(user.projectIds).includes(String(projectId));
        })
        .filter((user) => {
          const email = foldSearchText(user.email ?? '');
          const name = foldSearchText(user.name ?? '');
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

      // Listing is not minting: the token quota is checked when a token is created, never here.
      const db = await getDatabase();
      const existingTokens = await db.listProjectApiTokens(session.tenantId, projectId);

      const policy = await loadTokenPolicyForDisplay(session.tenantDbName);
      const now = new Date();
      // What is listed is what the caller may manage - the owner sees every token of the
      // project, an admin never the owner's (nor those of an account it cannot act on), the
      // same rule as GET /api/tokens?scope=project - so edit and delete hold for every row.
      const visibleTokens = await filterManageableTokens(db, session, existingTokens);
      const tokens = visibleTokens.map((token) =>
        presentApiToken(token, { policy, now, canDelete: true, canEdit: true }));

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

      // Same expiry / IP allowlist preparation as every other mint endpoint.
      const prepared = await prepareTokenCreate({ body, tenantDbName: session.tenantDbName });
      if (!prepared.ok) {
        return reply.code(prepared.status).send(prepared.body);
      }

      const token = createApiTokenSecret();
      const apiToken = await db.createApiToken({
        label: body.label.trim(),
        projectId,
        tenantId: session.tenantId,
        tokenHash: hashApiToken(token),
        tokenPrefix: getApiTokenPrefix(token),
        userId: session.userId,
        ...(prepared.expiresAt ? { expiresAt: prepared.expiresAt } : {}),
        ...(prepared.allowedIpRanges ? { allowedIpRanges: prepared.allowedIpRanges } : {}),
      });

      return reply.code(201).send({
        id: apiToken._id,
        label: apiToken.label,
        message: 'API token created successfully',
        token,
        expiresAt: prepared.expiresAt ? prepared.expiresAt.toISOString() : null,
        allowedIpRanges: presentAllowedIpRanges(apiToken.allowedIpRanges),
        lastUsedAt: null,
        exceedsTenantPolicy: tokenExceedsPolicy(apiToken, prepared.policy),
      });
    } catch (error) {
      logger.error('Create project token error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Edit label / expiry / IP allowlist of a project token. Same rules and the
  // same implementation as PUT /tokens/:id.
  app.put('/projects/:projectId/tokens/:id', withApiRequestContext(async (request, reply) => {
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

      const body = readBodyObject(request);
      if (!body) {
        return reply.code(400).send({ error: 'The request body must be a JSON object', code: 'invalid_body' });
      }

      const db = await getDatabase();
      const result = await editApiTokenForSession({ db, session, projectId, tokenId: id, body });
      auditTokenRestrictionChange(request, session, result.change);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      logger.error('Update project token error', { error });
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

      // The same rule as DELETE /api/tokens/:id: the owner role may delete any token of the
      // project, an admin any but the owner's (or an account it cannot act on), and a token
      // that is not this project's is not found.
      const db = await getDatabase();
      const target = await resolveManageableProjectToken(db, session, projectId, id);
      if (!target.ok) {
        return target.reason === 'forbidden'
          ? reply.code(403).send({ error: 'Forbidden' })
          : reply.code(404).send({ error: 'Token not found' });
      }

      // Per owner, not per workspace: deleting one token does not flush every principal's cache.
      const deleted = await db.deleteApiToken(id, String(target.token.userId));
      if (!deleted) {
        return reply.code(404).send({ error: 'Token not found' });
      }
      await invalidateApiTokenAuthCache(target.token.tokenHash);
      // what the token was set up to act for goes with it (nothing reads it any more; this only tidies, and keeps the sealed secrets from outliving it)
      await dropTokenDelegation(session.tenantDbName, id);

      return reply.code(200).send({ message: 'API token deleted successfully' });
    } catch (error) {
      logger.error('Delete project token error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
