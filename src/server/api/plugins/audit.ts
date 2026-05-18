import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { RBAC_SERVICE_DEFINITIONS, SERVICE_PERMISSION_LEVELS } from '@/lib/security/rbac';
import { listAuditLogs, sanitizeAuditLog } from '@/lib/services/audit';
import {
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:audit');

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export const auditApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/audit/logs', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as {
        action?: string;
        actorUserId?: string;
        from?: string;
        limit?: string;
        outcome?: string;
        service?: string;
        skip?: string;
        to?: string;
      };

      const limit = query.limit ? Number(query.limit) : 100;
      const skip = query.skip ? Number(query.skip) : 0;
      const logs = await listAuditLogs(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        {
          action: query.action,
          actorUserId: query.actorUserId,
          from: parseDate(query.from),
          limit: Number.isFinite(limit) ? limit : 100,
          outcome: query.outcome === 'success' || query.outcome === 'failure' || query.outcome === 'denied'
            ? query.outcome
            : undefined,
          service: query.service,
          skip: Number.isFinite(skip) ? skip : 0,
          to: parseDate(query.to),
        },
      );

      return reply.code(200).send({
        logs: logs.map(sanitizeAuditLog),
      });
    } catch (error) {
      logger.error('List audit logs error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/audit/services', withApiRequestContext(async (_request, reply) => {
    return reply.code(200).send({
      levels: SERVICE_PERMISSION_LEVELS,
      services: RBAC_SERVICE_DEFINITIONS,
    });
  }));
};
