import type { FastifyPluginAsync } from 'fastify';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import {
  getEffectiveServicePermission,
  minPermission,
  normalizeServicePermissions,
  type PermissionService,
  type UserServicePermissions,
} from '@/lib/security/rbac';
import {
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  readJsonBody,
  withApiRequestContext,
} from '../fastify-utils';

const ALLOWED_ROLES = new Set(['owner', 'admin', 'project_admin', 'user']);

/**
 * Normalise a requested per-token scope and CLAMP every service to the minting
 * user's own effective permission — a token can never be minted above its owner
 * (the runtime RBAC cap enforces this too; this is defense-in-depth + honesty in
 * the stored value). Returns `null` when no scope was requested (unscoped token,
 * inherits owner — the legacy default). Returns an object (possibly `{}`) when a
 * scope WAS requested (least-privilege allowlist).
 */
async function resolveRequestedTokenScope(
  db: Awaited<ReturnType<typeof getDatabase>>,
  minterUserId: string,
  requestedRaw: unknown,
): Promise<UserServicePermissions | null> {
  if (requestedRaw === undefined || requestedRaw === null) {
    return null;
  }
  const requested = normalizeServicePermissions(requestedRaw);
  const minter = await db.findUserById(minterUserId);
  const scope: UserServicePermissions = {};
  for (const [service, level] of Object.entries(requested)) {
    const ownerLevel = minter
      ? getEffectiveServicePermission(minter, service as PermissionService)
      : 'none';
    scope[service as PermissionService] = minPermission(level, ownerLevel);
  }
  return scope;
}

export const tokensApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/tokens', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const db = await getDatabase();
      const allTokens = await db.listProjectApiTokens(session.tenantId, projectId);
      const canDeleteAll =
        session.userRole === 'owner'
        || session.userRole === 'admin'
        || session.userRole === 'project_admin';

      return reply.code(200).send({
        tokens: allTokens.map((token) => ({
          _id: token._id,
          canDelete: canDeleteAll || String(token.userId) === String(session.userId),
          createdAt: token.createdAt,
          label: token.label,
          lastUsed: token.lastUsed,
          servicePermissions: token.servicePermissions ?? null,
          tokenPrefix: token.tokenPrefix,
          userId: token.userId,
        })),
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/tokens', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const body = readJsonBody<{ label?: string; servicePermissions?: unknown }>(request);

      if (!body.label || body.label.length < 3) {
        return reply.code(400).send({ error: 'Label must be at least 3 characters' });
      }

      const db = await getDatabase();
      const servicePermissions = await resolveRequestedTokenScope(
        db,
        session.userId,
        body.servicePermissions,
      );
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
        label: body.label,
        projectId,
        tenantId: session.tenantId,
        tokenHash: hashApiToken(token),
        tokenPrefix: getApiTokenPrefix(token),
        userId: session.userId,
        servicePermissions,
      });

      return reply.code(201).send({
        id: apiToken._id,
        label: apiToken.label,
        message: 'API token created successfully',
        servicePermissions: apiToken.servicePermissions ?? null,
        token,
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/tokens/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!ALLOWED_ROLES.has(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const { projectId } = await requireProjectContextForRequest(request);
      const db = await getDatabase();

      const deleted = session.userRole === 'user'
        ? await (async () => {
          const ownTokens = await db.listApiTokens(session.userId);
          const token = ownTokens.find((item) => String(item._id) === String(id));
          if (!token) {
            return false;
          }
          if (
            String(token.tenantId) !== String(session.tenantId)
            || String(token.projectId) !== String(projectId)
          ) {
            return false;
          }
          return db.deleteApiToken(id, session.userId);
        })()
        : await db.deleteProjectApiToken(id, session.tenantId, projectId);

      if (!deleted) {
        return reply.code(404).send({ error: 'Token not found' });
      }

      return reply.code(200).send({ message: 'API token deleted successfully' });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
