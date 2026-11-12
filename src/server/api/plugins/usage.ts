import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import { listLimitEvents } from '@/lib/limits/events';
import { planLimitsActive } from '@/lib/limits/mode';
import type { PlanLimitKind } from '@/lib/limits/types';
import { buildUsageSummary } from '@/lib/limits/usageSummary';
import { requireSessionContext, withApiRequestContext } from '../fastify-utils';
import { authz } from '@/lib/iam/routeAuthz';

/** Every route here is gated by the "license" service (the same one its path prefix maps to). */
const GATE = { config: authz.service('license') } as const;

const logger = createLogger('api:usage');

const EVENT_KINDS: readonly PlanLimitKind[] = [
  'api_rpm',
  'concurrency',
  'monthly',
  'storage',
  'seats',
  'credits',
  'context',
  'feature',
];

function canViewUsage(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Plan usage for hosted tenants. Every route answers 404 when plan limits are
 * off (always on an onprem deployment), so the surface does not exist there.
 */
export const usageApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/usage/summary', GATE, withApiRequestContext(async (request, reply) => {
    if (!planLimitsActive()) return reply.code(404).send({ error: 'Not Found' });
    try {
      const session = requireSessionContext(request);
      if (!canViewUsage(session.userRole)) return reply.code(403).send({ error: 'Forbidden' });
      const summary = await runWithTenantScope(session.tenantDbName, () => buildUsageSummary(session.tenantId));
      if (!summary) return reply.code(404).send({ error: 'Not Found' });
      return reply.code(200).send(summary);
    } catch (error) {
      logger.error('Get usage summary error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/usage/events', GATE, withApiRequestContext(async (request, reply) => {
    if (!planLimitsActive()) return reply.code(404).send({ error: 'Not Found' });
    try {
      const session = requireSessionContext(request);
      if (!canViewUsage(session.userRole)) return reply.code(403).send({ error: 'Forbidden' });
      const query = request.query as { since?: string; dimension?: string; kind?: string; limit?: string };
      let since: Date | undefined;
      if (query.since) {
        const parsed = new Date(query.since);
        if (Number.isNaN(parsed.getTime())) return reply.code(400).send({ error: 'Invalid since' });
        since = parsed;
      }
      const kind = EVENT_KINDS.find((candidate) => candidate === query.kind);
      const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
      let events = await listLimitEvents(session.tenantId, {
        since,
        kind,
        limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
      });
      if (query.dimension) events = events.filter((event) => event.dimension === query.dimension);
      return reply.code(200).send({ events });
    } catch (error) {
      logger.error('List usage events error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
