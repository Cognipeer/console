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
 * `/rerankers` and `/rerank` each have their own RBAC route-prefix entry
 * (they don't share a path separator, so one prefix cannot cover both) —
 * both map to the `reranker` service in `src/lib/security/rbac.ts`.
 *
 * The run request shape mirrors Cohere's /v2/rerank to make it easy to drop in:
 *   { query, documents: string[] | { text }[], top_n? }
 */

import { isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  createReranker,
  deleteReranker,
  getRerankerByKey,
  listRerankers,
  runReranker,
  updateReranker,
} from '@/lib/services/reranker';
import {
  normalizeDocuments,
  readCreateBody as readRerankerCreateBody,
  readPatchBody as readRerankerPatchBody,
} from '@/lib/services/reranker/requestParsing';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-reranker');

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
  app.post(
    '/client/v1/rerank',
    withClientApiRequestContext(async (request, reply) => {
      try {
        const ctx = await getApiTokenContextForRequest(request);
        const body = readJsonBody<Record<string, unknown>>(request);

        const parsed = readRerankerCreateBody(body);
        if (!parsed.ok) {
          return reply.code(parsed.status).send({ error: parsed.error });
        }

        const reranker = await createReranker(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
          ...parsed.value,
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
        if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
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
          ...readRerankerPatchBody(body),
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
