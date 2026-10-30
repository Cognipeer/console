import { Buffer } from 'node:buffer';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import type { IRagChunkConfig, IRagDocument, IRagExtractionConfig, IRagModule, IUser, RagDocumentStatus } from '@/lib/database';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';
import { normalizeOcrSettings, type OcrSettings } from '@/lib/services/extraction';
import { ocrModelProblem, readDocumentExtraction } from '../ragExtraction';
import {
  aggregateRagQueryScoreDistribution,
  countRagQueryLogs,
  createRagModule,
  deleteRagDocument,
  deleteRagModule,
  getRagDocument,
  getRagDocumentFullText,
  getRagDocumentTextLines,
  getRagModule,
  ingestDocument,
  ingestFile,
  listRagDocuments,
  listRagDocumentsPage,
  listRagModules,
  listRagQueryLogs,
  queryRag,
  reingestDocument,
  updateRagModule,
  shapeRagQueryResponse,
} from '@/lib/services/rag/ragService';
import { clientGone } from '../clientGone';
import { RagDocumentGoneError, RagModuleInactiveError, RagOcrIncompleteError, RagOriginalMissingError, RagReextractIncompleteError, RagStoredTextUnavailableError } from '@/lib/services/rag/errors';
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
  RAG_EXPORT_FORMAT,
  RAG_EXPORT_VERSION,
  exportRagModule,
  importRagModuleJsonl,
  type RagExportDocumentLine,
  type RagExportHeader,
  type RagExportResult,
} from '@/lib/services/rag/ragTransfer';
import { loadSourceText } from '@/lib/services/rag/ragSource';
import {
  authorizeServiceForRequest,
  readJsonBody,
  requireProjectContextForRequest,
  safeReadJsonBody,
  sendProjectContextError,
  serviceActionAllowedForRequest,
  withApiRequestContext,
} from '../fastify-utils';
import { canAdministerRagAccess, ragAccessForRequest, sendRagAccessError } from '../ragAccessRequest';
import { kbIndexShareRefusal } from '../ragOwnedResources';
import type { RagDocumentPlacementInput } from '@/lib/services/rag/ragAccessService';
import type { RagAccessScope } from '@/lib/services/rag/access';
import { VectorFilterError } from '@/lib/providers';

const logger = createLogger('api:rag');

const DOCUMENT_STATUSES: readonly RagDocumentStatus[] = ['pending', 'processing', 'indexed', 'failed'];

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

const asAccess: FieldReader<NonNullable<IRagModule['access']>> = (value, field) => {
  const access = asPlainObject(value, field);
  return {
    enabled: asBoolean(access.enabled, `${field}.enabled`),
    ...(access.adminBypass === undefined ? {} : { adminBypass: asBoolean(access.adminBypass, `${field}.adminBypass`) }),
  };
};

/** The OCR setting of a module's `extraction`: validated here, the model it names is checked by `ocrModelProblem`. */
const asModuleExtraction: FieldReader<IRagExtractionConfig> = (value, field) => {
  const extraction = asPlainObject(value, field);
  for (const key of Object.keys(extraction)) {
    if (key !== 'ocr') throw new Error(`${field}.${key} is not a known setting`);
  }
  const result: IRagExtractionConfig = {};
  // `ocr: null` is the same as leaving it out: this module does not OCR.
  if (extraction.ocr !== undefined && extraction.ocr !== null) {
    const { value: ocr, error } = normalizeOcrSettings(extraction.ocr);
    if (error) throw new Error(`${field}.${error}`);
    if (ocr) result.ocr = ocr;
  }
  return result;
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
    ...(body.extraction !== undefined && body.extraction !== null
      ? { extraction: asModuleExtraction(body.extraction, 'extraction') }
      : {}),
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
    ...(body.extraction !== undefined ? { extraction: clearable(body, 'extraction', asModuleExtraction) } : {}),
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
    access: clearable(body, 'access', asAccess),
    metadata: optional(body, 'metadata', asPlainObject),
  };
}

/**
 * Switching access control (or its admin exception) is for Knowledge Engine
 * admins only. True when refused (the 403 is sent). A boolean, not the reply:
 * a reply is thenable, so an async function returning it resolves to undefined.
 */
