/**
 * Resource Registry API — read-only, tenant-wide inventory across all projects.
 *
 * The tenant ALWAYS comes from the session. RBAC is applied by
 * withApiRequestContext via the `/api/resources` prefix → `resources` service
 * (adminService: owner/admin by default, anyone else only with an explicit grant).
 *
 *   GET /resources                    paged inventory, facets, filters (limit <= 200)
 *   GET /resources/search             type-ahead for pickers that store a key: several
 *                                     types, a filter on the display attributes, best
 *                                     match first, at most 50 rows (same gate, same data)
 *   GET /resources/health             reference problems
 *   GET /resources/:type/:id          one resource with its references
 *   GET /resource-usage/:type/:id     delete / rename impact
 *
 * `/api/resource-usage/:type/:id` is the exception: it is gated by the service
 * that owns `:type` (see usageAccess.ts) and answers only with what the caller's
 * projects may see.
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ResourceQueryError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  getResource,
  getResourceHealth,
  getResourceUsage,
  listResources,
  searchResources,
} from '@/lib/resources/service';
import { buildReferrerTypeAccess, registerResourceUsageAccess, resourceTypeService } from '@/lib/resources/usageAccess';
import { runWithTenantScope } from '@/lib/database';
import { collectAccessibleProjectIds } from '@/lib/services/projects/accessibleProjects';
import type { HealthIssueKind, HealthSeverity } from '@/lib/resources/types';
import { authorizeServiceForRequest, requireSessionContext, resolveSessionRbacContext, sendProjectContextError, withApiRequestContext } from '../fastify-utils';

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

/** `a,b` and a repeated `x=a&x=b` both read as ['a', 'b']; blanks are dropped. */
function listParam(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .filter((part): part is string => typeof part === 'string')
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * `attr=category:llm&attr=type:vector,file` -> `{ category: ['llm'], type: ['vector', 'file'] }`.
 * null when an entry is not `name:value[,value]`.
 */
function parseAttributeParams(value: unknown): Record<string, string[]> | null {
  // A Map, not an object literal: a name like `__proto__` must stay a (rejected) name, not rewire the object.
  const byName = new Map<string, string[]>();
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  for (const entry of entries) {
    if (typeof entry !== 'string') return null;
    const colon = entry.indexOf(':');
    if (colon <= 0) return null;
    const name = entry.slice(0, colon).trim();
    const values = listParam(entry.slice(colon + 1));
    if (name === '' || values.length === 0) return null;
    byName.set(name, [...(byName.get(name) ?? []), ...values]);
  }
  return Object.fromEntries(byName);
}

export const resourcesApiPlugin: FastifyPluginAsync = async (app) => {
  // Before the first request: the per-type RBAC resolver for the usage route.
  registerResourceUsageAccess();

  app.get('/resources', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as Record<string, unknown>;

      const limit = parseIntParam(query.limit, 1);
      const offset = parseIntParam(query.offset, 0);
      if (limit === null) return reply.code(400).send({ error: 'limit must be a positive integer' });
      if (offset === null) return reply.code(400).send({ error: 'offset must be a non-negative integer' });

      const healthRaw = firstString(query.health);
      if (healthRaw !== undefined && healthRaw !== 'issues') {
        return reply.code(400).send({ error: 'health must be "issues"' });
      }

      const refreshRaw = firstString(query.refresh);
      const result = await listResources({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        type: firstString(query.type),
        projectId: firstString(query.projectId),
        q: firstString(query.q),
        status: firstString(query.status),
        health: healthRaw === 'issues' ? 'issues' : undefined,
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

  // Type-ahead for pickers that store a key (a limit's target, a policy's
  // resource): a few types at once, a filter on the safe display attributes,
  // best match first, never more than SEARCH_MAX_LIMIT rows. Same registry
  // snapshot, same tenant guard and the SAME gate as the list above (the
  // `resources` service), so it shows exactly what the registry would.
  app.get('/resources/search', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as Record<string, unknown>;

      const limit = parseIntParam(query.limit, 1);
      if (limit === null) return reply.code(400).send({ error: 'limit must be a positive integer' });
      const types = listParam(query.types);
      if (types.length === 0) return reply.code(400).send({ error: 'types is required' });
      const attributes = parseAttributeParams(query.attr);
      if (attributes === null) return reply.code(400).send({ error: 'attr must look like name:value[,value]' });

      const result = await searchResources({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        types,
        q: firstString(query.q),
        attributes,
        limit: Math.min(limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT),
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ResourceQueryError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Search resources error', { error });
      return reply.code(500).send({ error: 'Failed to search resources' });
    }
  }));

  // Registered next to the list route; `health` is one path segment so it can
  // never collide with `/resources/:type/:id`.
  app.get('/resources/health', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const refreshRaw = firstString(query.refresh);
      const result = await getResourceHealth({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        severity: firstString(query.severity) as HealthSeverity | undefined,
        kind: firstString(query.kind) as HealthIssueKind | undefined,
        type: firstString(query.type),
        projectId: firstString(query.projectId),
        refresh: refreshRaw === '1' || refreshRaw === 'true',
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof ResourceQueryError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Resource health error', { error });
      return reply.code(500).send({ error: 'Failed to load resource health' });
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

  // Delete / rename impact of ONE resource for the caller. Gated by the type's
  // own service (resolver above), so a tools:read user can see tool usage.
  app.get('/resource-usage/:type/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { type, id } = request.params as { type: string; id: string };
      // The route gate already checked this, but it works on the request path;
      // authorise again here from the decoded params so the decision can never
      // depend on how the URL happened to be spelled.
      // The policy engine decides (with project narrowing and custom policies).
      const { user, groupGrants } = await resolveSessionRbacContext(session);
      const rbac = { user, groupGrants };
      const mayRead = async (service: ReturnType<typeof resourceTypeService>) =>
        (await authorizeServiceForRequest(request, service, { level: 'read', rbac })).allowed;
      if (!(await mayRead(resourceTypeService(type)))) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      // Tenant owner/admin see everything; everyone else only the projects they
      // belong to directly or through a group (same source as GET /api/projects).
      let visibleProjectIds: ReadonlySet<string> | null = null;
      if (user.role !== 'owner' && user.role !== 'admin') {
        const ids = await runWithTenantScope(session.tenantDbName, (db) =>
          collectAccessibleProjectIds(db, String(user._id), user.projectIds),
        );
        visibleProjectIds = new Set(ids);
      }

      const usage = await getResourceUsage({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        type,
        id,
        visibleProjectIds,
        // Referrers of a type the caller may not read are counted, never listed.
        // Tenant owner / admin keep seeing everything.
        canViewType: visibleProjectIds === null
          ? undefined
          : await buildReferrerTypeAccess(mayRead),
      });
      if (!usage) return reply.code(404).send({ error: 'Resource not found' });
      return reply.code(200).send(usage);
    } catch (error) {
      // The engine could not decide (the handler-level checks above): answered as the gate would, with its 503.
      const refused = sendProjectContextError(reply, error);
      if (refused) return refused;
      logger.error('Get resource usage error', { error });
      return reply.code(500).send({ error: 'Failed to load resource usage' });
    }
  }));
};
