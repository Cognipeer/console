/**
 * Client v1 Reranker plugin.
 *
 * Surfaces:
 *   - GET    /api/client/v1/rerankers        → list rerankers visible to token
 *   - GET    /api/client/v1/rerank/:key      → fetch a reranker definition
 *   - POST   /api/client/v1/rerank/:key      → run a configured reranker
 *   - POST   /api/client/v1/rerank           → create a reranker definition
 *   - PATCH  /api/client/v1/rerank/:key      → update a reranker definition
 *   - DELETE /api/client/v1/rerank/:key      → delete a reranker definition
 *
 * Authoring lives under `/rerank` (not `/rerankers`) so it is covered by the
 * `/api/client/v1/rerank` RBAC prefix and enforced at `write`.
 *
 * The run request shape mirrors Cohere's /v2/rerank to make it easy to drop in:
 *   { query, documents: string[] | { text }[], top_n? }
 */

import type { FastifyPluginAsync } from 'fastify';
import type { IRerankerConfig, RerankerStrategy } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createReranker,
  deleteReranker,
  getRerankerByKey,
  listRerankers,
  runReranker,
  updateReranker,
  type RerankerDocumentInput,
} from '@/lib/services/reranker';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-reranker');

const ALLOWED_STRATEGIES: RerankerStrategy[] = [
  'dedicated-model',
  'llm-judge',
  'llm-listwise',
  'heuristic',
];

function isStrategy(value: unknown): value is RerankerStrategy {
  return typeof value === 'string' && ALLOWED_STRATEGIES.includes(value as RerankerStrategy);
}

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
        const rerankers = await listRerankers(ctx.tenantDbName, { projectId: ctx.projectId });
        return reply.code(200).send({ rerankers });
      } catch (error) {
        logger.error('List client rerankers error', { error });
        return reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
      }
    }),
  );

  // ── Create a reranker definition ──
  // Registered on the `/rerank` collection (not `/rerankers`) so it is covered
  // by the `/api/client/v1/rerank` RBAC prefix.
  app.post(
    '/client/v1/rerank',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const body = readJsonBody<Record<string, unknown>>(request);

        if (typeof body.name !== 'string' || body.name === '') {
          return reply.code(400).send({ error: '`name` is required.' });
        }
        if (!isStrategy(body.strategy)) {
          return reply.code(400).send({
            error: `\`strategy\` must be one of: ${ALLOWED_STRATEGIES.join(', ')}.`,
          });
        }
        if (!body.config || typeof body.config !== 'object') {
          return reply.code(400).send({ error: '`config` object is required.' });
        }

        const reranker = await createReranker(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
          name: body.name,
          key: typeof body.key === 'string' ? body.key : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          strategy: body.strategy,
          config: body.config as IRerankerConfig,
          status: body.status === 'disabled' ? 'disabled' : 'active',
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : undefined,
          createdBy: ctx.tokenRecord.userId,
        });
        return reply.code(201).send({ reranker });
      } catch (error) {
        logger.error('Create client reranker error', { error });
        return sendApiTokenError(reply, error)
          ?? reply.code(400).send({
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
        const reranker = await getRerankerByKey(ctx.tenantDbName, key, ctx.projectId);
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

  // ── Update a reranker definition (resolve by key, scoped to project) ──
  app.patch(
    '/client/v1/rerank/:key',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const { key } = request.params as { key: string };
        const existing = await getRerankerByKey(ctx.tenantDbName, key, ctx.projectId);
        if (!existing) return reply.code(404).send({ error: 'Reranker not found' });
        const body = readJsonBody<Record<string, unknown>>(request);

        const reranker = await updateReranker(ctx.tenantDbName, String(existing._id), {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          strategy: isStrategy(body.strategy) ? body.strategy : undefined,
          config:
            body.config && typeof body.config === 'object'
              ? (body.config as IRerankerConfig)
              : undefined,
          status: body.status === 'disabled' || body.status === 'active' ? body.status : undefined,
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? (body.metadata as Record<string, unknown>)
              : undefined,
          updatedBy: ctx.tokenRecord.userId,
        });
        if (!reranker) return reply.code(404).send({ error: 'Reranker not found' });
        return reply.code(200).send({ reranker });
      } catch (error) {
        logger.error('Update client reranker error', { error });
        return sendApiTokenError(reply, error)
          ?? reply.code(400).send({
            error: error instanceof Error ? error.message : 'Internal error',
          });
      }
    }),
  );

  // ── Delete a reranker definition (resolve by key, scoped to project) ──
  app.delete(
    '/client/v1/rerank/:key',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const { key } = request.params as { key: string };
        const existing = await getRerankerByKey(ctx.tenantDbName, key, ctx.projectId);
        if (!existing) return reply.code(404).send({ error: 'Reranker not found' });
        const deleted = await deleteReranker(ctx.tenantDbName, String(existing._id));
        if (!deleted) return reply.code(404).send({ error: 'Reranker not found' });
        return reply.code(200).send({ success: true });
      } catch (error) {
        logger.error('Delete client reranker error', { error });
        return sendApiTokenError(reply, error)
          ?? reply.code(500).send({
            error: error instanceof Error ? error.message : 'Internal error',
          });
      }
    }),
  );
};