export async function refuseAccessChange(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const decision = await authorizeServiceForRequest(request, 'rag', { level: 'admin' });
  if (decision.allowed) return false;
  reply.code(403).send({
    error: 'Switching access control of a knowledge base needs Knowledge Engine admin',
    code: 'access_denied',
  });
  return true;
}

/**
 * Folder and permissions an ingest asks for (`folderId`, `folderPath`, `acl`).
 * Setting permissions needs Knowledge Engine admin. With access control on, so
 * does creating folders (by path) and changing the folder of a document that
 * exists; anyone else places NEW documents only in folders they can read. An
 * API token never holds `scope.manage`, so what the admin check answered for it
 * travels with the placement (`admin`).
 */
export async function readDocumentPlacement(
  request: FastifyRequest,
  reply: FastifyReply,
  body: Record<string, unknown>,
  scope: RagAccessScope | undefined,
): Promise<{ placement?: RagDocumentPlacementInput; refused?: FastifyReply }> {
  const placement: RagDocumentPlacementInput = {};
  if (body.folderId !== undefined) {
    if (body.folderId !== null && typeof body.folderId !== 'string') {
      return { refused: reply.code(400).send({ error: 'folderId must be a folder id or null' }) };
    }
    placement.folderId = body.folderId as string | null;
  } else if (body.folderPath !== undefined) {
    if (typeof body.folderPath !== 'string') return { refused: reply.code(400).send({ error: 'folderPath must be a string' }) };
    placement.folderPath = body.folderPath;
  }
  let admin = false;
  if (body.acl !== undefined && body.acl !== null) {
    const decision = await authorizeServiceForRequest(request, 'rag', { level: 'admin' });
    if (!decision.allowed) {
      return {
        refused: reply.code(403).send({ error: 'Setting document permissions needs Knowledge Engine admin', code: 'access_denied' }),
      };
    }
    admin = true;
    placement.acl = body.acl;
  } else if ((placement.folderId !== undefined || placement.folderPath !== undefined) && scope?.enabled && !scope.manage) {
    // Asked quietly: a "no" only narrows what the caller may do with folders, it is not a refusal.
    admin = await canAdministerRagAccess(request, { projectId: scope.projectId });
  }
  if (placement.folderId === undefined && placement.folderPath === undefined && placement.acl === undefined) return {};
  return { placement: { ...placement, ...(scope ? { scope } : {}), ...(admin ? { admin } : {}) } };
}

/** Whether any module of the tenant with this key has access control on. */
async function keyHasAccessControl(tenantDbName: string, ragModuleKey: string): Promise<boolean> {
  const modules = await listRagModules(tenantDbName);
  return modules.some((candidate) => candidate.key === ragModuleKey && candidate.access?.enabled === true);
}

/**
 * With access control on, a document the caller may not read is answered as
 * if it did not exist. `retrieve` (text reads) lets the admin exception through;
 * `manage` (metadata, delete, re-ingest) lets every manager through.
 *
 * The module that decides is the one that owns the document: the module of its
 * key in the project the row names, not the request project's (an owner or
 * admin reaches the documents of other projects, and the request project may
 * have no such module, or one without access control). A row that names no
 * project (written before rows carried one) is the request project's; when that
 * project has no module of the key, the row is hidden if any module of the
 * tenant with that key has access control.
 */
