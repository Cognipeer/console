/**
 * Client Users API plugin (token-authenticated admin surface).
 *
 * Programmatic (login-disabled) user + per-user API token provisioning. This
 * is deliberately a NARROWER surface than `client-members.ts`: it can only
 * create users with `canLogin: false` — a caller authenticated with an API
 * token can never use it to create a login-capable account. Minting a token
 * for an existing user is not restricted to login-disabled users (an admin
 * may also want to mint a service token for a regular member), but the target
 * user must always belong to the caller's own tenant and must never be MORE
 * privileged than the caller: nobody but the owner mints in the owner's name.
 *
 * Gated the same way as `client-members.ts`'s mutating endpoints: the
 * `members` RBAC service (adminService → admin-level, path-mapped in
 * rbac.ts) AND an explicit owner/admin check on the token owner.
 */

import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { IUser } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import {
  minPermission,
  normalizeServicePermissions,
  resolveCurrentServicePermission,
  type PermissionService,
  type ServicePermissionLevel,
  type UserRole,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import { generateSecurePassword } from '@/lib/services/auth/passwordGenerator';
import { BCRYPT_ROUNDS } from '@/lib/services/auth/passwordPolicy';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { readJsonBody, sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';
import { canActOnTokensOf, clampScopeToMinter, resolveRequestedTokenScope } from './tokens';

const logger = createLogger('api:client-users');

const GRANTABLE_TENANT_ROLES: UserRole[] = ['admin', 'project_admin', 'user'];

/** Same gate as client-members.ts: user/token provisioning is owner/admin-owned-token only. */
function isTenantAdmin(auth: ApiTokenContext): auth is ApiTokenContext & { user: IUser } {
  return auth.user?.role === 'owner' || auth.user?.role === 'admin';
}

function serializeUser(user: IUser) {
  return {
    _id: user._id,
    canLogin: user.canLogin !== false,
    createdAt: user.createdAt,
    email: user.email,
    invitedAt: user.invitedAt,
    invitedBy: user.invitedBy,
    name: user.name,
    role: user.role,
    servicePermissions: normalizeServicePermissions(user.servicePermissions),
    updatedAt: user.updatedAt,
  };
}

export const clientUsersApiPlugin: FastifyPluginAsync = async (app) => {
  // Creates a "Programmatic User" — canLogin is always forced to false here,
  // regardless of any input, so an API token can never provision a
  // login-capable account (privilege-escalation guard).
  app.post('/client/v1/users', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });

      const body = readJsonBody<{ email?: string; name?: string; role?: string; servicePermissions?: unknown }>(request);
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return reply.code(400).send({ error: 'Name is required' });
      }

      const role = body.role ?? 'user';
      if (!(GRANTABLE_TENANT_ROLES as string[]).includes(role)) {
        return reply.code(400).send({ error: 'Invalid role. Must be user, project_admin, or admin' });
      }

      const callerScope = auth.tokenRecord.servicePermissions;
      // An `admin` user is admin on EVERY service. A token that was itself
      // narrowed to a few services must not be able to create one — that would
      // be the token granting (to a user it can later mint for) more than it
      // holds. Only an unscoped owner/admin token may create admins.
      if (role === 'admin' && callerScope != null) {
        return reply.code(403).send({
          error: 'A scoped API token cannot create an admin user; use an unscoped owner/admin token',
        });
      }

      const trimmedEmail = typeof body.email === 'string' ? body.email.trim() : '';
      if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        return reply.code(400).send({ error: 'Invalid email format' });
      }

      const db = await getDatabase();

      if (trimmedEmail) {
        const existing = await db.findUserByEmail(trimmedEmail);
        if (existing) return reply.code(409).send({ error: 'User with this email already exists in your organization' });
      }

      const existingUsers = await db.listUsers();
      const quota = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: auth.tenant.licenseType as LicenseType,
          projectId: auth.projectId,
          tenantDbName: auth.tenantDbName,
          tenantId: auth.tenantId,
          userId: String(auth.tokenRecord.userId),
        },
        'users',
        existingUsers.length,
      );
      if (!quota.allowed) return reply.code(429).send({ error: quota.reason || 'User quota exceeded' });

      // Unused by a login-disabled account, but every user row needs a hash —
      // generated the same CSPRNG way as the dashboard's canLogin=false path.
      const tempPassword = generateSecurePassword();
      const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

      // Clamped to the CALLER's effective level per service (owner/admin role
      // capped by the token's own scope), exactly as the mint route clamps a
      // token: the profile written here is the ceiling every later unscoped
      // mint for this user resolves against, so it must not exceed what the
      // creating integration was ever allowed itself.
      const requested = normalizeServicePermissions(body.servicePermissions);
      const servicePermissions: UserServicePermissions = {};
      for (const [service, level] of Object.entries(requested) as Array<[PermissionService, ServicePermissionLevel]>) {
        const callerLevel = resolveCurrentServicePermission(auth.user, service, [], callerScope);
        servicePermissions[service] = minPermission(level, callerLevel);
      }

      const user = await db.createUser({
        canLogin: false,
        email: trimmedEmail,
        features: [],
        invitedAt: new Date(),
        invitedBy: String(auth.tokenRecord.userId),
        licenseId: auth.tenant.licenseType,
        mustChangePassword: false,
        name: body.name.trim(),
        password: hashedPassword,
        role: role as 'user' | 'admin' | 'project_admin',
        servicePermissions,
        tenantId: auth.tenantId,
      });

      return reply.code(201).send({ user: serializeUser(user) });
    } catch (error) {
      logger.error('Client create programmatic user error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // Mints a token for an existing user — the service-account pattern: a
  // Programmatic User (canLogin=false) can never reach the session-based
  // /tokens endpoint itself, so an admin token mints on its behalf here.
  app.post('/client/v1/users/:id/tokens', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      if (!isTenantAdmin(auth)) return reply.code(403).send({ error: 'Forbidden' });

      const { id } = request.params as { id: string };
      const body = readJsonBody<{ label?: string; servicePermissions?: unknown }>(request);
      if (!body.label || body.label.length < 3) {
        return reply.code(400).send({ error: 'Label must be at least 3 characters' });
      }

      const db = await getDatabase();
      const targetUser = await db.findUserById(id);
      if (!targetUser || String(targetUser.tenantId) !== String(auth.tenantId)) {
        return reply.code(404).send({ error: 'User not found' });
      }

      // Never upward: an admin-owned token cannot mint in the owner's name
      // (the minted token would authorise as the owner on every route).
      if (!canActOnTokensOf(auth.user.role, targetUser)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      // The target's profile is not a trustworthy ceiling on its own: this
      // same caller can create that user via POST /client/v1/users, so the
      // stored scope is pinned to min(requested-or-target, CALLER) per service,
      // where the caller's level already reflects its own token scope. The one
      // caller that may keep the legacy shape (unscoped when nothing was
      // requested) is an UNSCOPED owner token — it dominates every level, so
      // nothing it mints can exceed what it could grant directly.
      const callerScope = auth.tokenRecord.servicePermissions;
      const servicePermissions: UserServicePermissions | null =
        auth.user.role === 'owner' && callerScope == null
          ? await resolveRequestedTokenScope(db, id, body.servicePermissions)
          : clampScopeToMinter({
            minter: auth.user,
            minterTokenScope: callerScope,
            target: targetUser,
            requestedRaw: body.servicePermissions,
          });

      const existingTokens = await db.listProjectApiTokens(auth.tenantId, auth.projectId);
      const quotaCheck = await checkResourceQuota(
        {
          domain: 'global',
          licenseType: auth.tenant.licenseType as LicenseType,
          projectId: auth.projectId,
          tenantDbName: auth.tenantDbName,
          tenantId: auth.tenantId,
          userId: String(auth.tokenRecord.userId),
        },
        'apiTokens',
        existingTokens.length,
      );
      if (!quotaCheck.allowed) {
        return reply.code(429).send({ error: quotaCheck.reason || 'API token quota exceeded' });
      }

      const token = createApiTokenSecret();
      const apiToken = await db.createApiToken({
        label: body.label,
        projectId: auth.projectId,
        tenantId: auth.tenantId,
        tokenHash: hashApiToken(token),
        tokenPrefix: getApiTokenPrefix(token),
        userId: id,
        createdBy: String(auth.tokenRecord.userId),
        servicePermissions,
      });

      return reply.code(201).send({
        id: apiToken._id,
        label: apiToken.label,
        message: 'API token created successfully',
        servicePermissions: apiToken.servicePermissions ?? null,
        token,
        userId: apiToken.userId,
      });
    } catch (error) {
      logger.error('Client mint user token error', { error });
      return sendApiTokenError(reply, error) ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
