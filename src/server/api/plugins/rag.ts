import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { paginationMeta, readPagination } from '@/lib/api/pagination';
import type { IRagChunkConfig, IRagDocument, IRagModule, IUser } from '@/lib/database';
import {
  aggregateRagQueryScoreDistribution,
  countRagQueryLogs,
  createRagModule,
  deleteRagDocument,
  deleteRagModule,
  getRagDocument,
  getRagModule,
  ingestDocument,
  ingestFile,
  countRagDocuments,
  listRagDocuments,
  listRagModules,
  listRagQueryLogs,
  queryRag,
  reingestDocument,
  updateRagModule,
  shapeRagQueryResponse,
} from '@/lib/services/rag/ragService';
import type { CreateRagModuleRequest, UpdateRagModuleRequest } from '@/lib/services/rag/types';
import { validateChunkConfig } from '@/lib/services/rag/chunking';
import {
  cancelRagReindex,
  getRagReindexRun,
  listRagReindexRuns,
  startRagReindex,
} from '@/lib/services/rag/ragReindexService';
import { answerWithRag, type RagAnswerRequest } from '@/lib/services/rag/ragAnswerService';
import {
  readJsonBody,
  requireProjectContextForRequest,
  safeReadJsonBody,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { VectorFilterError } from '@/lib/providers';

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

/* ── Module write payloads ───────────────────────────────────────────── */

/**
 * Both HTTP surfaces share these readers instead of each hand-rolling its own
 * field list. While they did, the two drifted: the client create silently
 * dropped `responseDetail`, and neither validated `chunkConfig` at all — an
 * overlap at or above the chunk size reached the token splitter and spun it.
 */

type FieldReader<T> = (value: unknown, field: string) => T;

const asString: FieldReader<string> = (value, field) => {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
};

const asNumber: FieldReader<number> = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
};

const asBoolean: FieldReader<boolean> = (value, field) => {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
};

const asPlainObject: FieldReader<Record<string, unknown>> = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
};

const asStringArray: FieldReader<string[]> = (value, field) => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
};

const asStatus: FieldReader<'active' | 'disabled'> = (value, field) => {
  if (value === 'active' || value === 'disabled') return value;
  throw new Error(`${field} must be "active" or "disabled"`);
};

const asResponseDetail: FieldReader<'full' | 'text'> = (value, field) => {
  if (value === 'full' || value === 'text') return value;
  throw new Error(`${field} must be "full" or "text"`);
};

const asHybridMode: FieldReader<'rrf' | 'weighted'> = (value, field) => {
  if (value === 'rrf' || value === 'weighted') return value;
  throw new Error(`${field} must be "rrf" or "weighted"`);
};

const asChunkConfig: FieldReader<IRagChunkConfig> = (value, field) => validateChunkConfig(value, field);

const asHybrid: FieldReader<NonNullable<IRagModule['hybrid']>> = (value, field) => {
  const hybrid = asPlainObject(value, field);
  const alpha = hybrid.alpha === undefined ? undefined : asNumber(hybrid.alpha, `${field}.alpha`);
  if (alpha !== undefined && (alpha < 0 || alpha > 1)) {
    throw new Error(`${field}.alpha must be between 0 and 1`);
  }
  const k = hybrid.k === undefined ? undefined : asNumber(hybrid.k, `${field}.k`);
  if (k !== undefined && k < 1) {
    throw new Error(`${field}.k must be at least 1`);
  }
  return {
    enabled: asBoolean(hybrid.enabled, `${field}.enabled`),
    mode: hybrid.mode === undefined ? undefined : asHybridMode(hybrid.mode, `${field}.mode`),
    alpha,
    k,
  };
};

/** Kept verbatim: the client API has answered with this string since launch. */
const REQUIRED_MODULE_FIELDS_MESSAGE =
  'name, embeddingModelKey, vectorProviderKey, vectorIndexKey, and chunkConfig are required';

