/**
 * Client Audit API plugin.
 *
 * Read-only access to the tenant's security/administrative audit trail for
 * token callers. Audit is tenant-scoped (NOT project-scoped) — the underlying
 * query is tenant-wide. RBAC (see ROUTE_PREFIXES → service 'audit', an admin
 * service) restricts this to owner/admin tokens or tokens with an explicit
 * `audit:read` grant.
 *
 *   GET /client/v1/audit/logs  – filtered + paginated audit events
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAuditLog } from '@/lib/database';
import { listAuditLogs, sanitizeAuditLog } from '@/lib/services/audit';
import { sendApiTokenError, withClientApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:client-audit');

/** Public token API cap — the dashboard route is uncapped, but this is not. */
const MAX_LIMIT = 1000;

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export const clientAuditApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/audit/logs', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const query = request.query as {
        action?: string; actorUserId?: string; from?: string; to?: string;
        method?: string; outcome?: string; q?: string; service?: string;
        limit?: string; skip?: string;
      };

      const rawLimit = query.limit ? Number(query.limit) : 100;
      const rawSkip = query.skip ? Number(query.skip) : 0;
      const limit = Number.isFinite(rawLimit) ? Math.min(rawLimit, MAX_LIMIT) : 100;
      const skip = Number.isFinite(rawSkip) ? rawSkip : 0;

      const outcome = query.outcome === 'success'
        || query.outcome === 'failure'
        || query.outcome === 'denied'
        ? query.outcome
        : undefined;

      const logs = await listAuditLogs(
        { tenantDbName: auth.tenantDbName, tenantId: auth.tenantId },
        {
          action: query.action || undefined,
          actorUserId: query.actorUserId || undefined,
          from: parseDate(query.from),
          to: parseDate(query.to),
          method: query.method ? query.method.toUpperCase() : undefined,
          outcome: outcome as IAuditLog['outcome'] | undefined,
          q: query.q?.trim() || undefined,
          service: query.service || undefined,
          limit,
          skip,
        },
      );

      return reply.code(200).send({
        object: 'list',
        data: logs.map(sanitizeAuditLog),
      });
    } catch (error) {
      logger.error('Client audit logs error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
