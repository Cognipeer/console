import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IAuditLog } from '@/lib/database';
import { RBAC_SERVICE_DEFINITIONS, SERVICE_PERMISSION_LEVELS } from '@/lib/security/rbac';
import { listAuditLogs, sanitizeAuditLog, type AuditLogListFilters } from '@/lib/services/audit';
import {
  requireSessionContext,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:audit');

const EXPORT_MAX_ROWS = 10_000;
const EXPORT_BATCH_SIZE = 500;

interface AuditQuery {
  action?: string;
  actorUserId?: string;
  format?: string;
  from?: string;
  limit?: string;
  method?: string;
  outcome?: string;
  q?: string;
  service?: string;
  skip?: string;
  to?: string;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseFilters(query: AuditQuery): Omit<AuditLogListFilters, 'limit' | 'skip'> {
  return {
    action: query.action || undefined,
    actorUserId: query.actorUserId || undefined,
    from: parseDate(query.from),
    method: query.method ? query.method.toUpperCase() : undefined,
    outcome: query.outcome === 'success' || query.outcome === 'failure' || query.outcome === 'denied'
      ? query.outcome
      : undefined,
    q: query.q?.trim() || undefined,
    service: query.service || undefined,
    to: parseDate(query.to),
  };
}

const EXPORT_COLUMNS: Array<{ header: string; value: (log: IAuditLog) => unknown }> = [
  { header: 'time', value: (log) => log.createdAt instanceof Date ? log.createdAt.toISOString() : log.createdAt },
  { header: 'service', value: (log) => log.service },
  { header: 'action', value: (log) => log.action },
  { header: 'event', value: (log) => log.event },
  { header: 'method', value: (log) => log.method },
  { header: 'path', value: (log) => log.path },
  { header: 'status_code', value: (log) => log.statusCode },
  { header: 'outcome', value: (log) => log.outcome },
  { header: 'actor_type', value: (log) => log.actorType },
  { header: 'actor_email', value: (log) => log.actorEmail },
  { header: 'actor_role', value: (log) => log.actorRole },
  { header: 'actor_user_id', value: (log) => log.actorUserId },
  { header: 'api_token_id', value: (log) => log.apiTokenId },
  { header: 'ip_address', value: (log) => log.ipAddress },
  { header: 'user_agent', value: (log) => log.userAgent },
  { header: 'request_id', value: (log) => log.requestId },
  { header: 'project_id', value: (log) => log.projectId },
  { header: 'resource_type', value: (log) => log.resourceType },
  { header: 'resource_id', value: (log) => log.resourceId },
  { header: 'metadata', value: (log) => log.metadata && Object.keys(log.metadata).length ? JSON.stringify(log.metadata) : '' },
  { header: 'id', value: (log) => typeof log._id === 'string' ? log._id : log._id?.toString() },
];

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function logsToCsv(logs: IAuditLog[]): string {
  const header = EXPORT_COLUMNS.map((c) => c.header).join(',');
  const rows = logs.map((log) =>
    EXPORT_COLUMNS
      .map((c) => {
        const value = c.value(log);
        return csvEscape(value === null || value === undefined ? '' : String(value));
      })
      .join(','));
  return [header, ...rows].join('\n');
}

export const auditApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/audit/logs', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as AuditQuery;

      const limit = query.limit ? Number(query.limit) : 100;
      const skip = query.skip ? Number(query.skip) : 0;
      const logs = await listAuditLogs(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId },
        {
          ...parseFilters(query),
          limit: Number.isFinite(limit) ? limit : 100,
          skip: Number.isFinite(skip) ? skip : 0,
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

  app.get('/audit/logs/export', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as AuditQuery;
      const format = query.format === 'json' ? 'json' : 'csv';
      const filters = parseFilters(query);
      const context = { tenantDbName: session.tenantDbName, tenantId: session.tenantId };

      const logs: IAuditLog[] = [];
      while (logs.length < EXPORT_MAX_ROWS) {
        const batch = await listAuditLogs(context, {
          ...filters,
          limit: Math.min(EXPORT_BATCH_SIZE, EXPORT_MAX_ROWS - logs.length),
          skip: logs.length,
        });
        logs.push(...batch);
        if (batch.length < EXPORT_BATCH_SIZE) {
          break;
        }
      }

      const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const filename = `audit-logs-${timestamp}.${format}`;
      reply.header('content-disposition', `attachment; filename="${filename}"`);

      if (format === 'json') {
        return reply
          .code(200)
          .header('content-type', 'application/json; charset=utf-8')
          .send(JSON.stringify({ exportedAt: new Date().toISOString(), count: logs.length, logs: logs.map(sanitizeAuditLog) }, null, 2));
      }

      return reply
        .code(200)
        .header('content-type', 'text/csv; charset=utf-8')
        .send(logsToCsv(logs));
    } catch (error) {
      logger.error('Export audit logs error', { error });
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
