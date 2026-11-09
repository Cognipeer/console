/**
 * Dashboard Web Search plugin.
 *
 * Web search has two layers: a websearch provider record holds the connection (credentials, endpoint) and is managed
 * through the generic /api/providers routes with `type=websearch`; a web search INSTANCE holds the behavior (depth,
 * language, safe search, engines, AI answer, cache) and points at a provider by key.
 *   - GET    /api/websearch/providers/drivers    -> available websearch drivers
 *   - GET    /api/websearch/instances            -> instances visible in the active project
 *   - POST   /api/websearch/instances            -> create an instance (owner/admin)
 *   - GET    /api/websearch/instances/:key       -> one instance
 *   - PATCH  /api/websearch/instances/:key       -> update an instance (owner/admin; the key does not change)
 *   - DELETE /api/websearch/instances/:key       -> delete an instance (owner/admin)
 *   - GET    /api/websearch/instances/:key/logs  -> run logs of one instance
 *   - POST   /api/websearch/search               -> run a search (`instance`, or `provider` as an alias)
 * Compatibility for one release (existing keys keep working):
 *   - GET /api/websearch/providers               -> instances in the old row shape, plus provider rows that have
 *                                                   no instance yet (marked `kind: 'provider'`, `legacy: true`)
 *   - GET /api/websearch/providers/:key[/logs]   -> resolves an instance by key first, then the provider
 */

import { isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { providerRegistry } from '@/lib/providers';
import {
  getProviderConfigByKey,
  redactPlatformProvider,
} from '@/lib/services/providers/providerService';
import { listWebSearchRunLogs, runWebSearch } from '@/lib/services/webSearch';
import { WebSearchCacheConfigError } from '@/lib/services/webSearch/cacheSettings';
import {
  createWebSearchInstance,
  deleteWebSearchInstance,
  getWebSearchInstance,
  updateWebSearchInstance,
  WebSearchInstanceKeyExistsError,
  WebSearchInstanceNotFoundError,
} from '@/lib/services/webSearch/webSearchInstanceService';
import {
  listWebSearchCompatRows,
  listWebSearchInstanceViews,
  toCompatRow,
  toInstanceView,
} from '@/lib/services/webSearch/webSearchInstanceView';
import { sendPlanLimitRefusal } from '../planLimitReply';
import { sendProviderConfigError } from '../providerConfigErrors';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:websearch');

function isProviderAdmin(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** The one HTTP mapping of the errors an instance write can raise. */
function sendInstanceError(reply: FastifyReply, error: unknown) {
  if (error instanceof WebSearchInstanceKeyExistsError) {
    return reply.code(409).send({ error: error.message, code: error.code });
  }
  if (error instanceof WebSearchInstanceNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof WebSearchCacheConfigError) {
    return reply.code(400).send({ error: error.message });
  }
  if (sendProviderConfigError(reply, error)) return reply;
  logger.error('Web search instance request failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  return reply.code(500).send({ error: 'Internal server error' });
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function readStatus(value: unknown): 'active' | 'disabled' | undefined {
  return value === 'active' || value === 'disabled' ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const websearchApiPlugin: FastifyPluginAsync = async (app) => {
  const sendRunLogs = async (
    request: FastifyRequest,
    reply: FastifyReply,
    tenantDbName: string,
    searchKey: string,
  ) => {
    const query = (request.query ?? {}) as { limit?: string; skip?: string; from?: string; to?: string };
    const logs = await listWebSearchRunLogs(tenantDbName, searchKey, {
      limit: query.limit ? Math.min(Number(query.limit) || 50, 200) : 50,
      skip: query.skip ? Number(query.skip) || 0 : 0,
      from: parseDate(query.from),
      to: parseDate(query.to),
    });
    return reply.code(200).send({ logs });
  };

  app.get('/websearch/providers/drivers', withApiRequestContext(async (request, reply) => {
    try {
      const drivers = providerRegistry.listTenantDescriptors('websearch');
      return reply.code(200).send({ drivers });
    } catch (error) {
      logger.error('List websearch drivers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Instances ──────────────────────────────────────────────────────────────

  app.get('/websearch/instances', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      const { instances } = await listWebSearchInstanceViews(session.tenantDbName, session.tenantId, projectId);
      return reply.code(200).send({ instances });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/websearch/instances', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isProviderAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const { projectId } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.key !== 'string' || typeof body.name !== 'string' || typeof body.providerKey !== 'string') {
        return reply.code(400).send({ error: '`key`, `name` and `providerKey` are required.' });
      }
      if (body.settings !== undefined && !isPlainObject(body.settings)) {
        return reply.code(400).send({ error: '`settings` must be an object.' });
      }

      // `platform` is never read from the body: only the hosting layer marks a record as platform-provided.
      const instance = await createWebSearchInstance(session.tenantDbName, session.tenantId, {
        key: body.key,
        name: body.name,
        description: typeof body.description === 'string' ? body.description : undefined,
        providerKey: body.providerKey,
        // Owned by the active project unless the caller (owner/admin, checked above) asks for a tenant-wide one.
        projectId: body.tenantWide === true ? null : projectId,
        status: readStatus(body.status),
        settings: body.settings as Record<string, unknown> | undefined,
        createdBy: session.userId,
      });
      const provider = await getProviderConfigByKey(session.tenantDbName, session.tenantId, instance.providerKey, projectId);
      return reply.code(201).send({ instance: toInstanceView(instance, provider) });
    } catch (error) {
      return sendProjectContextError(reply, error) ?? sendInstanceError(reply, error);
    }
  }));

  app.get('/websearch/instances/:key', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const instance = await getWebSearchInstance(session.tenantDbName, session.tenantId, key, projectId);
      if (!instance) return reply.code(404).send({ error: 'Web search instance not found' });
      const provider = await getProviderConfigByKey(session.tenantDbName, session.tenantId, instance.providerKey, projectId);
      return reply.code(200).send({ instance: toInstanceView(instance, provider) });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/websearch/instances/:key', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isProviderAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const { projectId } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.key !== undefined && body.key !== key) {
        return reply.code(400).send({ error: 'The key of an instance cannot be changed.', field: 'key' });
      }
      if (body.settings !== undefined && !isPlainObject(body.settings)) {
        return reply.code(400).send({ error: '`settings` must be an object.' });
      }
      const existing = await getWebSearchInstance(session.tenantDbName, session.tenantId, key, projectId);
      if (!existing) return reply.code(404).send({ error: 'Web search instance not found' });

      const instance = await updateWebSearchInstance(session.tenantDbName, session.tenantId, key, {
        name: typeof body.name === 'string' ? body.name : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        providerKey: typeof body.providerKey === 'string' ? body.providerKey : undefined,
        status: readStatus(body.status),
        settings: body.settings as Record<string, unknown> | undefined,
        updatedBy: session.userId,
      });
      const provider = await getProviderConfigByKey(session.tenantDbName, session.tenantId, instance.providerKey, projectId);
      return reply.code(200).send({ instance: toInstanceView(instance, provider) });
    } catch (error) {
      return sendProjectContextError(reply, error) ?? sendInstanceError(reply, error);
    }
  }));

  app.delete('/websearch/instances/:key', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      if (!isProviderAdmin(session.userRole)) {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const { projectId } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const existing = await getWebSearchInstance(session.tenantDbName, session.tenantId, key, projectId);
      if (!existing) return reply.code(404).send({ error: 'Web search instance not found' });
      const deleted = await deleteWebSearchInstance(session.tenantDbName, session.tenantId, key);
      if (!deleted) return reply.code(404).send({ error: 'Web search instance not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendProjectContextError(reply, error) ?? sendInstanceError(reply, error);
    }
  }));

  app.get('/websearch/instances/:key/logs', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const instance = await getWebSearchInstance(session.tenantDbName, session.tenantId, key, projectId);
      if (!instance) return reply.code(404).send({ error: 'Web search instance not found' });
      return await sendRunLogs(request, reply, session.tenantDbName, key);
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Compatible provider routes (instances first, then provider rows) ───────

  app.get('/websearch/providers', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      // The page opens its edit form from the provider rows: they carry which credential fields are stored.
      const providers = await listWebSearchCompatRows(
        session.tenantDbName,
        session.tenantId,
        projectId,
        { credentialFields: true },
      );
      return reply.code(200).send({ providers });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/websearch/providers/:key', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const instance = await getWebSearchInstance(session.tenantDbName, session.tenantId, key, projectId);
      if (instance) {
        const behindIt = await getProviderConfigByKey(session.tenantDbName, session.tenantId, instance.providerKey, projectId);
        const view = toInstanceView(instance, behindIt);
        return reply.code(200).send({
          provider: toCompatRow(view, behindIt ?? undefined),
          instance: view,
        });
      }
      // The page opens its edit form from this provider: it carries which credential fields are stored.
      const provider = await getProviderConfigByKey(
        session.tenantDbName,
        session.tenantId,
        key,
        projectId,
        { credentialFields: true },
      );
      if (!provider || provider.type !== 'websearch') {
        return reply.code(404).send({ error: 'Web search instance not found' });
      }
      return reply.code(200).send({
        provider: { ...redactPlatformProvider(provider), kind: 'provider', legacy: true },
      });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/websearch/providers/:key/logs', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const instance = await getWebSearchInstance(session.tenantDbName, session.tenantId, key, projectId);
      if (!instance) {
        const provider = await getProviderConfigByKey(session.tenantDbName, session.tenantId, key, projectId);
        if (!provider || provider.type !== 'websearch') {
          return reply.code(404).send({ error: 'Web search instance not found' });
        }
      }
      return await sendRunLogs(request, reply, session.tenantDbName, key);
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/websearch/search', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string' || body.query.trim() === '') {
        return reply.code(400).send({ error: '`query` is required.' });
      }

      const result = await runWebSearch(session.tenantDbName, session.tenantId, projectId, {
        query: body.query,
        // `instance` is the name; `provider` stays as an alias (the resolver takes an instance key or a provider key).
        providerKey: typeof body.instance === 'string' && body.instance
          ? body.instance
          : typeof body.provider === 'string' ? body.provider : undefined,
        includeAnswer: body.includeAnswer === true || body.include_answer === true,
        count: typeof body.count === 'number' ? body.count : undefined,
        offset: typeof body.offset === 'number' ? body.offset : undefined,
        language: typeof body.language === 'string' ? body.language : undefined,
        country: typeof body.country === 'string' ? body.country : undefined,
        safeSearch:
          body.safeSearch === 'off' || body.safeSearch === 'moderate' || body.safeSearch === 'strict'
            ? body.safeSearch
            : undefined,
        source: 'dashboard',
      });

      return reply.code(200).send({ result });
    } catch (error) {
      const handled = sendProjectContextError(reply, error) ?? sendPlanLimitRefusal(reply, error);
      if (handled) return handled;
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      logger.error('Dashboard web search error', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
