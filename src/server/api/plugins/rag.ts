import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IRagChunkConfig } from '@/lib/database';
import {
  createRagModule,
  deleteRagDocument,
  deleteRagModule,
  getRagDocument,
  getRagModule,
  ingestDocument,
  ingestFile,
  listRagDocuments,
  listRagModules,
  listRagQueryLogs,
  queryRag,
  reingestDocument,
  updateRagModule,
} from '@/lib/services/rag/ragService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:rag');

function decodeFileData(payload: string): Buffer {
  if (payload.startsWith('data:')) {
    const commaIndex = payload.indexOf(',');
    if (commaIndex !== -1) {
      return Buffer.from(payload.slice(commaIndex + 1), 'base64');
    }
  }

  return Buffer.from(payload, 'base64');
}

export const ragApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/rag/modules', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        search?: string;
        status?: 'active' | 'disabled';
      };
      const modules = await listRagModules(session.tenantDbName, {
        projectId,
        search: query.search,
        status: query.status,
      });

      return reply.code(200).send({ modules });
    } catch (error) {
      logger.error('List RAG modules error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/rag/modules', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (
        typeof body.name !== 'string'
        || typeof body.embeddingModelKey !== 'string'
        || typeof body.vectorProviderKey !== 'string'
        || typeof body.vectorIndexKey !== 'string'
        || !body.chunkConfig
      ) {
        return reply.code(400).send({
          error: 'name, embeddingModelKey, vectorProviderKey, vectorIndexKey, and chunkConfig are required',
        });
      }

      const ragModule = await createRagModule(session.tenantDbName, session.tenantId, projectId, {
        chunkConfig: body.chunkConfig as IRagChunkConfig,
        createdBy: session.userId,
        description: body.description as string | undefined,
        embeddingModelKey: body.embeddingModelKey,
        fileBucketKey: body.fileBucketKey as string | undefined,
        fileProviderKey: body.fileProviderKey as string | undefined,
        key: body.key as string | undefined,
        metadata: body.metadata as Record<string, unknown> | undefined,
        name: body.name,
        vectorIndexKey: body.vectorIndexKey,
        vectorProviderKey: body.vectorProviderKey,
      });

      return reply.code(201).send({ module: ragModule });
    } catch (error) {
      logger.error('Create RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(session.tenantDbName, key, projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      return reply.code(200).send({ module: ragModule });
    } catch (error) {
      logger.error('Get RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/rag/modules/:key', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const existing = await getRagModule(session.tenantDbName, key, projectId);

      if (!existing) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const ragModule = await updateRagModule(session.tenantDbName, String(existing._id), {
        ...body,
        updatedBy: session.userId,
      });

      return reply.code(200).send({ module: ragModule });
    } catch (error) {
      logger.error('Update RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/rag/modules/:key', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const existing = await getRagModule(session.tenantDbName, key, projectId);

      if (!existing) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      await deleteRagModule(session.tenantDbName, String(existing._id));
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/documents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { search?: string };
      const documents = await listRagDocuments(session.tenantDbName, key, {
        projectId,
        search: query.search,
      });

      return reply.code(200).send({ documents });
    } catch (error) {
      logger.error('List RAG documents error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/rag/modules/:key/documents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.fileName !== 'string' || body.fileName === '') {
        return reply.code(400).send({ error: 'fileName is required' });
      }

      if (typeof body.data === 'string') {
        const document = await ingestFile(session.tenantDbName, session.tenantId, projectId, {
          contentType: body.contentType as string | undefined,
          createdBy: session.userId,
          fileData: decodeFileData(body.data),
          fileName: body.fileName,
          metadata: body.metadata as Record<string, unknown> | undefined,
          ragModuleKey: key,
        });

        return reply.code(201).send({ document });
      }

      if (typeof body.content !== 'string' || body.content === '') {
        return reply.code(400).send({
          error: 'Either "content" (text) or "data" (base64 file) is required',
        });
      }

      const document = await ingestDocument(session.tenantDbName, session.tenantId, projectId, {
        content: body.content,
        contentType: body.contentType as string | undefined,
        createdBy: session.userId,
        fileName: body.fileName,
        metadata: body.metadata as Record<string, unknown> | undefined,
        ragModuleKey: key,
      });

      return reply.code(201).send({ document });
    } catch (error) {
      logger.error('Ingest RAG document error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/documents/:documentId', withApiRequestContext(async (request, reply) => {
    try {
      const { documentId } = request.params as { documentId: string; key: string };
      const { session } = await requireProjectContextForRequest(request);
      const document = await getRagDocument(session.tenantDbName, documentId);

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      return reply.code(200).send({ document });
    } catch (error) {
      logger.error('Get RAG document error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/rag/modules/:key/documents/:documentId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { documentId, key } = request.params as { documentId: string; key: string };
      await deleteRagDocument(session.tenantDbName, session.tenantId, projectId, {
        documentId,
        ragModuleKey: key,
      });

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete RAG document error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/rag/modules/:key/documents/:documentId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { documentId, key } = request.params as { documentId: string; key: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const encodedData = typeof body.data === 'string'
        ? body.data
        : (typeof body.base64 === 'string' ? body.base64 : undefined);

      const document = await reingestDocument(session.tenantDbName, session.tenantId, projectId, {
        content: typeof body.content === 'string' ? body.content : undefined,
        contentType: typeof body.contentType === 'string' ? body.contentType : undefined,
        documentId,
        fileData: encodedData ? decodeFileData(encodedData) : undefined,
        fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
        metadata: body.metadata && typeof body.metadata === 'object'
          ? body.metadata as Record<string, unknown>
          : undefined,
        ragModuleKey: key,
        updatedBy: session.userId,
      });

      return reply.code(200).send({ document });
    } catch (error) {
      logger.error('Reingest RAG document error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/rag/modules/:key/query', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string' || body.query === '') {
        return reply.code(400).send({ error: 'query is required' });
      }

      const result = await queryRag(session.tenantDbName, session.tenantId, projectId, {
        filter: body.filter as Record<string, unknown> | undefined,
        query: body.query,
        ragModuleKey: key,
        topK: body.topK as number | undefined,
      });

      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Query RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/usage', withApiRequestContext(async (request, reply) => {
    try {
      const { session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { from?: string; limit?: string; to?: string };
      const logs = await listRagQueryLogs(session.tenantDbName, key, {
        from: query.from ? new Date(query.from) : undefined,
        limit: query.limit ? Number(query.limit) : 50,
        to: query.to ? new Date(query.to) : undefined,
      });

      return reply.code(200).send({ logs });
    } catch (error) {
      logger.error('List RAG query logs error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};
