import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  deleteRagDocument,
  deleteRagModule,
  getRagDocument,
  getRagModule,
  ingestDocument,
  ingestFile,
  listRagDocuments,
  listRagModules,
  queryRag,
  reingestDocument,
} from '@/lib/services/rag/ragService';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-rag');

function decodeFileData(payload: string): Buffer {
  if (payload.startsWith('data:')) {
    const commaIndex = payload.indexOf(',');
    if (commaIndex !== -1) {
      return Buffer.from(payload.slice(commaIndex + 1), 'base64');
    }
  }

  return Buffer.from(payload, 'base64');
}

export const clientRagApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/rag/modules', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const modules = await listRagModules(ctx.tenantDbName, {});
      return reply.code(200).send({ modules });
    } catch (error) {
      logger.error('List client RAG modules error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/client/v1/rag/modules/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(ctx.tenantDbName, key);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      return reply.code(200).send({ module: ragModule });
    } catch (error) {
      logger.error('Get client RAG module error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.delete('/client/v1/rag/modules/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(ctx.tenantDbName, key);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const deleted = await deleteRagModule(ctx.tenantDbName, String(ragModule._id));
      if (!deleted) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client RAG module error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/client/v1/rag/modules/:key/documents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const documents = await listRagDocuments(ctx.tenantDbName, key, {});
      return reply.code(200).send({ documents });
    } catch (error) {
      logger.error('List client RAG documents error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.post('/client/v1/rag/modules/:key/ingest', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.fileName !== 'string') {
        return reply.code(400).send({ error: 'fileName is required' });
      }

      if (typeof body.data === 'string') {
        const document = await ingestFile(ctx.tenantDbName, ctx.tenantId, undefined, {
          contentType: body.contentType as string | undefined,
          createdBy: ctx.tokenRecord.userId,
          fileData: decodeFileData(body.data),
          fileName: body.fileName,
          metadata: body.metadata as Record<string, unknown> | undefined,
          ragModuleKey: key,
        });

        return reply.code(201).send({ document });
      }

      if (typeof body.content !== 'string') {
        return reply.code(400).send({
          error: 'Either "content" (text) or "data" (base64 file) is required',
        });
      }

      const document = await ingestDocument(ctx.tenantDbName, ctx.tenantId, undefined, {
        content: body.content,
        contentType: body.contentType as string | undefined,
        createdBy: ctx.tokenRecord.userId,
        fileName: body.fileName,
        metadata: body.metadata as Record<string, unknown> | undefined,
        ragModuleKey: key,
      });

      return reply.code(201).send({ document });
    } catch (error) {
      logger.error('Ingest client RAG document error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/client/v1/rag/modules/:key/documents/:documentId', withClientApiRequestContext(async (request, reply) => {
    try {
      const { documentId } = request.params as { documentId: string; key: string };
      const ctx = await getApiTokenContextForRequest(request);
      const document = await getRagDocument(ctx.tenantDbName, documentId);

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      return reply.code(200).send({ document });
    } catch (error) {
      logger.error('Get client RAG document error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.delete('/client/v1/rag/modules/:key/documents/:documentId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { documentId, key } = request.params as { documentId: string; key: string };
      await deleteRagDocument(ctx.tenantDbName, ctx.tenantId, undefined, {
        documentId,
        ragModuleKey: key,
      });
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete client RAG document error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.post('/client/v1/rag/modules/:key/documents/:documentId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { documentId, key } = request.params as { documentId: string; key: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const encodedData = typeof body.data === 'string'
        ? body.data
        : (typeof body.base64 === 'string' ? body.base64 : undefined);
      const document = await reingestDocument(ctx.tenantDbName, ctx.tenantId, undefined, {
        content: typeof body.content === 'string' ? body.content : undefined,
        contentType: typeof body.contentType === 'string' ? body.contentType : undefined,
        documentId,
        fileData: encodedData ? decodeFileData(encodedData) : undefined,
        fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
        metadata: body.metadata && typeof body.metadata === 'object'
          ? body.metadata as Record<string, unknown>
          : undefined,
        ragModuleKey: key,
        updatedBy: ctx.tokenRecord.userId,
      });

      return reply.code(200).send({ document });
    } catch (error) {
      logger.error('Reingest client RAG document error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.post('/client/v1/rag/modules/:key/query', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string') {
        return reply.code(400).send({ error: 'query is required' });
      }

      const result = await queryRag(ctx.tenantDbName, ctx.tenantId, undefined, {
        filter: body.filter as Record<string, unknown> | undefined,
        query: body.query,
        ragModuleKey: key,
        topK: body.topK as number | undefined,
      });

      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Query client RAG module error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
