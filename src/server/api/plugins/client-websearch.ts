/**
 * Client v1 Web Search plugin.
 *
 * Surfaces:
 *   - GET  /api/client/v1/websearch/providers   → web search instances visible to token
 *   - POST /api/client/v1/websearch/search      → search (default or `provider` in body)
 *   - POST /api/client/v1/websearch/:key/search → search on a named instance
 *
 * Request shape:
 *   { query, provider?, count?, offset?, language?, country?, safe_search?,
 *     include_answer? } — include_answer requires the instance to have AI
 *   answers enabled (settings.aiAnswer); otherwise the request fails.
 * Response shape (normalized across drivers):
 *   { id, provider, driver, query, answer?, results: [{ title, url, snippet,
 *     position, published_at?, source?, score? }], latency_ms }
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { listWebSearchProviders, runWebSearch } from '@/lib/services/webSearch';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-websearch');

export const clientWebSearchApiPlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/client/v1/websearch/providers',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const providers = await listWebSearchProviders(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
        );
        return reply.code(200).send({
          providers: providers.map((p) => ({
            key: p.key,
            driver: p.driver,
            label: p.label,
            status: p.status,
            aiAnswer:
              ((p.settings as Record<string, unknown>)?.aiAnswer as { enabled?: boolean } | undefined)
                ?.enabled === true,
          })),
        });
      } catch (error) {
        logger.error('List client websearch providers error', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    }),
  );

  const handleSearch = async (
    request: Parameters<Parameters<typeof withClientApiRequestContext>[0]>[0],
    reply: Parameters<Parameters<typeof withClientApiRequestContext>[0]>[1],
    explicitKey?: string,
  ) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string' || body.query.trim() === '') {
        return reply.code(400).send({ error: '`query` is required.' });
      }

      const safeSearchRaw = body.safe_search ?? body.safeSearch;
      const includeAnswerRaw = body.include_answer ?? body.includeAnswer ?? body.answer;
      const result = await runWebSearch(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        query: body.query,
        providerKey:
          explicitKey ?? (typeof body.provider === 'string' ? body.provider : undefined),
        count: typeof body.count === 'number' ? body.count : undefined,
        offset: typeof body.offset === 'number' ? body.offset : undefined,
        language: typeof body.language === 'string' ? body.language : undefined,
        country: typeof body.country === 'string' ? body.country : undefined,
        safeSearch:
          safeSearchRaw === 'off' || safeSearchRaw === 'moderate' || safeSearchRaw === 'strict'
            ? safeSearchRaw
            : undefined,
        includeAnswer: includeAnswerRaw === true,
        source: 'api',
      });

      return reply.code(200).send({
        id: `websearch-${Date.now().toString(36)}`,
        provider: result.providerKey,
        driver: result.driver,
        query: result.query,
        answer: result.answer,
        answer_model: result.answerModel,
        results: result.results.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          position: r.position,
          published_at: r.publishedAt,
          source: r.source,
          score: r.score,
        })),
        latency_ms: result.latencyMs,
      });
    } catch (error) {
      logger.error('Run client web search error', { error });
      return reply.code(400).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  };

  app.post(
    '/client/v1/websearch/search',
    withClientApiRequestContext(async (request, reply) => handleSearch(request, reply)),
  );

  app.post(
    '/client/v1/websearch/:key/search',
    withClientApiRequestContext(async (request, reply) => {
      const { key } = request.params as { key: string };
      return handleSearch(request, reply, key);
    }),
  );
};
