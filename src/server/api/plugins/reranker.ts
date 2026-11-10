import { isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  createReranker,
  deleteReranker,
  getRerankerByKey,
  listRerankerRunLogs,
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
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { rowsWithHiddenContent } from '../restrictedKnowledgeRequest';

const logger = createLogger('api:reranker');

export const rerankerApiPlugin: FastifyPluginAsync = async (app) => {
  // ── List ──────────────────────────────────────────────────────────────
  app.get(
    '/reranker',
    withApiRequestContext(async (request, reply) => {
      try {
        const { projectId, session } = await requireProjectContextForRequest(request);
        const query = (request.query ?? {}) as {
          search?: string;
          status?: 'active' | 'disabled';
        };
        const rerankers = await listRerankers(session.tenantDbName, {
          projectId,
          search: query.search,
          status: query.status,
        });
        return reply.code(200).send({ rerankers });
      } catch (error) {
        logger.error('List rerankers error', { error });
        return (
          sendProjectContextError(reply, error)
          ?? reply.code(500).send({
            error: error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    }),
  );

  // ── Create ────────────────────────────────────────────────────────────
  app.post(
    '/reranker',
    withApiRequestContext(async (request, reply) => {
      try {
        const { projectId, session } = await requireProjectContextForRequest(request);
        const body = readJsonBody<Record<string, unknown>>(request);

        const parsed = readRerankerCreateBody(body);
        if (!parsed.ok) {
          return reply.code(parsed.status).send({ error: parsed.error });
        }

        const reranker = await createReranker(
          session.tenantDbName,
          session.tenantId,
          projectId,
          {
            ...parsed.value,
            createdBy: session.userId,
          },
        );
        return reply.code(201).send({ reranker });
      } catch (error) {
        logger.error('Create reranker error', { error });
        return (
          sendProjectContextError(reply, error)
          ?? reply.code(400).send({
            error: error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    }),
  );

  // ── Get ───────────────────────────────────────────────────────────────
  app.get(
    '/reranker/:key',
    withApiRequestContext(async (request, reply) => {
      try {
        const { projectId, session } = await requireProjectContextForRequest(request);
        const { key } = request.params as { key: string };
        const reranker = await getRerankerByKey(session.tenantDbName, key, projectId);
        if (!reranker) return reply.code(404).send({ error: 'Reranker not found' });
        return reply.code(200).send({ reranker });
      } catch (error) {
        logger.error('Get reranker error', { error });
        return (
          sendProjectContextError(reply, error)
          ?? reply.code(500).send({
            error: error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    }),
  );

  // ── Patch ─────────────────────────────────────────────────────────────
  app.patch(
    '/reranker/:key',
    withApiRequestContext(async (request, reply) => {
      try {
        const { projectId, session } = await requireProjectContextForRequest(request);
        const { key } = request.params as { key: string };
        const existing = await getRerankerByKey(session.tenantDbName, key, projectId);
        if (!existing) return reply.code(404).send({ error: 'Reranker not found' });
        const body = readJsonBody<Record<string, unknown>>(request);

        const reranker = await updateReranker(session.tenantDbName, String(existing._id), {
          ...readRerankerPatchBody(body),
          updatedBy: session.userId,
        });
        return reply.code(200).send({ reranker });
      } catch (error) {
        logger.error('Update reranker error', { error });
        return (
          sendProjectContextError(reply, error)
          ?? reply.code(400).send({
            error: error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    }),
  );

  // ── Delete ────────────────────────────────────────────────────────────
  app.delete(
    '/reranker/:key',
    withApiRequestContext(async (request, reply) => {
      try {
        const { projectId, session } = await requireProjectContextForRequest(request);
        const { key } = request.params as { key: string };
        const existing = await getRerankerByKey(session.tenantDbName, key, projectId);
        if (!existing) return reply.code(404).send({ error: 'Reranker not found' });
        await deleteReranker(session.tenantDbName, String(existing._id));
        return reply.code(200).send({ success: true });
      } catch (error) {
        logger.error('Delete reranker error', { error });
        return (
          sendProjectContextError(reply, error)
          ?? reply.code(500).send({
            error: error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    }),
  );

  // ── Run (playground / test) ───────────────────────────────────────────
  app.post(
    '/reranker/:key/run',
    withApiRequestContext(async (request, reply) => {
      try {
        const { projectId, session } = await requireProjectContextForRequest(request);
        const { key } = request.params as { key: string };
        const body = readJsonBody<Record<string, unknown>>(request);

        if (typeof body.query !== 'string' || body.query === '') {
          return reply.code(400).send({ error: '`query` is required.' });
        }

        const documents = normalizeDocuments(body.documents);
        const result = await runReranker(
          session.tenantDbName,
          session.tenantId,
          projectId,
          key,
          {
            query: body.query,
            documents,
            topN: typeof body.topN === 'number' ? body.topN : undefined,
            source: 'dashboard',
          },
        );
        return reply.code(200).send({ result });
      } catch (error) {
        if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
        logger.error('Run reranker error', { error });
        return (
          sendProjectContextError(reply, error)
          ?? reply.code(400).send({
            error: error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    }),
  );

  // ── Run logs ──────────────────────────────────────────────────────────
  app.get(
    '/reranker/:key/runs',
    withApiRequestContext(async (request, reply) => {
      try {
        const { projectId, session } = await requireProjectContextForRequest(request);
        const { key } = request.params as { key: string };
        const query = (request.query ?? {}) as { from?: string; to?: string; limit?: string };
        const logs = await listRerankerRunLogs(session.tenantDbName, key, {
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          limit: query.limit ? Number(query.limit) : 50,
          projectId,
        });
        // A run over passages of knowledge base documents not open to everyone: its numbers, not what was asked.
        const hidden = await rowsWithHiddenContent(
          request,
          { tenantDbName: session.tenantDbName, viewerUserId: session.userId },
          logs,
          (log) => ({ tags: log.metadata?.kbRestricted, askers: [log.userId] }),
        );
        return reply.code(200).send({
          logs: logs.map((log) => (hidden.has(log) ? { ...log, query: '', errorMessage: undefined, restricted: true } : log)),
        });
      } catch (error) {
        logger.error('List reranker run logs error', { error });
        return (
          sendProjectContextError(reply, error)
          ?? reply.code(500).send({
            error: error instanceof Error ? error.message : 'Internal error',
          })
        );
      }
    }),
  );
};
