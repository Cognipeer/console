import { isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import type { FastifyPluginAsync } from 'fastify';
import type { MemorySource } from '@/lib/database';
import type { AddMemoryRequest } from '@/lib/services/memory/types';
import type { MemoryRecallRequest, MemorySearchRequest } from '@/lib/services/memory/types';
import { createLogger } from '@/lib/core/logger';
import {
  addMemory,
  addMemoryBatch,
  createMemoryStore,
  deleteMemoryItem,
  deleteMemoryItemsBulk,
  deleteMemoryStore,
  getMemoryItem,
  getMemoryStore,
  listMemoryItems,
  listMemoryStores,
  MemoryItemNotFoundError,
  MemoryStoreFullError,
  MemoryStoreInputError,
  recallForChat,
  searchMemories,
  updateMemoryItem,
  updateMemoryStore,
} from '@/lib/services/memory/memoryService';
import { parseCreateMemoryStoreBody, parseUpdateMemoryStoreBody } from '@/lib/services/memory/memoryRequest';
import {
  getApiTokenContextForRequest,
  parseCsvQuery,
  readJsonObjectBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import { sendPlanLimitRefusal } from '../planLimitReply';

const logger = createLogger('api:client-memory');

export const clientMemoryApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/memory/stores', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; status?: 'active' | 'inactive' | 'error' };
      const stores = await listMemoryStores(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        search: query.search,
        status: query.status,
      });
      return reply.code(200).send({ stores });
    } catch (error) {
      logger.error('List client memory stores error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/memory/stores', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      const parsed = parseCreateMemoryStoreBody(body);
      if (!parsed.ok) {
        return reply.code(parsed.status).send({ error: parsed.error });
      }

      const store = await createMemoryStore(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        ...parsed.value,
        createdBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      });

      return reply.code(201).send({ store });
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be a JSON object' });
      logger.error('Create client memory store error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/memory/stores/:storeKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const store = await getMemoryStore(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey);
      return reply.code(200).send({ store });
    } catch (error) {
      logger.error('Get client memory store error', { error });
      const message = error instanceof Error ? error.message : 'Internal server error';
      return reply.code(message.includes('not found') ? 404 : 500).send({ error: message });
    }
  }));

  app.patch('/client/v1/memory/stores/:storeKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);
      const store = await updateMemoryStore(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey, {
        ...parseUpdateMemoryStoreBody(body),
        updatedBy: ctx.user?.email ?? ctx.tokenRecord.userId,
      });
      return reply.code(200).send({ store });
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be a JSON object' });
      if (error instanceof MemoryStoreInputError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      logger.error('Update client memory store error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/client/v1/memory/stores/:storeKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      await deleteMemoryStore(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey);
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client memory store error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/memory/stores/:storeKey/memories', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const query = (request.query ?? {}) as {
        limit?: string;
        scope?: 'user' | 'agent' | 'session' | 'global';
        scopeId?: string;
        search?: string;
        skip?: string;
        status?: 'active' | 'archived' | 'expired';
        tags?: string;
      };
      const result = await listMemoryItems(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey, {
        limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
        scope: query.scope,
        scopeId: query.scopeId,
        search: query.search,
        skip: query.skip ? Number.parseInt(query.skip, 10) : undefined,
        status: query.status,
        tags: parseCsvQuery(query.tags),
      });

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('List client memory items error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/memory/stores/:storeKey/memories', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      if (typeof body.content !== 'string') {
        return reply.code(400).send({ error: 'content is required' });
      }

      const memory = await addMemory(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey, {
        content: body.content,
        importance: body.importance as number | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
        scope: body.scope as 'user' | 'agent' | 'session' | 'global' | undefined,
        scopeId: body.scopeId as string | undefined,
        source: body.source as MemorySource | undefined,
        tags: body.tags as string[] | undefined,
      });

      return reply.code(201).send({ memory });
    } catch (error) {
      // A platform vector index past the plan storage answers with the refusal's own status (413).
      const refused = sendPlanLimitRefusal(reply, error);
      if (refused) return refused;
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be a JSON object' });
      if (error instanceof MemoryStoreFullError) {
        return reply.code(409).send({ error: error.message });
      }
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      logger.error('Add client memory item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/client/v1/memory/stores/:storeKey/memories', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const query = (request.query ?? {}) as {
        scope?: 'user' | 'agent' | 'session' | 'global';
        scopeId?: string;
        tags?: string;
      };
      const deleted = await deleteMemoryItemsBulk(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey, {
        scope: query.scope,
        scopeId: query.scopeId,
        tags: parseCsvQuery(query.tags),
      });

      return reply.code(200).send({ deleted });
    } catch (error) {
      logger.error('Bulk delete client memory items error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/memory/stores/:storeKey/memories/batch', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      if (!Array.isArray(body.memories) || body.memories.length === 0) {
        return reply.code(400).send({ error: 'memories array is required' });
      }

      if (body.memories.length > 100) {
        return reply.code(400).send({ error: 'Maximum batch size is 100' });
      }

      for (const memory of body.memories) {
        if (!memory || typeof memory !== 'object' || typeof (memory as { content?: unknown }).content !== 'string') {
          return reply.code(400).send({ error: 'Each memory must have a content field' });
        }
      }

      const result = await addMemoryBatch(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        storeKey,
        body.memories as AddMemoryRequest[],
      );

      return reply.code(201).send(result);
    } catch (error) {
      // A platform vector index past the plan storage answers with the refusal's own status (413).
      const refused = sendPlanLimitRefusal(reply, error);
      if (refused) return refused;
      if (error instanceof MemoryStoreFullError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be a JSON object' });
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      if (error instanceof Error && error.message === 'Memory store not found.') {
        return reply.code(404).send({ error: error.message });
      }
      logger.error('Batch add client memory items error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.get('/client/v1/memory/stores/:storeKey/memories/:memoryId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { memoryId, storeKey } = request.params as { memoryId: string; storeKey: string };
      const item = await getMemoryItem(ctx.tenantDbName, ctx.projectId, storeKey, memoryId);
      return reply.code(200).send(item);
    } catch (error) {
      if (error instanceof MemoryItemNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      logger.error('Get client memory item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.patch('/client/v1/memory/stores/:storeKey/memories/:memoryId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { memoryId, storeKey } = request.params as { memoryId: string; storeKey: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);
      const updates: Record<string, unknown> = {};
      for (const field of ['content', 'metadata', 'tags', 'importance', 'status']) {
        if (body[field] !== undefined) {
          updates[field] = body[field];
        }
      }

      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: 'No valid fields to update' });
      }

      const updated = await updateMemoryItem(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        storeKey,
        memoryId,
        updates,
      );

      return reply.code(200).send(updated);
    } catch (error) {
      // A platform vector index past the plan storage answers with the refusal's own status (413).
      const refused = sendPlanLimitRefusal(reply, error);
      if (refused) return refused;
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be a JSON object' });
      logger.error('Update client memory item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.delete('/client/v1/memory/stores/:storeKey/memories/:memoryId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { memoryId, storeKey } = request.params as { memoryId: string; storeKey: string };
      await deleteMemoryItem(ctx.tenantDbName, ctx.tenantId, ctx.projectId, storeKey, memoryId);
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client memory item error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/memory/stores/:storeKey/search', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string') {
        return reply.code(400).send({ error: 'query is required' });
      }

      const result = await searchMemories(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        storeKey,
        {
          minScore: (body.minScore ?? body.min_score) as number | undefined,
          query: body.query,
          scope: body.scope as MemorySearchRequest['scope'],
          scopeId: (body.scopeId ?? body.scope_id) as string | undefined,
          tags: body.tags as string[] | undefined,
          topK: (body.topK ?? body.top_k ?? 10) as number,
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be a JSON object' });
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      logger.error('Search client memories error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));

  app.post('/client/v1/memory/stores/:storeKey/recall', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { storeKey } = request.params as { storeKey: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string') {
        return reply.code(400).send({ error: 'query is required' });
      }

      const result = await recallForChat(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        storeKey,
        {
          maxTokens: (body.maxTokens ?? body.max_tokens ?? 2000) as number,
          query: body.query,
          scope: body.scope as MemoryRecallRequest['scope'],
          scopeId: (body.scopeId ?? body.scope_id) as string | undefined,
          topK: (body.topK ?? body.top_k ?? 5) as number,
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof SyntaxError) return reply.code(400).send({ error: 'Request body must be a JSON object' });
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      logger.error('Recall client memories error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  }));
};
