/**
 * Client v1 Web Search plugin.
 *
 * Surfaces:
 *   - GET  /api/client/v1/websearch/instances   → web search instances visible to token
 *   - GET  /api/client/v1/websearch/providers   → the same list (older name); rows with `kind: 'provider'` are
 *                                                 provider records that have no instance yet
 *   - POST /api/client/v1/websearch/search      → search (default, or `instance` / `provider` in body)
 *   - POST /api/client/v1/websearch/:key/search → search on a named instance (a provider key still works)
 *
 * Request shape:
 *   { query, instance?, provider?, count?, offset?, language?, country?, safe_search?,
 *     include_answer? } — include_answer is best-effort: without AI answers
 *   enabled on the instance (settings.aiAnswer) the results come back with no
 *   `answer` and a `warnings` entry saying why.
 * Response shape (normalized across drivers):
 *   { id, provider, driver, query, answer?, results: [{ title, url, snippet,
 *     position, published_at?, source?, score? }], cached, cache?, warnings?,
 *     latency_ms } — `cached` is true when the results came from the
 *   instance's semantic cache; `cache` ({ status, similarity? }) appears only
 *   when the instance has caching enabled.
 */

import { isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import { sendPlanLimitRefusal } from '../planLimitReply';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { runWebSearch } from '@/lib/services/webSearch';
import { listWebSearchCompatRows } from '@/lib/services/webSearch/webSearchInstanceView';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-websearch');

export const clientWebSearchApiPlugin: FastifyPluginAsync = async (app) => {
  // One list behind both paths: the visible instances, then provider rows that have no instance yet (`kind`
  // tells them apart). `providers` is the older name of the same list.
  const listHandler = (logLabel: string, field: 'providers' | 'instances') =>
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const rows = await listWebSearchCompatRows(ctx.tenantDbName, ctx.tenantId, ctx.projectId);
        return reply.code(200).send({
          [field]: rows.map((row) => ({
            key: row.key,
            driver: row.driver,
            label: row.label,
            status: row.status,
            aiAnswer:
              ((row.settings as Record<string, unknown> | undefined)?.aiAnswer as { enabled?: boolean } | undefined)
                ?.enabled === true,
            kind: row.kind,
            ...(row.kind === 'instance' ? { providerKey: row.providerKey } : {}),
          })),
        });
      } catch (error) {
        logger.error(logLabel, { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    });

  app.get('/client/v1/websearch/providers', listHandler('List client websearch providers error', 'providers'));
  app.get('/client/v1/websearch/instances', listHandler('List client websearch instances error', 'instances'));

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
        // The resolver takes an instance key first, then a provider key; `instance` is the name, `provider` the alias.
        providerKey:
          explicitKey
          ?? (typeof body.instance === 'string' && body.instance ? body.instance : undefined)
          ?? (typeof body.provider === 'string' ? body.provider : undefined),
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
        cached: result.cached,
        ...(result.cache
          ? {
            cache: {
              status: result.cache.status,
              ...(result.cache.similarity !== undefined ? { similarity: result.cache.similarity } : {}),
            },
          }
          : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        latency_ms: result.latencyMs,
      });
    } catch (error) {
      const refusal = sendPlanLimitRefusal(reply, error);
      if (refusal) return refusal;
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
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
