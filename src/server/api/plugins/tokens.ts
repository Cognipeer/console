import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import {
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  readJsonBody,
  withApiRequestContext,
} from '../fastify-utils';

const ALLOWED_ROLES = new Set(['owner', 'admin', 'project_admin', 'user']);

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
      const body = readJsonBody<{ label?: string }>(request);

      if (!body.label || body.label.length < 3) {
        return reply.code(400).send({ error: 'Label must be at least 3 characters' });
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

      const token = `cpeer_${crypto.randomBytes(32).toString('hex')}`;
      const apiToken = await db.createApiToken({
        label: body.label,
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
