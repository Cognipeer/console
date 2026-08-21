import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import type { IRagChunkConfig } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import {
  createRagModule,
  deleteRagDocument,
  deleteRagModule,
  getRagModule,
  ingestDocument,
  ingestFile,
  listRagDocuments,
  listRagModules,
  queryRag,
  reingestDocument,
  updateRagModule,
  shapeRagQueryResponse,
} from '@/lib/services/rag/ragService';
import type { CreateRagModuleRequest, UpdateRagModuleRequest } from '@/lib/services/rag/types';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';
// The module write payloads are read by the same code as the dashboard's, so
// the two surfaces cannot drift apart again the way responseDetail did.
import {
  documentInProjectScope,
  readDocumentChunkConfig,
  readRagModuleCreateFields,
  readRagModuleUpdateFields,
  sendInvalidRequest,
  withoutSourceText,
} from './rag';
import { VectorFilterError } from '@/lib/providers';

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
      const modules = await listRagModules(ctx.tenantDbName, { projectId: ctx.projectId });
      return reply.code(200).send({ modules });
    } catch (error) {
      logger.error('List client RAG modules error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  // ── Create a RAG module definition ──
  app.post('/client/v1/rag/modules', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      let fields: Omit<CreateRagModuleRequest, 'createdBy'>;
      try {
        fields = readRagModuleCreateFields(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      const ragModule = await createRagModule(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        ...fields,
        createdBy: ctx.tokenRecord.userId,
      });

      return reply.code(201).send({ module: ragModule });
    } catch (error) {
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Create client RAG module error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/client/v1/rag/modules/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(ctx.tenantDbName, key, ctx.projectId);

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

  // ── Update a RAG module definition (resolve by key, scoped to project) ──
  app.patch('/client/v1/rag/modules/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const existing = await getRagModule(ctx.tenantDbName, key, ctx.projectId);

      if (!existing) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);

      let fields: Omit<UpdateRagModuleRequest, 'updatedBy'>;
      try {
        fields = readRagModuleUpdateFields(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      const ragModule = await updateRagModule(ctx.tenantDbName, String(existing._id), {
        ...fields,
        updatedBy: ctx.tokenRecord.userId,
      });

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }
      return reply.code(200).send({ module: ragModule });
    } catch (error) {
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Update client RAG module error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.delete('/client/v1/rag/modules/:key', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(ctx.tenantDbName, key, ctx.projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const deleted = await deleteRagModule(
        ctx.tenantDbName,
        ctx.tenantId,
        ctx.projectId,
        String(ragModule._id),
      );
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

      let chunkConfig: IRagChunkConfig | undefined;
      try {
        chunkConfig = readDocumentChunkConfig(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      if (typeof body.data === 'string') {
        const document = await ingestFile(ctx.tenantDbName, ctx.tenantId, undefined, {
          chunkConfig,
          contentType: body.contentType as string | undefined,
          createdBy: ctx.tokenRecord.userId,
        force: body.force === true,
          fileData: decodeFileData(body.data),
          fileName: body.fileName,
          metadata: body.metadata as Record<string, unknown> | undefined,
          ragModuleKey: key,
        });

        return reply.code(201).send({ document: withoutSourceText(document) });
      }

      if (typeof body.content !== 'string') {
        return reply.code(400).send({
          error: 'Either "content" (text) or "data" (base64 file) is required',
        });
      }

      const document = await ingestDocument(ctx.tenantDbName, ctx.tenantId, undefined, {
        chunkConfig,
        content: body.content,
        contentType: body.contentType as string | undefined,
        createdBy: ctx.tokenRecord.userId,
        force: body.force === true,
        fileName: body.fileName,
        metadata: body.metadata as Record<string, unknown> | undefined,
        ragModuleKey: key,
      });

      return reply.code(201).send({ document: withoutSourceText(document) });
    } catch (error) {
      logger.error('Ingest client RAG document error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));

  app.get('/client/v1/rag/modules/:key/documents/:documentId', withClientApiRequestContext(async (request, reply) => {
    try {
      const { documentId, key } = request.params as { documentId: string; key: string };
      const ctx = await getApiTokenContextForRequest(request);
      const document = await documentInProjectScope(
        ctx.tenantDbName,
        documentId,
        key,
        ctx.projectId,
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      return reply.code(200).send({ document: withoutSourceText(document) });
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
      // The id alone identified nothing: deleteRagDocument never bound the
      // document to the module in the URL, so any token could delete another
      // project's document — and decrement the wrong module's counters doing it.
      const document = await documentInProjectScope(
        ctx.tenantDbName,
        documentId,
        key,
        ctx.projectId,
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }

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
      const existing = await documentInProjectScope(
        ctx.tenantDbName,
        documentId,
        key,
        ctx.projectId,
      );

      if (!existing) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      const body = readJsonBody<Record<string, unknown>>(request);
      const encodedData = typeof body.data === 'string'
        ? body.data
        : (typeof body.base64 === 'string' ? body.base64 : undefined);

      let chunkConfig: IRagChunkConfig | undefined;
      try {
        chunkConfig = readDocumentChunkConfig(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      const document = await reingestDocument(ctx.tenantDbName, ctx.tenantId, undefined, {
        chunkConfig,
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

      return reply.code(200).send({ document: withoutSourceText(document) });
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
        minScore: typeof body.minScore === 'number' ? body.minScore : undefined,
      });

      return reply.code(200).send({ result: shapeRagQueryResponse(result) });
    } catch (error) {
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Query client RAG module error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