export async function documentHiddenFor(
  request: FastifyRequest,
  scopeInput: { tenantDbName: string; tenantId: string; projectId?: string; ragModuleKey: string },
  document: IRagDocument,
  purpose: 'retrieve' | 'manage',
): Promise<boolean> {
  const ownerProjectId = document.projectId ? String(document.projectId) : scopeInput.projectId;
  const { module: ownerModule, scope } = await ragAccessForRequest(request, { ...scopeInput, projectId: ownerProjectId });
  if (!ownerModule) {
    if (document.projectId) return false;
    return keyHasAccessControl(scopeInput.tenantDbName, scopeInput.ragModuleKey);
  }
  if (!scope?.enabled) return false;
  if (purpose === 'manage') return !scope.manage && !scope.canReadDocument(document);
  return scope.enforced && !scope.canReadDocument(document);
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
 * Owners and admins too: the active project decides, as it does for an API
 * token, whose project is fixed by the token.
 */
export async function documentInProjectScope(
  tenantDbName: string,
  documentId: string,
  ragModuleKey: string,
  projectId: string,
): Promise<IRagDocument | null> {
  const document = await getRagDocument(tenantDbName, documentId);
  if (!document) return null;
  if (document.ragModuleKey !== ragModuleKey) return null;
  if (!document.projectId) return document;
  return String(document.projectId) === String(projectId) ? document : null;
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

/**
 * Whose queries a module's query log shows this request. The log keeps what
 * people asked word for word, so all of it is for those who administer the
 * module (`rag` admin in its project); everyone else reads only the queries
 * they made, while the counters beside them still count every query.
 */
async function queryLogScope(
  request: FastifyRequest,
  ragModule: Pick<IRagModule, 'projectId'>,
  userId: string,
): Promise<{ scope: 'all' | 'own'; userId?: string }> {
  const everyone = await serviceActionAllowedForRequest(request, 'rag', 'admin', { projectId: ragModule.projectId ?? null });
  return everyone ? { scope: 'all' } : { scope: 'own', userId };
}

/**
 * A module as the caller may see it. Its totals count every document, readable
 * or not, so a caller whose reads are checked (access control on, no admin
 * exception for them) gets the module without them. A module without access
 * control comes back as it is, with no further read.
 */
export async function moduleAsCallerSees(
  request: FastifyRequest,
  where: { tenantDbName: string; tenantId: string; projectId?: string },
  ragModule: IRagModule,
): Promise<IRagModule> {
  if (ragModule.access?.enabled !== true) return ragModule;
  const { scope } = await ragAccessForRequest(request, { ...where, ragModuleKey: ragModule.key });
  if (scope && !scope.enforced) return ragModule;
  const { totalDocuments: _documents, totalChunks: _chunks, ...rest } = ragModule;
  return rest;
}

/** What a re-index run needs to know of whoever reads it. */
type RunReader = Pick<RagAccessScope, 'enabled' | 'manage' | 'enforced'>;

/** A reader of a knowledge base with access control whose scope is not known: sees the least. */
const UNKNOWN_RUN_READER: RunReader = { enabled: true, manage: false, enforced: true };

/** Who reads the runs of this module: undefined when it has no access control (nothing is left out). */
async function runReaderOf(
  request: FastifyRequest,
  where: { tenantDbName: string; tenantId: string; projectId?: string },
  ragModule: IRagModule,
): Promise<RunReader | undefined> {
  if (ragModule.access?.enabled !== true) return undefined;
  const { scope } = await ragAccessForRequest(request, { ...where, ragModuleKey: ragModule.key });
  return scope ?? UNKNOWN_RUN_READER;
}

/**
 * A re-index run as its reader may see it. A run counts the documents of the
 * module and keeps the names of the ones that failed, readable or not. A reader
 * whose reads are checked gets no total; one who does not manage the knowledge
 * base gets no per-document detail either (counts, failures, the cursor).
 */
function reindexRunForCaller(reader: RunReader | undefined, run: IRagReindexRun): IRagReindexRun {
  if (!reader?.enabled) return run;
  if (reader.manage && !reader.enforced) return run;

  const { totalDocuments: _total, ...rest } = run;
  const view: Partial<IRagReindexRun> = rest;
  if (!reader.manage) {
    delete view.processedDocuments;
    delete view.failedDocuments;
    delete view.errorMessage;
    if (view.progress) {
      const { lastDocumentId: _lastDocumentId, ...progress } = view.progress;
      view.progress = progress;
    }
    if (view.metadata) {
      const { failures: _failures, ...metadata } = view.metadata;
      view.metadata = metadata;
    }
  }
  return view as IRagReindexRun;
}

/**
 * `exportRagModule` for a caller whose reads are checked (a manager while the
 * module keeps the admin exception off): the file holds the documents the scope
 * reads and nothing says how many were left out. Same file as the export of a
 * module without access control.
 */
async function exportReadableDocuments(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  ragModuleKey: string,
  scope: RagAccessScope,
): Promise<RagExportResult | undefined> {
  const ragModule = await getRagModule(tenantDbName, ragModuleKey, projectId);
  if (!ragModule) return undefined;

  const access = scope.documentFilter();
  const listed = await listRagDocuments(tenantDbName, ragModuleKey, {
    projectId,
    ...(access ? { access } : {}),
  });
  const lines: string[] = [];
  let skippedDocuments = 0;

  for (const row of listed) {
    if (!scope.canReadDocument(row)) continue;
    // The list drops the inline source text, and a short document keeps its text nowhere else.
    const document = (await getRagDocument(tenantDbName, String(row._id))) ?? row;
    const content = await loadSourceText(tenantDbName, tenantId, projectId, document);
    if (!content) {
      skippedDocuments += 1;
      continue;
    }
    const line: RagExportDocumentLine = {
      type: 'document',
      fileName: document.fileName,
      contentType: document.contentType,
      metadata: document.metadata,
      chunkConfig: document.chunkConfig,
      content,
    };
    lines.push(JSON.stringify(line));
  }

  const header: RagExportHeader = {
    format: RAG_EXPORT_FORMAT,
    version: RAG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    module: {
      key: ragModule.key,
      name: ragModule.name,
      description: ragModule.description,
    },
    documentCount: lines.length,
    skippedDocuments,
  };

  const safeKey = ragModule.key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    fileName: `${safeKey}.rag.jsonl`,
    body: [JSON.stringify(header), ...lines].join('\n') + '\n',
    documentCount: lines.length,
    skippedDocuments,
  };
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
      const where = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };

      return reply.code(200).send({
        modules: await Promise.all(modules.map((ragModule) => moduleAsCallerSees(request, where, ragModule))),
      });
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
      // A knowledge base on the index of one with access control would read its vectors unchecked.
      const refusal = await kbIndexShareRefusal(
        request,
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { providerKey: fields.vectorProviderKey, indexKey: fields.vectorIndexKey },
      );
      if (refusal) return reply.code(403).send(refusal);
      const modelProblem = await ocrModelProblem({ tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, fields.extraction?.ocr);
      if (modelProblem) return reply.code(400).send({ error: modelProblem });

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

      return reply.code(200).send({
        module: await moduleAsCallerSees(
          request,
          { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
          ragModule,
        ),
      });
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
      if (fields.access !== undefined) {
        if (await refuseAccessChange(request, reply)) return reply;
      }
      // Moving the module onto an index of a knowledge base with access control is refused; leaving it where it is is not.
      const where = { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId };
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
      const modelProblem = await ocrModelProblem({ tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, fields.extraction?.ocr);
      if (modelProblem) return reply.code(400).send({ error: modelProblem });

      const ragModule = await updateRagModule(session.tenantDbName, String(existing._id), {
        ...fields,
        updatedBy: session.userId,
      });

      return reply.code(200).send({ module: ragModule ? await moduleAsCallerSees(request, where, ragModule) : ragModule });
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
      const query = (request.query ?? {}) as {
        search?: string;
        status?: string;
        limit?: string;
        offset?: string;
        folderId?: string;
      };
      const status = DOCUMENT_STATUSES.includes(query.status as RagDocumentStatus)
        ? (query.status as RagDocumentStatus)
        : undefined;
      const limit = Number.parseInt(query.limit ?? '', 10);
      const offset = Number.parseInt(query.offset ?? '', 10);
      // With access control on, people who do not manage the knowledge base list only what they may read.
      const { scope } = await ragAccessForRequest(request, {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        ragModuleKey: key,
      });
      const accessFilter = scope?.managementFilter();
      // `folderId=root` lists the top level; any other value one folder.
      const folderId = query.folderId === 'root' ? null : (query.folderId?.trim() || undefined);
      const page = await listRagDocumentsPage(
        session.tenantDbName,
        key,
        {
          projectId,
          search: query.search?.trim() || undefined,
          status,
          ...(folderId !== undefined ? { folderId } : {}),
          ...(accessFilter ? { access: accessFilter } : {}),
        },
        {
          limit: Number.isFinite(limit) ? limit : undefined,
          offset: Number.isFinite(offset) ? offset : undefined,
        },
      );

      return reply.code(200).send(page);
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
      let extraction: { ocr?: OcrSettings | null } | undefined;
      try {
        chunkConfig = readDocumentChunkConfig(body);
        extraction = readDocumentExtraction(body);
      } catch (error) {
        return sendInvalidRequest(reply, error);
      }

      const { scope } = await ragAccessForRequest(request, {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        ragModuleKey: key,
      });
      const { placement, refused } = await readDocumentPlacement(request, reply, body, scope);
      if (refused) return refused;

      if (typeof body.data === 'string') {
        const modelProblem = await ocrModelProblem({ tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId }, extraction?.ocr);
        if (modelProblem) return reply.code(400).send({ error: modelProblem });

        const document = await ingestFile(session.tenantDbName, session.tenantId, projectId, {
          chunkConfig,
          ...(extraction ? { extraction } : {}),
          // Reading the pages of a scan can take minutes: the dashboard gets its answer as soon as the file is stored.
          deferExtraction: true,
          signal: clientGone(reply),
          contentType: body.contentType as string | undefined,
          createdBy: session.userId,
          fileData: decodeFileData(body.data),
          force: body.force === true,
          fileName: body.fileName,
          metadata: body.metadata as Record<string, unknown> | undefined,
          ragModuleKey: key,
          ...(scope ? { access: scope } : {}),
          ...(placement ? { placement } : {}),
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
        ...(scope ? { access: scope } : {}),
        ...(placement ? { placement } : {}),
      });

      return reply.code(201).send({ document: withoutSourceText(document) });
    } catch (error) {
      if (error instanceof RagModuleInactiveError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof RagOcrIncompleteError) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      }
      const accessRefusal = sendRagAccessError(reply, error);
      if (accessRefusal) return accessRefusal;
      logger.error('Ingest RAG document error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/export', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const { scope } = await ragAccessForRequest(request, {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        ragModuleKey: key,
      });
      // An export carries every document's text: with access control on, only managers take one.
      if (scope?.enabled && !scope.manage) {
        return reply.code(403).send({
          error: 'Exporting a knowledge base with access control needs Knowledge Engine admin',
          code: 'access_denied',
        });
      }
      // A manager whose own reads are checked (admin exception off) exports what the checks let them read.
      const result = scope?.enforced
        ? await exportReadableDocuments(session.tenantDbName, session.tenantId, projectId, key, scope)
        : await exportRagModule(session.tenantDbName, session.tenantId, projectId, key);

      if (!result) {
        return reply.code(404).send({ error: 'Knowledge Engine module not found' });
      }

      return reply
        .code(200)
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${result.fileName}"`)
        .send(result.body);
    } catch (error) {
      logger.error('Export RAG module error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/rag/modules/:key/import', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.data !== 'string' || body.data.trim() === '') {
        return reply.code(400).send({ error: '"data" must be a non-empty JSONL string' });
      }
      const { scope } = await ragAccessForRequest(request, {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        ragModuleKey: key,
      });
      if (scope?.enabled && !scope.manage) {
        return reply.code(403).send({
          error: 'Importing into a knowledge base with access control needs Knowledge Engine admin',
          code: 'access_denied',
        });
      }

      const result = await importRagModuleJsonl(
        session.tenantDbName,
        session.tenantId,
        projectId,
        key,
        session.userId,
        body.data,
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Import RAG module error', { error });
      if (error instanceof Error && /not found|not active|at most|Unsupported export version/.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/documents/:documentId', withApiRequestContext(async (request, reply) => {
    try {
      const { documentId, key } = request.params as { documentId: string; key: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const document = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (await documentHiddenFor(request, {
        tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ragModuleKey: key,
      }, document, 'manage')) {
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

  app.get('/rag/modules/:key/documents/:documentId/content', withApiRequestContext(async (request, reply) => {
    try {
      const { documentId, key } = request.params as { documentId: string; key: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const document = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (await documentHiddenFor(request, {
        tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ragModuleKey: key,
      }, document, 'retrieve')) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      const result = await getRagDocumentFullText(session.tenantDbName, session.tenantId, projectId, document);
      if (!result) {
        return reply.code(404).send({ error: 'Source text is not available for this document; re-ingest it first' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get RAG document full text error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/rag/modules/:key/documents/:documentId/lines', withApiRequestContext(async (request, reply) => {
    try {
      const { documentId, key } = request.params as { documentId: string; key: string };
      const { projectId, session } = await requireProjectContextForRequest(request);
      const document = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (await documentHiddenFor(request, {
        tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ragModuleKey: key,
      }, document, 'retrieve')) {
        return reply.code(404).send({ error: 'Document not found' });
      }

      const query = (request.query ?? {}) as { offset?: string; limit?: string };
      const result = await getRagDocumentTextLines(session.tenantDbName, session.tenantId, projectId, document, {
        offset: query.offset !== undefined ? Number(query.offset) : undefined,
        limit: query.limit !== undefined ? Number(query.limit) : undefined,
      });
      if (!result) {
        return reply.code(404).send({ error: 'Source text is not available for this document; re-ingest it first' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get RAG document lines error', { error });
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
      const document = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
      );

      if (!document) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      if (await documentHiddenFor(request, {
        tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ragModuleKey: key,
      }, document, 'manage')) {
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { documentId, key } = request.params as { documentId: string; key: string };
      const existing = await documentInProjectScope(
        session.tenantDbName,
        documentId,
        key,
        projectId,
      );

      if (!existing) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      const accessInput = {
        tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ragModuleKey: key,
      };
      if (await documentHiddenFor(request, accessInput, existing, 'manage')) {
        return reply.code(404).send({ error: 'Document not found' });
      }
      const { scope } = await ragAccessForRequest(request, accessInput);

      const body = readJsonBody<Record<string, unknown>>(request);
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

      const document = await reingestDocument(session.tenantDbName, session.tenantId, projectId, {
        chunkConfig,
        // Reads the stored original again with the module's current OCR settings (a re-index never does).
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
        updatedBy: session.userId,
      });

      return reply.code(200).send({ document: withoutSourceText(document) });
    } catch (error) {
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

      const { scope, caller } = await ragAccessForRequest(request, {
        tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ragModuleKey: key,
      });
      const result = await queryRag(session.tenantDbName, session.tenantId, projectId, {
        filter: body.filter as Record<string, unknown> | undefined,
        query: body.query,
        ragModuleKey: key,
        topK: body.topK as number | undefined,
        minScore: typeof body.minScore === 'number' ? body.minScore : undefined,
      }, { caller, ...(scope ? { access: scope } : {}) });

      return reply.code(200).send({ result: shapeRagQueryResponse(result) });
    } catch (error) {
      if (error instanceof VectorFilterError) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof RagModuleInactiveError) {
        return reply.code(error.statusCode).send({ error: error.message });
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

      const { scope, caller } = await ragAccessForRequest(request, {
        tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId, ragModuleKey: key,
      });
      const result = await answerWithRag(session.tenantDbName, session.tenantId, projectId, {
        ragModuleKey: key,
        question: body.question,
        answerModelKey: body.answerModelKey,
        history: body.history as RagAnswerRequest['history'],
        topK: body.topK as number | undefined,
        retrieval: body.retrieval as RagAnswerRequest['retrieval'],
        generation: body.generation as RagAnswerRequest['generation'],
      }, { caller, ...(scope ? { access: scope } : {}) });

      return reply.code(200).send({ result });
    } catch (error) {
      if (error instanceof RagModuleInactiveError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
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
      const reader = await queryLogScope(request, ragModule, session.userId);

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
          ...(reader.userId !== undefined ? { userId: reader.userId } : {}),
        }),
        countRagQueryLogs(session.tenantDbName, key, { from, projectId, to }),
      ]);

      return reply.code(200).send({
        avgLatencyMs: totals.avgLatencyMs,
        logs,
        minScoreFilteredCount: totals.minScoreFilteredCount,
        scope: reader.scope,
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
      const reader = await queryLogScope(request, ragModule, session.userId);
      const logs = await listRagQueryLogs(session.tenantDbName, key, {
        from: query.from ? new Date(query.from) : undefined,
        limit: query.limit ? Number(query.limit) : 50,
        projectId,
        skip: query.skip ? Number(query.skip) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        zeroOnly: query.zeroOnly === 'true',
        ...(reader.userId !== undefined ? { userId: reader.userId } : {}),
      });

      return reply.code(200).send({ logs, scope: reader.scope });
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

      const reader = await runReaderOf(
        request,
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        ragModule,
      );
      const run = await startRagReindex(session.tenantDbName, session.tenantId, projectId, {
        ragModuleKey: key,
        reason: reason ?? 'manual',
        createdBy: session.userId,
      });

      return reply.code(201).send({ run: reindexRunForCaller(reader, run) });
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
      const reader = await runReaderOf(
        request,
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        ragModule,
      );
      return reply.code(200).send({ runs: runs.map((run) => reindexRunForCaller(reader, run)) });
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

      const reader = await runReaderOf(
        request,
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        ragModule,
      );
      const run = await cancelRagReindex(session.tenantDbName, runKey);
      return reply.code(200).send({ run: reindexRunForCaller(reader, run) });
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
