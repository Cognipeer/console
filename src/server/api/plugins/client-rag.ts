import { isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync } from 'fastify';
import type { IRagChunkConfig } from '@/lib/database';
import type { OcrSettings } from '@/lib/services/extraction';
import { createLogger } from '@/lib/core/logger';
import {
  createRagModule,
  deleteRagDocument,
  deleteRagModule,
  getRagDocumentFullText,
  getRagDocumentTextLines,
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
import { clientGone } from '../clientGone';
import { RagDocumentGoneError, RagModuleInactiveError, RagOcrIncompleteError, RagOriginalMissingError, RagReextractIncompleteError, RagStoredTextUnavailableError } from '@/lib/services/rag/errors';
import type { CreateRagModuleRequest, UpdateRagModuleRequest } from '@/lib/services/rag/types';
import {
  getApiTokenContextForRequest,
  readJsonObjectBody,
  withClientApiRequestContext,
} from '../fastify-utils';
import { sendRouteError } from '../routeErrors';
// The module write payloads are read by the same code as the dashboard's, so
// the two surfaces cannot drift apart again the way responseDetail did.
import {
  documentHiddenFor,
  documentInProjectScope,
  moduleAsCallerSees,
  readDocumentChunkConfig,
  readDocumentPlacement,
  readRagModuleCreateFields,
  readRagModuleUpdateFields,
  refuseAccessChange,
  sendInvalidRequest,
  withoutSourceText,
} from './rag';
import { ragAccessForRequest, sendBadBody, sendRagAccessError } from '../ragAccessRequest';
import { kbIndexShareRefusal } from '../ragOwnedResources';
import { ocrModelProblem, readDocumentExtraction } from '../ragExtraction';
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
      const where = { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId };
      return reply.code(200).send({
        modules: await Promise.all(modules.map((ragModule) => moduleAsCallerSees(request, where, ragModule))),
      });
    } catch (error) {
      return sendRouteError(reply, error, { logger, log: 'List client RAG modules error' });
    }
  }));

  // ── Create a RAG module definition ──
  app.post('/client/v1/rag/modules', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      let fields: Omit<CreateRagModuleRequest, 'createdBy'>;
      try {
        fields = readRagModuleCreateFields(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }
      // A knowledge base on the index of one with access control would read its vectors unchecked.
      const refusal = await kbIndexShareRefusal(
        request,
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { providerKey: fields.vectorProviderKey, indexKey: fields.vectorIndexKey },
      );
      if (refusal) return reply.code(403).send(refusal);
      const modelProblem = await ocrModelProblem(ctx, fields.extraction?.ocr);
      if (modelProblem) return reply.code(400).send({ error: modelProblem });

      const ragModule = await createRagModule(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        ...fields,
        createdBy: ctx.tokenRecord.userId,
      });

      return reply.code(201).send({ module: ragModule });
    } catch (error) {
      const badBody = sendBadBody(reply, error);
      if (badBody) return badBody;
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      return sendRouteError(reply, error, { logger, log: 'Create client RAG module error' });
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

      return reply.code(200).send({
        module: await moduleAsCallerSees(
          request,
          { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
          ragModule,
        ),
      });
    } catch (error) {
      return sendRouteError(reply, error, { logger, log: 'Get client RAG module error' });
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

      const body = readJsonObjectBody<Record<string, unknown>>(request);

      let fields: Omit<UpdateRagModuleRequest, 'updatedBy'>;
      try {
        fields = readRagModuleUpdateFields(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }
      if (fields.access !== undefined) {
        if (await refuseAccessChange(request, reply)) return reply;
      }
      // Moving the module onto an index of a knowledge base with access control is refused; leaving it where it is is not.
      const where = { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId };
      const refusal = await kbIndexShareRefusal(
        request,
        where,
        {
          providerKey: fields.vectorProviderKey ?? existing.vectorProviderKey,
          indexKey: fields.vectorIndexKey ?? existing.vectorIndexKey,
        },
        { providerKey: existing.vectorProviderKey, indexKey: existing.vectorIndexKey },
      );
      if (refusal) return reply.code(403).send(refusal);
      const modelProblem = await ocrModelProblem(ctx, fields.extraction?.ocr);
      if (modelProblem) return reply.code(400).send({ error: modelProblem });

      const ragModule = await updateRagModule(ctx.tenantDbName, String(existing._id), {
        ...fields,
        updatedBy: ctx.tokenRecord.userId,
      });

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }
      return reply.code(200).send({ module: await moduleAsCallerSees(request, where, ragModule) });
    } catch (error) {
      const badBody = sendBadBody(reply, error);
      if (badBody) return badBody;
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      return sendRouteError(reply, error, { logger, log: 'Update client RAG module error' });
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
      return sendRouteError(reply, error, { logger, log: 'Delete client RAG module error' });
    }
  }));

  app.get('/client/v1/rag/modules/:key/documents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      // With access control on, a client lists only the documents its caller may read.
      const { scope } = await ragAccessForRequest(request, {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      });
      const access = scope?.managementFilter();
      const documents = await listRagDocuments(ctx.tenantDbName, key, {
        projectId: ctx.projectId,
        ...(access ? { access } : {}),
      });
      return reply.code(200).send({ documents });
    } catch (error) {
      return sendRouteError(reply, error, { logger, log: 'List client RAG documents error' });
    }
  }));

  app.post('/client/v1/rag/modules/:key/ingest', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      if (typeof body.fileName !== 'string') {
        return reply.code(400).send({ error: 'fileName is required' });
      }

      let chunkConfig: IRagChunkConfig | undefined;
      let extraction: { ocr?: OcrSettings | null } | undefined;
      try {
        chunkConfig = readDocumentChunkConfig(body);
        extraction = readDocumentExtraction(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      // Opt-in: chunking and embedding move to the ingest queue and the call
      // returns as soon as the document is persisted. Kept opt-in because the
      // default response contract — 201 with an `indexed` document — is what
      // existing clients read `chunkCount` from and query straight afterwards.
      const deferIndexing = body.async === true;
      const statusCode = deferIndexing ? 202 : 201;

      const { module: ragModule, scope } = await ragAccessForRequest(request, {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      });
      if (!ragModule) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      const { placement, refused } = await readDocumentPlacement(request, reply, body, scope);
      if (refused) return refused;

      if (typeof body.data === 'string') {
        const modelProblem = await ocrModelProblem(ctx, extraction?.ocr);
        if (modelProblem) return reply.code(400).send({ error: modelProblem });

        // `async: true` defers the extraction of a scanned file to the ingest queue as well as the indexing.
        const document = await ingestFile(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
          chunkConfig,
          ...(extraction ? { extraction } : {}),
          signal: clientGone(reply),
          contentType: body.contentType as string | undefined,
          createdBy: ctx.tokenRecord.userId,
        force: body.force === true,
          deferIndexing,
          fileData: decodeFileData(body.data),
          fileName: body.fileName,
          metadata: body.metadata as Record<string, unknown> | undefined,
          ragModuleKey: key,
          ...(scope ? { access: scope } : {}),
          ...(placement ? { placement } : {}),
        });

        return reply.code(statusCode).send({ document: withoutSourceText(document) });
      }

      if (typeof body.content !== 'string') {
        return reply.code(400).send({
          error: 'Either "content" (text) or "data" (base64 file) is required',
        });
      }

      const document = await ingestDocument(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        chunkConfig,
        content: body.content,
        contentType: body.contentType as string | undefined,
        createdBy: ctx.tokenRecord.userId,
        deferIndexing,
        force: body.force === true,
        fileName: body.fileName,
        metadata: body.metadata as Record<string, unknown> | undefined,
        ragModuleKey: key,
        ...(scope ? { access: scope } : {}),
        ...(placement ? { placement } : {}),
      });

      return reply.code(statusCode).send({ document: withoutSourceText(document) });
    } catch (error) {
      const badBody = sendBadBody(reply, error);
      if (badBody) return badBody;
      if (error instanceof RagModuleInactiveError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof RagOcrIncompleteError) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
      const accessRefusal = sendRagAccessError(reply, error);
      if (accessRefusal) return accessRefusal;
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      return sendRouteError(reply, error, { logger, log: 'Ingest client RAG document error' });
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
      if (await documentHiddenFor(request, {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      }, document, 'manage')) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      return reply.code(200).send({ document: withoutSourceText(document) });
    } catch (error) {
      return sendRouteError(reply, error, { logger, log: 'Get client RAG document error' });
    }
  }));

  app.get('/client/v1/rag/modules/:key/documents/:documentId/content', withClientApiRequestContext(async (request, reply) => {
    try {
      const { documentId, key } = request.params as { documentId: string; key: string };
      const ctx = await getApiTokenContextForRequest(request);
      const document = await documentInProjectScope(ctx.tenantDbName, documentId, key, ctx.projectId);

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (await documentHiddenFor(request, {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      }, document, 'retrieve')) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      const result = await getRagDocumentFullText(ctx.tenantDbName, ctx.tenantId, ctx.projectId, document);
      if (!result) {
        return reply.code(404).send({ error: 'Source text is not available for this document; re-ingest it first' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      return sendRouteError(reply, error, { logger, log: 'Get client RAG document full text error' });
    }
  }));

  app.get('/client/v1/rag/modules/:key/documents/:documentId/lines', withClientApiRequestContext(async (request, reply) => {
    try {
      const { documentId, key } = request.params as { documentId: string; key: string };
      const ctx = await getApiTokenContextForRequest(request);
      const document = await documentInProjectScope(ctx.tenantDbName, documentId, key, ctx.projectId);

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (await documentHiddenFor(request, {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      }, document, 'retrieve')) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      const query = (request.query ?? {}) as { offset?: string; limit?: string };
      const result = await getRagDocumentTextLines(ctx.tenantDbName, ctx.tenantId, ctx.projectId, document, {
        offset: query.offset !== undefined ? Number(query.offset) : undefined,
        limit: query.limit !== undefined ? Number(query.limit) : undefined,
      });
      if (!result) {
        return reply.code(404).send({ error: 'Source text is not available for this document; re-ingest it first' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      return sendRouteError(reply, error, { logger, log: 'Get client RAG document lines error' });
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
      if (await documentHiddenFor(request, {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      }, document, 'manage')) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      await deleteRagDocument(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        documentId,
        ragModuleKey: key,
      });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return sendRouteError(reply, error, { logger, log: 'Delete client RAG document error' });
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
      const accessInput = {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      };
      if (await documentHiddenFor(request, accessInput, existing, 'manage')) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      const { scope } = await ragAccessForRequest(request, accessInput);

      const body = readJsonObjectBody<Record<string, unknown>>(request);
      const { placement, refused } = await readDocumentPlacement(request, reply, body, scope);
      if (refused) return refused;
      const encodedData = typeof body.data === 'string'
        ? body.data
        : (typeof body.base64 === 'string' ? body.base64 : undefined);

      let chunkConfig: IRagChunkConfig | undefined;
      try {
        chunkConfig = readDocumentChunkConfig(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      const document = await reingestDocument(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        chunkConfig,
        ...(body.reextract === true ? { reextract: true } : {}),
        content: typeof body.content === 'string' ? body.content : undefined,
        contentType: typeof body.contentType === 'string' ? body.contentType : undefined,
        documentId,
        fileData: encodedData ? decodeFileData(encodedData) : undefined,
        fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
        metadata: body.metadata && typeof body.metadata === 'object'
          ? body.metadata as Record<string, unknown>
          : undefined,
        ragModuleKey: key,
        ...(placement ? { placement } : {}),
        updatedBy: ctx.tokenRecord.userId,
      });

      return reply.code(200).send({ document: withoutSourceText(document) });
    } catch (error) {
      const badBody = sendBadBody(reply, error);
      if (badBody) return badBody;
      if (
        error instanceof RagModuleInactiveError
        || error instanceof RagOriginalMissingError
        || error instanceof RagStoredTextUnavailableError
        || error instanceof RagReextractIncompleteError
        || error instanceof RagDocumentGoneError
      ) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      const accessRefusal = sendRagAccessError(reply, error);
      if (accessRefusal) return accessRefusal;
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      return sendRouteError(reply, error, { logger, log: 'Reingest client RAG document error' });
    }
  }));

  app.post('/client/v1/rag/modules/:key/query', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonObjectBody<Record<string, unknown>>(request);

      if (typeof body.query !== 'string') {
        return reply.code(400).send({ error: 'query is required' });
      }

      const { module: ragModule, scope, caller } = await ragAccessForRequest(request, {
        tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId, ragModuleKey: key,
      });
      if (!ragModule) return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      const result = await queryRag(ctx.tenantDbName, ctx.tenantId, ctx.projectId, {
        filter: body.filter as Record<string, unknown> | undefined,
        query: body.query,
        ragModuleKey: key,
        topK: body.topK as number | undefined,
        minScore: typeof body.minScore === 'number' ? body.minScore : undefined,
      }, { caller, ...(scope ? { access: scope } : {}) });

      return reply.code(200).send({ result: shapeRagQueryResponse(result) });
    } catch (error) {
      const badBody = sendBadBody(reply, error);
      if (badBody) return badBody;
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof RagModuleInactiveError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      return sendRouteError(reply, error, { logger, log: 'Query client RAG module error' });
    }
  }));
};
