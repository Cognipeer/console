import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import {
  readJsonBody,
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:users');

function isUserAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export const usersApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/users', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const users = await db.listUsers();
      return reply.code(200).send({ users });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('List users error', { error });
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

  app.post('/users/invite', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isUserAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Only owners and admins can invite users' });
      }

      const body = readJsonBody<{
        email?: string;
        name?: string;
        projectId?: string;
        role?: string;
      }>(request);

      if (!body.name || !body.email || !body.role) {
        return reply.code(400).send({ error: 'Name, email, and role are required' });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(body.email)) {
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
      const existingUser = await db.findUserByEmail(body.email);
      if (existingUser) {
        return reply.code(409).send({
          error: 'User with this email already exists in your organization',
        });
      }

      const tempPassword = Math.random().toString(36).slice(-12);
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

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

      const user = await db.createUser({
        email: body.email,
        features: [],
        invitedAt: new Date(),
        invitedBy: session.userId,
        licenseId: tenant.licenseType,
        mustChangePassword: true,
        name: body.name,
        password: hashedPassword,
        projectIds: initialProjectIds,
        role: body.role as 'user' | 'admin' | 'project_admin',
        tenantId: session.tenantId,
      });

      sendEmail(body.email, 'user-invitation', {
        companyName: tenant.companyName,
        inviterName: session.userRole,
        name: body.name,
        slug: tenant.slug,
        tempPassword,
      }).catch((error: Error) => {
        logger.error('Failed to send invitation email', { error });
      });

      return reply.code(201).send({
        message: 'User invited successfully',
        user: {
          email: user.email,
          id: user._id,
          name: user.name,
          role: user.role,
        },
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