function requiredModuleField<T>(body: Record<string, unknown>, field: string, read: FieldReader<T>): T {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    throw new Error(REQUIRED_MODULE_FIELDS_MESSAGE);
  }
  return read(value, field);
}

function optional<T>(body: Record<string, unknown>, field: string, read: FieldReader<T>): T | undefined {
  const value = body[field];
  return value === undefined ? undefined : read(value, field);
}

/** `null` clears the stored value; `undefined` leaves it untouched. */
function clearable<T>(
  body: Record<string, unknown>,
  field: string,
  read: FieldReader<T>,
): T | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  return read(value, field);
}

export function readRagModuleCreateFields(
  body: Record<string, unknown>,
): Omit<CreateRagModuleRequest, 'createdBy'> {
  return {
    name: requiredModuleField(body, 'name', asString),
    key: optional(body, 'key', asString),
    description: optional(body, 'description', asString),
    embeddingModelKey: requiredModuleField(body, 'embeddingModelKey', asString),
    vectorProviderKey: requiredModuleField(body, 'vectorProviderKey', asString),
    vectorIndexKey: requiredModuleField(body, 'vectorIndexKey', asString),
    fileBucketKey: optional(body, 'fileBucketKey', asString),
    fileProviderKey: optional(body, 'fileProviderKey', asString),
    chunkConfig: requiredModuleField(body, 'chunkConfig', asChunkConfig),
    rerankerKey: optional(body, 'rerankerKey', asString),
    rerankerOversample: optional(body, 'rerankerOversample', asNumber),
    defaultTopK: optional(body, 'defaultTopK', asNumber),
    defaultMinScore: optional(body, 'defaultMinScore', asNumber),
    defaultFilter: optional(body, 'defaultFilter', asPlainObject),
    filterableFields: optional(body, 'filterableFields', asStringArray),
    responseDetail: optional(body, 'responseDetail', asResponseDetail),
    hybrid: optional(body, 'hybrid', asHybrid),
    isolateByModule: optional(body, 'isolateByModule', asBoolean),
    metadata: optional(body, 'metadata', asPlainObject),
  };
}

/**
 * PATCH used to forward the raw body, so anything the service happened to
 * recognise later — including fields that identify the row — would have been
 * writable. Whitelisting mirrors what create accepts.
 *
 * Every field is `optional` or `clearable` on purpose, because the service
 * reads `undefined` as "leave this alone" and `null` as "clear it", and a
 * field whose reader disagrees with that is either unclearable or silently
 * wipeable:
 *  - name, embeddingModelKey, vectorProviderKey, vectorIndexKey, chunkConfig
 *    and status identify or configure the module and have no cleared state, so
 *    `null` is a bad request rather than an instruction.
 *  - metadata's empty value is `{}`, so it needs no null either.
 *  - everything else is a genuinely optional setting the edit form clears by
 *    sending `null`.
 */
export function readRagModuleUpdateFields(
  body: Record<string, unknown>,
): Omit<UpdateRagModuleRequest, 'updatedBy'> {
  // Free text, cleared by the edit form with an explicit `null` — which used to
  // fail the whole PATCH. It lands as '' rather than null because the stored
  // type is `string`: '' is what create already writes for an empty
  // description, and it round-trips identically on both DB backends.
  const description = clearable(body, 'description', asString);

  return {
    name: optional(body, 'name', asString),
    description: description === null ? '' : description,
    embeddingModelKey: optional(body, 'embeddingModelKey', asString),
    vectorProviderKey: optional(body, 'vectorProviderKey', asString),
    vectorIndexKey: optional(body, 'vectorIndexKey', asString),
    chunkConfig: optional(body, 'chunkConfig', asChunkConfig),
    status: optional(body, 'status', asStatus),
    rerankerKey: clearable(body, 'rerankerKey', asString),
    rerankerOversample: clearable(body, 'rerankerOversample', asNumber),
    defaultTopK: clearable(body, 'defaultTopK', asNumber),
    defaultMinScore: clearable(body, 'defaultMinScore', asNumber),
    defaultFilter: clearable(body, 'defaultFilter', asPlainObject),
    filterableFields: clearable(body, 'filterableFields', asStringArray),
    responseDetail: clearable(body, 'responseDetail', asResponseDetail),
    hybrid: clearable(body, 'hybrid', asHybrid),
    isolateByModule: clearable(body, 'isolateByModule', asBoolean),
    metadata: optional(body, 'metadata', asPlainObject),
  };
}

