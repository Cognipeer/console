import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IUser } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import {
  normalizeServicePermissions,
  RBAC_SERVICE_DEFINITIONS,
  SERVICE_PERMISSION_LEVELS,
} from '@/lib/security/rbac';
import { generateSecurePassword } from '@/lib/services/auth/passwordGenerator';
import {
  CsvImportError,
  importProgrammaticUsers,
  MAX_BULK_IMPORT_ROWS,
  parseUserCsv,
  rowAlreadyExists,
} from '@/lib/services/users/csvImport';
import { BCRYPT_ROUNDS } from '@/lib/services/auth/passwordPolicy';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import {
  readJsonBody,
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';
import { resolveRequestedTokenScope } from './tokens';

const logger = createLogger('api:users');

function isUserAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

function serializeUser(user: IUser) {
  return {
    _id: user._id,
    canLogin: user.canLogin !== false,
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

export const usersApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/users/permissions/services', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      return reply.code(200).send({
        levels: SERVICE_PERMISSION_LEVELS,
        services: RBAC_SERVICE_DEFINITIONS,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('List permission services error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/users', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const users = await db.listUsers();
      return reply.code(200).send({ users: users.map(serializeUser) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('List users error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/users/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const user = await db.findUserById(id);
      if (!user || String(user.tenantId) !== String(session.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return reply.code(200).send({ user: serializeUser(user) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Get user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/users/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can delete users' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      if (id === session.userId) {
        return reply.code(400).send({ error: 'You cannot delete your own account' });
      }

      const userToDelete = await db.findUserById(id);
      if (!userToDelete) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (userToDelete.role === 'owner') {
        return reply.code(403).send({ error: 'Cannot delete the owner account' });
      }

      const deleted = await db.deleteUser(id);
      if (!deleted) {
        return reply.code(500).send({ error: 'Failed to delete user' });
      }

      return reply.code(200).send({ message: 'User deleted successfully' });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Delete user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/users/:id/permissions', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can manage permissions' });
      }

      const body = readJsonBody<{ servicePermissions?: unknown }>(request);

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const target = await db.findUserById(id);
      if (!target) {
        return reply.code(404).send({ error: 'User not found' });
      }
      if (target.role === 'owner') {
        return reply.code(403).send({ error: 'Owner permissions cannot be changed' });
      }

      // Clamped to the granting admin's own effective permission, same as
      // POST /users/invite — an admin can never grant a target user a
      // service level they don't themselves have.
      const servicePermissions = (await resolveRequestedTokenScope(
        db,
        session.userId,
        body.servicePermissions,
      )) ?? {};

      const updated = await db.updateUser(id, { servicePermissions });
      if (!updated) {
        return reply.code(500).send({ error: 'Failed to update permissions' });
      }

      return reply.code(200).send({ user: serializeUser(updated) });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Update user permissions error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  /**
   * Bulk import from a CSV, creating PROGRAMMATIC users (`canLogin: false`).
   *
   * The single-user dialog next to this covers a teammate you want to invite;
   * this covers the five hundred developers who will never sign in and only
   * need an identity to attribute usage to. Same user records either way, so
   * groups, RBAC, projects and reports need no special case.
   *
   * The quota is checked for the WHOLE batch before anything is written: an
   * import that would cross the tenant's user limit is refused rather than
   * half-applied, which is the only outcome an admin can actually recover from.
   * Because a concurrent import or invite can eat that headroom while rows are
   * being written, the loop re-checks every 50 creations and stops (reporting
   * `halted`) rather than overshooting `maxUsers`. Files over
   * `MAX_BULK_IMPORT_ROWS` usable rows are refused up front (400).
   */
  app.post('/users/bulk-import', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can import users' });
      }

      const body = readJsonBody<{ csv?: unknown; role?: unknown; projectId?: unknown }>(request);
      if (typeof body.csv !== 'string' || !body.csv.trim()) {
        return reply.code(400).send({ error: 'Paste or upload a CSV first' });
      }
      const role = typeof body.role === 'string' && ['user', 'admin', 'project_admin'].includes(body.role)
        ? body.role as 'user' | 'admin' | 'project_admin'
        : 'user';

      // Throws CsvImportError(400, { maxRows }) past the cap — handled below.
      const { rows, invalid } = parseUserCsv(body.csv, { maxRows: MAX_BULK_IMPORT_ROWS });
      if (rows.length === 0) {
        return reply.code(400).send({ error: 'No usable rows found in that file', invalid });
      }

      const db = await getDatabase();
      const tenant = await db.findTenantById(session.tenantId);
      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });
      await db.switchToTenant(session.tenantDbName);

      const existingUsers = await db.listUsers();
      // Same rule the insert loop applies (email if present, else name), so the
      // quota is charged for exactly the rows that will be created — not for
      // name-only rows the loop is going to skip.
      const knownEmails = new Set(
        existingUsers.filter((u) => u.email).map((u) => String(u.email).toLowerCase()),
      );
      const knownNames = new Set(existingUsers.map((u) => String(u.name ?? '').toLowerCase()));
      const newcomers = rows.filter((r) => !rowAlreadyExists(r, knownEmails, knownNames));

      const defaultProject = await ensureDefaultProject(
        session.tenantDbName,
        session.tenantId,
        session.userId || session.tenantId,
      );
      const defaultProjectId = defaultProject._id ? String(defaultProject._id) : undefined;
      if (!defaultProjectId) {
        return reply.code(400).send({ error: 'Project context is missing' });
      }

      const quotaContext = {
        domain: 'global' as const,
        licenseType: tenant.licenseType as LicenseType,
        projectId: defaultProjectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        userId: session.userId,
      };

      // Checked against the count AFTER the import, so a batch that would cross
      // the limit is refused whole. A re-upload with nothing new to create is
      // a no-op and must not 429 at the limit.
      if (newcomers.length > 0) {
        const quota = await checkResourceQuota(
          quotaContext,
          'users',
          existingUsers.length + newcomers.length - 1,
        );
        if (!quota.allowed) {
          return reply.code(429).send({
            error: quota.reason || 'User quota exceeded',
            wouldCreate: newcomers.length,
            current: existingUsers.length,
          });
        }
      }

      const projectIds = typeof body.projectId === 'string' && body.projectId
        ? [body.projectId]
        : undefined;
      const { created, halted } = await importProgrammaticUsers({
        tenantId: session.tenantId,
        rows,
        role,
        projectIds,
        licenseId: tenant.licenseType,
        createdBy: session.userId,
        checkQuota: (currentCount) => checkResourceQuota(quotaContext, 'users', currentCount),
      });

      const createdEmails = new Set(created.map((c) => (c.email ?? '').toLowerCase()));
      const skippedExisting = rows
        .filter((r) => !created.some((c) => c.name === r.name && (c.email ?? '') === (r.email ?? '')))
        .map((r) => r.email ?? r.name)
        .filter((v) => !createdEmails.has(v.toLowerCase()));

      return reply.code(201).send({
        created,
        createdCount: created.length,
        skippedExisting,
        invalid: invalid.slice(0, 25),
        invalidCount: invalid.length,
        ...(halted ? { halted } : {}),
      });
    } catch (error) {
      if (error instanceof CsvImportError) {
        return reply.code(error.status).send({ error: error.message, ...error.details });
      }
      logger.error('Bulk user import error', { error });
      return reply.code(500).send({ error: 'Failed to import users' });
    }
  }));

  app.post('/users/invite', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can invite users' });
      }

      const body = readJsonBody<{
        canLogin?: boolean;
        email?: string;
        name?: string;
        projectId?: string;
        role?: string;
        sendInvite?: boolean;
        servicePermissions?: unknown;
      }>(request);

      // canLogin defaults to true (normal user). When explicitly false this is
      // a "Programmatic User" with no password login capability — there is
      // nothing to invite, so sendInvite is forced off regardless of what was
      // sent.
      const canLogin = body.canLogin !== false;
      const sendInvite = canLogin && body.sendInvite !== false;

      if (!body.name || !body.role) {
        return reply.code(400).send({ error: 'Name and role are required' });
      }

      if (canLogin && !body.email) {
        return reply.code(400).send({
          error: 'Email is required unless "Can log in" is turned off',
        });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (body.email && !emailRegex.test(body.email)) {
        return reply.code(400).send({ error: 'Invalid email format' });
      }

      if (!['user', 'admin', 'project_admin'].includes(body.role)) {
        return reply.code(400).send({
          error: 'Invalid role. Must be user, project_admin, or admin',
        });
      }

      const db = await getDatabase();
      const tenant = await db.findTenantById(session.tenantId);
      if (!tenant) {
        return reply.code(404).send({ error: 'Tenant not found' });
      }

      await db.switchToTenant(session.tenantDbName);
      const trimmedEmail = (body.email ?? '').trim();
      if (trimmedEmail) {
        const existingUser = await db.findUserByEmail(trimmedEmail);
        if (existingUser) {
          return reply.code(409).send({
            error: 'User with this email already exists in your organization',
          });
        }
      }

      // Always CSPRNG-generated (never Math.random) — for the invite-email
      // path it's a one-time temp password emailed to the user; for the
      // no-invite path it's returned once in the response as
      // `generatedPassword`.
      const tempPassword = generateSecurePassword();
      const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);
      // sendInvite path: force a change on first login (unchanged behavior).
      // No-invite path: force a change only if the account can actually log
      // in — a canLogin=false user has no login to force a change on.
      const mustChangePassword = sendInvite ? true : canLogin;

      const defaultProject = await ensureDefaultProject(
        session.tenantDbName,
        session.tenantId,
        session.userId || session.tenantId,
      );
      const defaultProjectId = defaultProject._id
        ? String(defaultProject._id)
        : undefined;

      if (!defaultProjectId) {
        return reply.code(400).send({ error: 'Project context is missing' });
      }

      const existingUsers = await db.listUsers();
      const userQuotaCheck = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: tenant.licenseType as LicenseType,
          projectId: defaultProjectId,
          tenantDbName: session.tenantDbName,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        'users',
        existingUsers.length,
      );

      if (!userQuotaCheck.allowed) {
        return reply.code(429).send({
          error: userQuotaCheck.reason || 'User quota exceeded',
        });
      }

      let initialProjectIds: string[] | undefined;
      if (
        (body.role === 'user' || body.role === 'project_admin')
        && body.projectId
        && typeof body.projectId === 'string'
      ) {
        initialProjectIds = [body.projectId];
      }

      // Clamped to the inviting admin's own effective permission — an admin
      // can never grant a new user a higher service permission than they
      // themselves hold (same rule as token minting in tokens.ts).
      const servicePermissions = (await resolveRequestedTokenScope(
        db,
        session.userId,
        body.servicePermissions,
      )) ?? {};

      const user = await db.createUser({
        canLogin,
        email: trimmedEmail,
        features: [],
        invitedAt: new Date(),
        invitedBy: session.userId,
        licenseId: tenant.licenseType,
        mustChangePassword,
        name: body.name,
        password: hashedPassword,
        projectIds: initialProjectIds,
        role: body.role as 'user' | 'admin' | 'project_admin',
        servicePermissions,
        tenantId: session.tenantId,
      });

      if (
        body.projectId
        && typeof body.projectId === 'string'
        && (body.role === 'user' || body.role === 'project_admin')
      ) {
        await db.upsertUserProject({
          invitedBy: session.userId,
          projectId: body.projectId,
          role: body.role === 'project_admin' ? 'project_admin' : 'member',
          servicePermissions: undefined,
          tenantId: session.tenantId,
          userId: String(user._id),
        });
      }

      if (sendInvite) {
        sendEmail(trimmedEmail, 'user-invitation', {
          companyName: tenant.companyName,
          email: trimmedEmail,
          inviterName: session.userRole,
          loginUrl: `${getConfig().app.url}/login`,
          name: body.name,
          slug: tenant.slug,
          tempPassword,
        }).catch((error: Error) => {
          logger.error('Failed to send invitation email', { error });
        });
      }

      return reply.code(201).send({
        message: sendInvite ? 'User invited successfully' : 'User created successfully',
        user: {
          canLogin: user.canLogin !== false,
          email: user.email,
          id: user._id,
          name: user.name,
          role: user.role,
          servicePermissions: normalizeServicePermissions(user.servicePermissions),
        },
        // Shown once, mirroring POST /tokens' one-time plaintext `token`
        // field — never retrievable again after this response.
        ...(sendInvite ? {} : { generatedPassword: tempPassword }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Invite user error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
