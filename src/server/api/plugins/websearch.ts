/**
 * Dashboard Web Search plugin.
 *
 * A "Web Search instance" is a websearch-domain provider record; instance
 * CRUD goes through the generic /api/providers routes with `type=websearch`.
 * This plugin adds the instance-centric surfaces:
 *   - GET  /api/websearch/providers/drivers    → available websearch drivers
 *   - GET  /api/websearch/providers            → instances in scope
 *   - GET  /api/websearch/providers/:key       → one instance
 *   - GET  /api/websearch/providers/:key/logs  → run logs for one instance
 *   - POST /api/websearch/search               → run a search (instance playground)
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { providerRegistry } from '@/lib/providers';
import { getProviderConfigByKey } from '@/lib/services/providers/providerService';
import {
  listWebSearchProviders,
  listWebSearchRunLogs,
  runWebSearch,
} from '@/lib/services/webSearch';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:websearch');

export const websearchApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/websearch/providers/drivers', withApiRequestContext(async (request, reply) => {
    try {
      const drivers = providerRegistry.listDescriptors('websearch');
      return reply.code(200).send({ drivers });
    } catch (error) {
      logger.error('List websearch drivers error', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/websearch/providers', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { projectId } = await requireProjectContextForRequest(request);
      const providers = await listWebSearchProviders(
        session.tenantDbName,
        session.tenantId,
        projectId,
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
      const provider = await getProviderConfigByKey(
        session.tenantDbName,
        session.tenantId,
        key,
        projectId,
      );
      if (!provider || provider.type !== 'websearch') {
        return reply.code(404).send({ error: 'Web search instance not found' });
      }
      return reply.code(200).send({ provider });
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
      const provider = await getProviderConfigByKey(
        session.tenantDbName,
        session.tenantId,
        key,
        projectId,
      );
      if (!provider || provider.type !== 'websearch') {
        return reply.code(404).send({ error: 'Web search instance not found' });
      }
      const query = (request.query ?? {}) as {
        limit?: string;
        skip?: string;
        from?: string;
        to?: string;
      };
      const parseDate = (value?: string): Date | undefined => {
        if (!value) return undefined;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date;
      };
      const logs = await listWebSearchRunLogs(session.tenantDbName, key, {
        limit: query.limit ? Math.min(Number(query.limit) || 50, 200) : 50,
        skip: query.skip ? Number(query.skip) || 0 : 0,
        from: parseDate(query.from),
        to: parseDate(query.to),
      });
      return reply.code(200).send({ logs });
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
        providerKey: typeof body.provider === 'string' ? body.provider : undefined,
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
      const handled = sendProjectContextError(reply, error);
      if (handled) return handled;
      logger.error('Dashboard web search error', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
