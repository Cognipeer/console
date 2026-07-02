import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IRerankerConfig, RerankerStrategy } from '@/lib/database';
import {
  createReranker,
  deleteReranker,
  getRerankerByKey,
  listRerankerRunLogs,
  listRerankers,
  runReranker,
  updateReranker,
} from '@/lib/services/reranker';
import type { RerankerDocumentInput } from '@/lib/services/reranker';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:reranker');

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
    if (typeof item === 'string') {
      return { content: item };
    }
    if (item && typeof item === 'object') {
      const d = item as Record<string, unknown>;
      const content = typeof d.content === 'string' ? d.content
        : typeof d.text === 'string' ? d.text
          : undefined;
      if (!content) {
        throw new Error(`documents[${idx}]: missing "content" field.`);
      }
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
    throw new Error(`documents[${idx}]: must be a string or { content }.`);
  });
}

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

        const reranker = await createReranker(
          session.tenantDbName,
          session.tenantId,
          projectId,
          {
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
        const { session } = await requireProjectContextForRequest(request);
        const { key } = request.params as { key: string };
        const query = (request.query ?? {}) as { from?: string; to?: string; limit?: string };
        const logs = await listRerankerRunLogs(session.tenantDbName, key, {
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          limit: query.limit ? Number(query.limit) : 50,
        });
        return reply.code(200).send({ logs });
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
