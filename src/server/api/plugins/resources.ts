/**
 * Resource Registry API — read-only, tenant-wide inventory across all projects.
 *
 * The tenant ALWAYS comes from the session. RBAC is applied by
 * withApiRequestContext via the `/api/resources` prefix → `resources` service
 * (adminService: owner/admin by default, anyone else only with an explicit grant).
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ResourceQueryError,
  getResource,
  listResources,
} from '@/lib/resources/service';
import { requireSessionContext, withApiRequestContext } from '../fastify-utils';

const logger = createLogger('api:resources');

function firstString(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** undefined when absent; null when present but not a whole number in range. */
function parseIntParam(value: unknown, min: number): number | undefined | null {
  const raw = firstString(value);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

export const resourcesApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/resources', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as Record<string, unknown>;

      const limit = parseIntParam(query.limit, 1);
      const offset = parseIntParam(query.offset, 0);
      if (limit === null) return reply.code(400).send({ error: 'limit must be a positive integer' });
      if (offset === null) return reply.code(400).send({ error: 'offset must be a non-negative integer' });

      const refreshRaw = firstString(query.refresh);
      const result = await listResources({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        type: firstString(query.type),
        projectId: firstString(query.projectId),
        q: firstString(query.q),
        status: firstString(query.status),
        limit: Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
        offset: offset ?? 0,
        refresh: refreshRaw === '1' || refreshRaw === 'true',
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ResourceQueryError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('List resources error', { error });
      return reply.code(500).send({ error: 'Failed to list resources' });
    }
  }));

  app.get('/resources/:type/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { type, id } = request.params as { type: string; id: string };
      const resource = await getResource({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        type,
        id,
      });
      if (!resource) return reply.code(404).send({ error: 'Resource not found' });
      return reply.code(200).send({ resource });
    } catch (error) {
      logger.error('Get resource error', { error });
      return reply.code(500).send({ error: 'Failed to load resource' });
    }
  }));
};