/** Per-document chunk override, held to exactly the module's rules. */
export function readDocumentChunkConfig(
  body: Record<string, unknown>,
): IRagChunkConfig | undefined {
  return optional(body, 'chunkConfig', asChunkConfig);
}

export function sendInvalidRequest(reply: FastifyReply, error: unknown) {
  return reply.code(400).send({
    error: error instanceof Error ? error.message : 'Invalid request body',
  });
}

/**
 * Resolve a document by id within the caller's project and module scope.
 *
 * getRagDocument is scoped only by the tenant DB, and the :key segment never
 * bound the document to the module it names, so without this an ordinary
 * member could read, re-ingest or delete another project's ingested document
 * by its id alone. Returns null for an out-of-scope id so it is
 * indistinguishable from a missing one, and documents stored without a
 * projectId — legacy rows predating project stamping, plus everything the
 * client API ingests — stay reachable.
 *
 * `allowTenantWide` is the reach resolveProjectContext already grants an
 * owner/admin on the dashboard. An API token never gets it: its project is
 * fixed by the token, not by whoever is holding it.
 */
export async function documentInProjectScope(
  tenantDbName: string,
  documentId: string,
  ragModuleKey: string,
  projectId: string,
  options?: { allowTenantWide?: boolean },
): Promise<IRagDocument | null> {
  const document = await getRagDocument(tenantDbName, documentId);
  if (!document) return null;
  if (document.ragModuleKey !== ragModuleKey) return null;
  if (options?.allowTenantWide) return document;
  if (!document.projectId) return document;
  return String(document.projectId) === String(projectId) ? document : null;
}

/** The two roles resolveProjectContext lets act across every project. */
function hasTenantWideReach(user: Pick<IUser, 'role'>): boolean {
  return user.role === 'owner' || user.role === 'admin';
}

/**
 * A document record carries the extracted source text so a re-index never has
 * to rebuild it from overlapping chunks. That is up to INLINE_SOURCE_MAX_CHARS
 * of text — never something to put on the wire.
 *
 * The service strips it from the documents it builds, but applying it at the
 * HTTP boundary too is what makes "no route answers with sourceText" checkable
 * by reading the routes alone.
 */
