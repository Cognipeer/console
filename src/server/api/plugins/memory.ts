import type { FastifyPluginAsync } from 'fastify';
import type { MemoryScope, MemorySource, MemoryStoreStatus } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  addMemory,
  createMemoryStore,
  deleteMemoryItem,
  deleteMemoryItemsBulk,
  deleteMemoryStore,
  getMemoryStore,
  listMemoryItems,
  listMemoryStores,
  recallForChat,
  searchMemories,
  updateMemoryStore,
} from '@/lib/services/memory/memoryService';
import {
  parseCsvQuery,
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:memory');

export const memoryApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/memory/stores', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; status?: MemoryStoreStatus };
      const stores = await listMemoryStores(session.tenantDbName, session.tenantId, projectId, {
        search: query.search,
        status: query.status,
      });

      return reply.code(200).send({ stores });
    } catch (error) {
      logger.error('List memory stores error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.post('/memory/stores', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (
        typeof body.name !== 'string'
        || typeof body.vectorProviderKey !== 'string'
        || typeof body.embeddingModelKey !== 'string'
      ) {
        return reply.code(400).send({
          error: 'name, vectorProviderKey, and embeddingModelKey are required',
        });
      }

      const store = await createMemoryStore(session.tenantDbName, session.tenantId, projectId, {
        config: body.config as Record<string, unknown> | undefined,
        createdBy: session.userId,
        description: body.description as string | undefined,
        embeddingModelKey: body.embeddingModelKey,
        name: body.name,
        vectorProviderKey: body.vectorProviderKey,
      });

      return reply.code(201).send(store);
    } catch (error) {
      logger.error('Create memory store error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/memory/stores/:storeKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const store = await getMemoryStore(session.tenantDbName, session.tenantId, projectId, storeKey);
      return reply.code(200).send(store);
    } catch (error) {
      logger.error('Get memory store error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.patch('/memory/stores/:storeKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const store = await updateMemoryStore(
        session.tenantDbName,
        session.tenantId,
        projectId,
        storeKey,
        {
          ...body,
          updatedBy: session.userId,
        },
      );

      return reply.code(200).send(store);
    } catch (error) {
      logger.error('Update memory store error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/memory/stores/:storeKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      await deleteMemoryStore(session.tenantDbName, session.tenantId, projectId, storeKey);

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete memory store error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.get('/memory/stores/:storeKey/memories', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const query = (request.query ?? {}) as {
        limit?: string;
        page?: string;
        query?: string;
        scope?: MemoryScope;
        scopeId?: string;
      };

      const limit = Number.parseInt(query.limit ?? '20', 10);
      const scope = query.scope;
      const scopeId = query.scopeId;

      if (query.query) {
        const result = await searchMemories(
          session.tenantDbName,
          session.tenantId,
          projectId,
          storeKey,
          {
            query: query.query,
            scope,
            scopeId,
            topK: limit,
          },
        );

        return reply.code(200).send(result);
      }

      const page = Number.parseInt(query.page ?? '1', 10);
      const result = await listMemoryItems(
        session.tenantDbName,
        session.tenantId,
        projectId,
        storeKey,
        {
          limit,
          scope,
          scopeId,
          skip: (page - 1) * limit,
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('List memory items error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.post('/memory/stores/:storeKey/memories', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.content !== 'string' || !body.content.trim()) {
        return reply.code(400).send({ error: 'content is required' });
      }

      const tags = Array.isArray(body.tags)
        ? body.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : parseCsvQuery(typeof body.tags === 'string' ? body.tags : undefined);

      const memory = await addMemory(session.tenantDbName, session.tenantId, projectId, storeKey, {
        content: body.content.trim(),
        importance: typeof body.importance === 'number' ? body.importance : undefined,
        scope: body.scope as MemoryScope | undefined,
        scopeId: typeof body.scopeId === 'string' ? body.scopeId : undefined,
        source: body.source as MemorySource | undefined,
        tags,
      });

      return reply.code(201).send({ memory });
    } catch (error) {
      logger.error('Add memory item error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/memory/stores/:storeKey/memories', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const query = (request.query ?? {}) as {
        scope?: MemoryScope;
        scopeId?: string;
        tags?: string;
      };

      const deleted = await deleteMemoryItemsBulk(session.tenantDbName, session.tenantId, projectId, storeKey, {
        scope: query.scope,
        scopeId: query.scopeId,
        tags: parseCsvQuery(query.tags),
      });

      return reply.code(200).send({ deleted });
    } catch (error) {
      logger.error('Bulk delete memory items error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.delete('/memory/stores/:storeKey/memories/:memoryId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { memoryId, storeKey } = request.params as { memoryId: string; storeKey: string };

      await deleteMemoryItem(session.tenantDbName, session.tenantId, projectId, storeKey, memoryId);

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete memory item error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));

  app.post('/memory/stores/:storeKey/recall', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string' || !body.query.trim()) {
        return reply.code(400).send({ error: 'query is required' });
      }

      const result = await recallForChat(session.tenantDbName, session.tenantId, projectId, storeKey, {
        maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
        query: body.query.trim(),
        scope: body.scope as MemoryScope | undefined,
        scopeId: typeof body.scopeId === 'string' ? body.scopeId : undefined,
        topK: typeof body.topK === 'number' ? body.topK : undefined,
      });

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Recall memories error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal server error',
        });
    }
  }));
};
