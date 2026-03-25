import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { LicenseType } from '@/lib/license/license-manager';
import type { QuotaDomain, QuotaPolicyInput, QuotaScope } from '@/lib/quota/types';
import {
  createQuotaPolicy,
  deleteQuotaPolicy,
  getPlanDefaults,
  listQuotaPolicies,
  updateQuotaPolicy,
} from '@/lib/services/quota/quotaService';
import {
  parseBooleanQuery,
  readJsonBody,
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:quota');

function isQuotaAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export const quotaApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/quota/defaults', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const licenseType = session.licenseType;

      if (!licenseType) {
        return reply.code(400).send({ error: 'License type not found on request' });
      }

      const defaults = await getPlanDefaults(licenseType as LicenseType);
      return reply.code(200).send({ defaults, licenseType });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Get quota defaults error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/quota/policies', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as {
        domain?: QuotaDomain;
        enabled?: string;
        projectId?: string;
        scope?: QuotaScope;
      };

      const policies = await listQuotaPolicies(session.tenantDbName, session.tenantId, {
        domain: query.domain || undefined,
        enabled: parseBooleanQuery(query.enabled),
        projectId: query.projectId || undefined,
        scope: query.scope || undefined,
      });

      return reply.code(200).send({ policies });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('List quota policies error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/quota/policies', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isQuotaAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const query = (request.query ?? {}) as { projectId?: string };
      const body = readJsonBody<Partial<QuotaPolicyInput>>(request);

      if (!body.scope || !body.domain || !body.limits) {
        return reply.code(400).send({ error: 'scope, domain and limits are required' });
      }

      const policy = await createQuotaPolicy(session.tenantDbName, session.tenantId, {
        createdBy: session.userId,
        description: body.description,
        domain: body.domain,
        enabled: body.enabled ?? true,
        label: body.label ?? 'Custom policy',
        limits: body.limits,
        priority: Number(body.priority ?? 100),
        projectId: query.projectId ?? body.projectId,
        scope: body.scope,
        scopeId: body.scopeId,
        updatedBy: session.userId,
      });

      return reply.code(201).send({ policy });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Create quota policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/quota/policies/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isQuotaAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const query = (request.query ?? {}) as { projectId?: string };
      const body = readJsonBody<Partial<QuotaPolicyInput>>(request);

      const policy = await updateQuotaPolicy(
        session.tenantDbName,
        session.tenantId,
        id,
        { ...body, updatedBy: session.userId },
        query.projectId ?? body.projectId ?? undefined,
      );

      if (!policy) {
        return reply.code(404).send({ error: 'Policy not found' });
      }

      return reply.code(200).send({ policy });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Update quota policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.delete('/quota/policies/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const session = requireSessionContext(request);
      if (!isQuotaAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const query = (request.query ?? {}) as { projectId?: string };
      const deleted = await deleteQuotaPolicy(
        session.tenantDbName,
        session.tenantId,
        id,
        query.projectId || undefined,
      );

      if (!deleted) {
        return reply.code(404).send({ error: 'Policy not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      logger.error('Delete quota policy error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