export function withoutSourceText(document: IRagDocument): Omit<IRagDocument, 'sourceText'> {
  const { sourceText: _sourceText, ...rest } = document;
  return rest;
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

      let fields: Omit<CreateRagModuleRequest, 'createdBy'>;
      try {
        fields = readRagModuleCreateFields(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      const ragModule = await createRagModule(session.tenantDbName, session.tenantId, projectId, {
        ...fields,
        createdBy: session.userId,
      });

      return reply.code(201).send({ module: ragModule });
    } catch (error) {
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
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

      let fields: Omit<UpdateRagModuleRequest, 'updatedBy'>;
      try {
        fields = readRagModuleUpdateFields(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      const ragModule = await updateRagModule(session.tenantDbName, String(existing._id), {
        ...fields,
        updatedBy: session.userId,
      });

      return reply.code(200).send({ module: ragModule });
    } catch (error) {
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
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

      await deleteRagModule(session.tenantDbName, session.tenantId, projectId, String(existing._id));
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
      // Each row carries its source text, so an unpaged list of a large
      // module's corpus is megabytes of response and heap.
      const page = readPagination(request.query);
      const [documents, total] = await Promise.all([
        listRagDocuments(session.tenantDbName, key, {
          projectId,
          search: query.search,
          ...page,
        }),
        countRagDocuments(session.tenantDbName, key, {
          projectId,
          search: query.search,
        }),
      ]);

      return reply.code(200).send({
        documents,
        pagination: paginationMeta(page, { total }),
      });
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

      let chunkConfig: IRagChunkConfig | undefined;
      try {
        chunkConfig = readDocumentChunkConfig(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      if (typeof body.data === 'string') {
        const document = await ingestFile(session.tenantDbName, session.tenantId, projectId, {
          chunkConfig,
          contentType: body.contentType as string | undefined,
          createdBy: session.userId,
          fileData: decodeFileData(body.data),
          force: body.force === true,
          fileName: body.fileName,
          metadata: body.metadata as Record<string, unknown> | undefined,
          ragModuleKey: key,
        });

        return reply.code(201).send({ document: withoutSourceText(document) });
      }

      if (typeof body.content !== 'string' || body.content === '') {
        return reply.code(400).send({
          error: 'Either "content" (text) or "data" (base64 file) is required',
        });
      }

      const document = await ingestDocument(session.tenantDbName, session.tenantId, projectId, {
        chunkConfig,
        content: body.content,
        contentType: body.contentType as string | undefined,
        createdBy: session.userId,
        force: body.force === true,
        fileName: body.fileName,
        metadata: body.metadata as Record<string, unknown> | undefined,
        ragModuleKey: key,
      });

      return reply.code(201).send({ document: withoutSourceText(document) });
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
      const { documentId, key } = request.params as { documentId: string; key: string };
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const document = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
        { allowTenantWide: hasTenantWideReach(user) },
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      return reply.code(200).send({ document: withoutSourceText(document) });
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
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { documentId, key } = request.params as { documentId: string; key: string };
      const document = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
        { allowTenantWide: hasTenantWideReach(user) },
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }

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
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { documentId, key } = request.params as { documentId: string; key: string };
      const existing = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
        { allowTenantWide: hasTenantWideReach(user) },
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

      const document = await reingestDocument(session.tenantDbName, session.tenantId, projectId, {
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
        updatedBy: session.userId,
      });

      return reply.code(200).send({ document: withoutSourceText(document) });
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
        minScore: typeof body.minScore === 'number' ? body.minScore : undefined,
      });

      return reply.code(200).send({ result: shapeRagQueryResponse(result) });
    } catch (error) {
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Query RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  // Q&A: retrieve relevant chunks and synthesize a grounded, cited answer.
  app.post('/rag/modules/:key/answer', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.question !== 'string' || body.question === '') {
        return reply.code(400).send({ error: 'question is required' });
      }
      if (typeof body.answerModelKey !== 'string' || body.answerModelKey === '') {
        return reply.code(400).send({ error: 'answerModelKey is required' });
      }

      const result = await answerWithRag(session.tenantDbName, session.tenantId, projectId, {
        ragModuleKey: key,
        question: body.question,
        answerModelKey: body.answerModelKey,
        history: body.history as RagAnswerRequest['history'],
        topK: body.topK as number | undefined,
        retrieval: body.retrieval as RagAnswerRequest['retrieval'],
        generation: body.generation as RagAnswerRequest['generation'],
      });

      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Answer RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/usage', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(session.tenantDbName, key, projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const query = (request.query ?? {}) as { from?: string; limit?: string; to?: string };
      const from = query.from ? new Date(query.from) : undefined;
      const to = query.to ? new Date(query.to) : undefined;

      // `logs` is a page (default 50, newest-first) for the History table;
      // the counters are true aggregates over the full matched set — the
      // Overview KPIs must not silently cap at the page size.
      //
      // Both are narrowed by project as well as by key: module keys are unique
      // per project only, so a same-key module elsewhere in the tenant would
      // otherwise fold its rows — end-user query text included — into these.
      const [logs, totals] = await Promise.all([
        listRagQueryLogs(session.tenantDbName, key, {
          from,
          limit: query.limit ? Number(query.limit) : 50,
          projectId,
          to,
        }),
        countRagQueryLogs(session.tenantDbName, key, { from, projectId, to }),
      ]);

      return reply.code(200).send({
        avgLatencyMs: totals.avgLatencyMs,
        logs,
        minScoreFilteredCount: totals.minScoreFilteredCount,
        total: totals.total,
        zeroMatchCount: totals.zeroMatchCount,
      });
    } catch (error) {
      logger.error('List RAG query logs error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  /**
   * The query feed behind the zero-result panel. `zeroOnly=true` narrows it to
   * the misses — the content gaps worth writing a document for — while the
   * unfiltered feed is what the panel shows beside them for contrast.
   */
  app.get('/rag/modules/:key/queries', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(session.tenantDbName, key, projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const query = (request.query ?? {}) as {
        from?: string;
        limit?: string;
        skip?: string;
        to?: string;
        zeroOnly?: string;
      };

      // Project-scoped for the same reason as /usage: this feed shows the
      // verbatim query text, and the key alone does not identify one module.
      const logs = await listRagQueryLogs(session.tenantDbName, key, {
        from: query.from ? new Date(query.from) : undefined,
        limit: query.limit ? Number(query.limit) : 50,
        projectId,
        skip: query.skip ? Number(query.skip) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        zeroOnly: query.zeroOnly === 'true',
      });

      return reply.code(200).send({ logs });
    } catch (error) {
      logger.error('List RAG query feed error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/score-distribution', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(session.tenantDbName, key, projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const query = (request.query ?? {}) as { from?: string; to?: string };
      const buckets = await aggregateRagQueryScoreDistribution(session.tenantDbName, key, {
        from: query.from ? new Date(query.from) : undefined,
        projectId,
        to: query.to ? new Date(query.to) : undefined,
      });

      return reply.code(200).send({ buckets });
    } catch (error) {
      logger.error('RAG score distribution error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  /* ── Re-index runs ─────────────────────────────────────────────────── */

  app.post('/rag/modules/:key/reindex', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(session.tenantDbName, key, projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      const body = safeReadJsonBody<Record<string, unknown>>(request);
      const reason = body.reason;
      if (reason !== undefined && reason !== 'chunk-config' && reason !== 'embedding-model' && reason !== 'manual') {
        return reply.code(400).send({
          error: 'reason must be one of: chunk-config, embedding-model, manual',
        });
      }

      const run = await startRagReindex(session.tenantDbName, session.tenantId, projectId, {
        ragModuleKey: key,
        reason: reason ?? 'manual',
        createdBy: session.userId,
      });

      return reply.code(201).send({ run });
    } catch (error) {
      if (error instanceof Error && error.message.includes('already running')) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof Error && error.message.includes('not active')) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Start RAG re-index error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/reindex', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const ragModule = await getRagModule(session.tenantDbName, key, projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      // Module keys are unique per project, not per tenant, so the run list
      // has to be narrowed by project as well as by key.
      const runs = await listRagReindexRuns(session.tenantDbName, key, { projectId });
      return reply.code(200).send({ runs });
    } catch (error) {
      logger.error('List RAG re-index runs error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/rag/modules/:key/reindex/:runKey/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key, runKey } = request.params as { key: string; runKey: string };
      const ragModule = await getRagModule(session.tenantDbName, key, projectId);

      if (!ragModule) {
        return reply.code(404).send({ error: 'RAG module not found' });
      }

      // A run key is tenant-wide, so bind it to the module and project the URL
      // resolved to — otherwise any member could cancel another project's
      // rebuild by id alone.
      const existing = await getRagReindexRun(session.tenantDbName, runKey);
      const outOfScope = !existing
        || existing.ragModuleKey !== key
        || (Boolean(existing.projectId) && String(existing.projectId) !== String(projectId));
      if (outOfScope) {
        return reply.code(404).send({ error: 'Re-index run not found' });
      }

      const run = await cancelRagReindex(session.tenantDbName, runKey);
      return reply.code(200).send({ run });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not running')) {
        return reply.code(409).send({ error: error.message });
      }
      logger.error('Cancel RAG re-index error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};
