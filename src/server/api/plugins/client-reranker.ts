/**
 * Client v1 Reranker plugin.
 *
 * Two surfaces:
 *   - GET  /api/client/v1/rerankers          → list rerankers visible to token
 *   - POST /api/client/v1/rerank/:key        → run a configured reranker
 *
 * Request shape mirrors Cohere's /v2/rerank to make it easy to drop in:
 *   { query, documents: string[] | { text }[], top_n? }
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  getRerankerByKey,
  listRerankers,
  runReranker,
  type RerankerDocumentInput,
} from '@/lib/services/reranker';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-reranker');

function normalizeDocuments(raw: unknown): RerankerDocumentInput[] {
  if (!Array.isArray(raw)) {
    throw new Error('`documents` must be an array.');
  }
  return raw.map((item, idx): RerankerDocumentInput => {
    if (typeof item === 'string') return { content: item };
    if (item && typeof item === 'object') {
      const d = item as Record<string, unknown>;
      const content = typeof d.content === 'string' ? d.content
        : typeof d.text === 'string' ? d.text
          : undefined;
      if (!content) throw new Error(`documents[${idx}]: missing content/text.`);
      return {
        id: typeof d.id === 'string' ? d.id : undefined,
        content,
        score: typeof d.score === 'number' ? d.score : undefined,
        metadata:
          d.metadata && typeof d.metadata === 'object'
            ? (d.metadata as Record<string, unknown>)
            : undefined,
      };
    }
    throw new Error(`documents[${idx}]: must be a string or object with content/text.`);
  });
}

export const clientRerankerApiPlugin: FastifyPluginAsync = async (app) => {
  app.get(
    '/client/v1/rerankers',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const rerankers = await listRerankers(ctx.tenantDbName, {});
        return reply.code(200).send({ rerankers });
      } catch (error) {
        logger.error('List client rerankers error', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    }),
  );

  app.get(
    '/client/v1/rerank/:key',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const { key } = request.params as { key: string };
        const reranker = await getRerankerByKey(ctx.tenantDbName, key);
        if (!reranker) return reply.code(404).send({ error: 'Reranker not found' });
        return reply.code(200).send({ reranker });
      } catch (error) {
        logger.error('Get client reranker error', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    }),
  );

  app.post(
    '/client/v1/rerank/:key',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const { key } = request.params as { key: string };
        const body = readJsonBody<Record<string, unknown>>(request);

        if (typeof body.query !== 'string' || body.query === '') {
          return reply.code(400).send({ error: '`query` is required.' });
        }

        const documents = normalizeDocuments(body.documents);
        const topN =
          typeof body.top_n === 'number'
            ? body.top_n
            : typeof body.topN === 'number'
              ? body.topN
              : undefined;

        const result = await runReranker(
          ctx.tenantDbName,
          ctx.tenantId,
          ctx.projectId,
          key,
          {
            query: body.query,
            documents,
            topN,
            source: 'api',
          },
        );

        // Cohere-compatible response shape
        return reply.code(200).send({
          id: `rerank-${Date.now().toString(36)}`,
          results: result.results.map((r) => ({
            index: r.index,
            relevance_score: r.score,
            document: { text: r.content },
          })),
          meta: {
            api_version: { version: '1' },
            reranker: result.rerankerKey,
            strategy: result.strategy,
            model: result.modelKey,
            latency_ms: result.latencyMs,
          },
        });
      } catch (error) {
        logger.error('Run client reranker error', { error });
        return reply.code(400).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    }),
  );
};
