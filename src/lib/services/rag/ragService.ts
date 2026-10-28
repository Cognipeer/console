/**
 * RAG Service
 *
 * Orchestrates file ingestion (chunk → embed → vector upsert) and
 * retrieval (query → embed → vector query) using existing services.
 */

import { assertServiceEnabled, ServiceDisabledError, serviceOffReason } from '@/lib/services/availability/serviceAvailability';
import { RagModuleInactiveError } from './errors';
import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import {
  VectorFilterError,
  collectFilterFields,
  collectFilterOperators,
  parseVectorFilter,
} from '@/lib/providers';
import { getDatabase, type DatabaseProvider } from '@/lib/database';

const logger = createLogger('rag');
import type { IRagModule, IRagQueryLog, IRagChunk, IRagChunkConfig, IRagDocument, RagDocumentAccessFilter, RagDocumentStatus } from '@/lib/database';
import { convertToMarkdown } from '@cognipeer/to-markdown';
import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import {
  queryVectorIndex,
  upsertVectors,
  deleteVectors,
  vectorFilterOperatorsOf,
} from '@/lib/services/vector/vectorService';
import type { VectorQueryMatch } from '@/lib/providers';
import {
  anonymousKbCaller,
  isAclPushdownBroken,
  KnowledgeExposure,
  markAclPushdownBroken,
  noteRestrictedDocuments,
  resolveRagAccess,
  restrictedTagOf,
  runWithKnowledgeExposure,
  withKnowledgeExposure,
  type KbCaller,
  type RagAccessScope,
} from './access';
import { runRagAclSearch, type RagAclSearchStats } from './ragAclSearch';
import {
  commitRagDocumentPlacement,
  deleteRagDocumentAcl,
  deleteRagModuleAccessData,
  hasRagPlacement,
  prepareRagDocumentPlacement,
  ragPlacementRowFields,
  type PreparedRagPlacement,
  type RagDocumentPlacementInput,
} from './ragAccessService';
import { runReranker } from '@/lib/services/reranker';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';
import { fireAndForget } from '@/lib/core/asyncTask';
import { chunkConfigRequiresReindex, chunkText, resolveParentWindow, type ChunkContext } from './chunking';
import { publishRagIngestJob } from './ragIngestJob';
import { metadataWithCrawlerMark, type RagSentByCrawler } from './crawlerMark';
import {
  discardDocumentSource,
  hashSourceText,
  loadOriginalFile,
  loadSourceText,
  storeDocumentSource,
} from './ragSource';
import type {
  CreateRagModuleRequest,
  UpdateRagModuleRequest,
  RagIngestRequest,
  RagQueryRequest,
  RagQueryResult,
  RagQueryMatch,
  RagDocumentDeleteRequest,
  RagModule,
  RagDocument,
} from './types';

/* ── Content resolution ──────────────────────────────────────────────── */

/**
 * Chunk text normally lives in `rag_chunks` and is looked up by vectorId. For
 * vectors written by an external pipeline there is no such row, so fall back to
 * the text carried in the vector's own metadata under any common key.
 */
const CONTENT_METADATA_KEYS = [
  '_content',
  'content',
  'text',
  'chunk',
  'chunk_text',
  'page_content',
  'body',
] as const;

function resolveMetadataContent(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  for (const key of CONTENT_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/* ── Key generation ──────────────────────────────────────────────────── */

function generateKey(name: string, existingKey?: string): string {
  if (existingKey) return existingKey;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) + '-' + crypto.randomBytes(4).toString('hex');
}

/* ── Chunking ────────────────────────────────────────────────────────── */

/**
 * Splitting lives in ./chunking so every strategy shares one packer and one
 * set of invariants (offsets quote the source; chunkSize is a hard cap), and
 * so it can be tested without a database. See src/__tests__/unit/rag-chunking.
 */

/**
 * Model access for the strategies that need it. Both calls are lazy — a module
 * on `recursive_character` with no contextual header never reaches either.
 */
function buildChunkContext(
  tenantDbName: string,
  projectId: string,
  ragModule: IRagModule,
): ChunkContext {
  return {
    embed: (texts) => getEmbeddings(tenantDbName, projectId, ragModule.embeddingModelKey, texts),
    describe: async (documentExcerpt, chunk) => {
      const modelKey = ragModule.chunkConfig.contextualHeader?.modelKey;
      if (!modelKey) {
        throw new Error(
          'Contextual headers need chunkConfig.contextualHeader.modelKey to name a chat model.',
        );
      }
      const outcome = await handleChatCompletion({
        tenantDbName,
        projectId,
        modelKey,
        body: {
          messages: [
            {
              role: 'system',
              content:
                'You situate an excerpt inside its document so it can be retrieved on its own. '
                + 'Reply with ONE short sentence naming what the excerpt is about and where it sits. '
                + 'No preamble, no quotes, no markdown.',
            },
            {
              role: 'user',
              content: `<document>\n${documentExcerpt}\n</document>\n\n<excerpt>\n${chunk}\n</excerpt>`,
            },
          ],
          temperature: 0,
          max_tokens: 100,
        },
      });
      const choices = (outcome.response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
      const content = choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : '';
    },
  };
}

/** The module's chunk config, unless this document overrides it. */
function chunkConfigFor(ragModule: IRagModule, document?: Pick<IRagDocument, 'chunkConfig'>): IRagChunkConfig {
  return document?.chunkConfig ?? ragModule.chunkConfig;
}

/* ── Embedding helper ────────────────────────────────────────────────── */

async function getEmbeddings(
  tenantDbName: string,
  projectId: string,
  embeddingModelKey: string,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const result = await handleEmbeddingRequest({
    ...(signal ? { signal } : {}),
    tenantDbName,
    modelKey: embeddingModelKey,
    projectId,
    body: { input: texts },
  });
  const data = result.response?.data as Array<{ embedding?: number[] }> | undefined;
  if (!data || data.length === 0) {
    throw new Error('Failed to generate embeddings');
  }
  return data.map((d) => {
    if (!d.embedding) throw new Error('Missing embedding in response');
    return d.embedding;
  });
}

/* ── Indexing (chunk → embed → upsert → persist) ─────────────────────── */

const EMBED_BATCH_SIZE = 32;

interface IndexDocumentContentParams {
  db: Awaited<ReturnType<typeof getDatabase>>;
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  ragModule: IRagModule;
  chunkConfig: IRagChunkConfig;
  documentId: string;
  fileName: string;
  text: string;
  metadata?: Record<string, unknown>;
}

/**
 * The one place a document's text becomes chunks, vectors and rows.
 *
 * ingest and re-ingest used to carry near-verbatim copies of this block, so
 * every fix had to be made twice and they had already drifted.
 *
 * On failure it removes whatever it had already written to the vector store.
 * Without that, a document whose ingest died mid-way left vectors that nothing
 * could ever delete: deleteRagDocument reconstructs ids from `chunkCount`, and
 * `chunkCount` is only recorded once the whole pipeline has succeeded.
 */
async function indexDocumentContent(params: IndexDocumentContentParams): Promise<number> {
  // A document of a knowledge base with access control that is not open to everyone: the model calls that read its
  // text (contextual headers, embeddings) log their copies under the module's mark, as a conversation's would.
  if (params.ragModule.access?.enabled !== true) return indexDocumentText(params);
  const tag = await restrictedTagOf({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    module: params.ragModule,
    documents: [await params.db.findRagDocumentById(params.documentId)],
  });
  if (!tag) return indexDocumentText(params);
  return runWithKnowledgeExposure(new KnowledgeExposure({ seed: [tag], parent: null }), () => indexDocumentText(params));
}

async function indexDocumentText(params: IndexDocumentContentParams): Promise<number> {
  const { db, tenantDbName, tenantId, projectId, ragModule, documentId, fileName } = params;

  const chunks = await chunkText(
    params.text,
    params.chunkConfig,
    buildChunkContext(tenantDbName, projectId ?? '', ragModule),
  );
  if (chunks.length === 0) return 0;

  const vectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await getEmbeddings(
      tenantDbName,
      projectId ?? '',
      ragModule.embeddingModelKey,
      batch.map((c) => c.content),
    );

    batch.forEach((chunk, j) => {
      vectors.push({
        id: vectorIdFor(ragModule.key, documentId, chunk.index),
        values: embeddings[j],
        metadata: {
          ...chunk.metadata,
          ...(params.metadata ?? {}),
          // Reserved keys go LAST: caller-supplied metadata used to be spread
          // over them, so a document carrying its own `_documentId` silently
          // repointed its vectors at another document.
          _ragModule: ragModule.key,
          _documentId: documentId,
          _fileName: fileName,
          _chunkIndex: chunk.index,
        },
      });
    });
  }

  try {
    await upsertVectors(tenantDbName, tenantId, projectId ?? '', {
      providerKey: ragModule.vectorProviderKey,
      indexKey: ragModule.vectorIndexKey,
      vectors,
    });
  } catch (error) {
    await removeVectors(
      tenantDbName, tenantId, projectId, ragModule,
      vectors.map((v) => v.id), 'rollback after a failed index run',
    );
    throw error;
  }

  // Chunk text lives in the DB, not in vector metadata, which is size-capped on
  // most providers.
  const rows: Omit<IRagChunk, '_id' | 'createdAt'>[] = chunks.map((chunk) => ({
    tenantId,
    projectId,
    ragModuleKey: ragModule.key,
    documentId,
    chunkIndex: chunk.index,
    vectorId: vectorIdFor(ragModule.key, documentId, chunk.index),
    content: chunk.content,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    headingPath: chunk.headingPath,
    tokenCount: chunk.tokenCount,
    metadata: { ...chunk.metadata, ...(params.metadata ?? {}) },
  }));

  try {
    await db.bulkInsertRagChunks(rows as IRagChunk[]);
  } catch (error) {
    // Vectors without their text answer nothing, so this cannot stay a warning
    // the way it used to: roll back and fail the document.
    await removeVectors(
      tenantDbName, tenantId, projectId, ragModule,
      vectors.map((v) => v.id), 'rollback after a failed chunk write',
    );
    throw new Error(
      `Failed to persist chunk text for "${fileName}": ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  return chunks.length;
}

/** Providers cap how many ids a single delete call may carry. */
const VECTOR_DELETE_BATCH_SIZE = 500;

/** Actor recorded on stored objects the cascade removes, where no user asked for that object specifically. */
const CASCADE_ACTOR = 'knowledge-engine';

/** The one place the `moduleKey:documentId:chunkIndex` vector id shape is written. */
function vectorIdFor(ragModuleKey: string, documentId: string, chunkIndex: number): string {
  return `${ragModuleKey}:${documentId}:${chunkIndex}`;
}

/** Every vector id a document owns, reconstructed from its recorded chunk count. */
function documentVectorIds(ragModuleKey: string, documentId: string, chunkCount: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < chunkCount; i++) ids.push(vectorIdFor(ragModuleKey, documentId, i));
  return ids;
}

/**
 * Best-effort vector removal. The store is a third-party system: a failure here
 * must never block the database-side cleanup that follows it, or a module and
 * its documents become undeletable.
 */
async function removeVectors(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  ragModule: IRagModule,
  ids: string[],
  context: string,
): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTOR_DELETE_BATCH_SIZE) {
    const batch = ids.slice(i, i + VECTOR_DELETE_BATCH_SIZE);
    try {
      await deleteVectors(tenantDbName, tenantId, projectId ?? '', {
        providerKey: ragModule.vectorProviderKey,
        indexKey: ragModule.vectorIndexKey,
        ids: batch,
      });
    } catch (error) {
      logger.warn(`Failed to delete vectors (${context})`, {
        ragModuleKey: ragModule.key,
        count: batch.length,
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}

/**
 * The one number a match is judged on: `minScore`, the query log's
 * topScore/avgScore and the histogram the minScore slider is set against all
 * read this and nothing else.
 *
 * THE RULE: the threshold means what the operator sees. `score` is whatever the
 * module's own pipeline finally produced — a cosine similarity for a plain
 * dense query, the reranker's relevance once a reranker has run, the fused 0..1
 * score under hybrid — and it is both what the caller is handed back and what
 * the tuning histogram is built from, so it is the only scale a configured
 * threshold can have been calibrated against.
 *
 * `denseScore` and `vectorScore` are diagnostics and must never become the
 * threshold. After a successful rerank `vectorScore` is ALWAYS the pre-rerank
 * similarity, so thresholding on it applies the operator's number to a
 * distribution they never saw; and under hybrid only the matches the dense
 * channel found carry a `denseScore` at all, so it would put one threshold
 * against two scales inside a single result list.
 *
 * Hybrid stays coherent because the vector layer maps every fused score back
 * onto 0..1 before it leaves the driver (see providers/domains/vectorHybrid),
 * so every match in a hybrid set is on one scale. Under 'rrf' that scale
 * expresses rank confidence rather than similarity — 'weighted' is the mode to
 * pick when an absolute threshold has to keep meaning cosine.
 */
function rankedScoreOf(match: { score?: number }): number {
  return match.score ?? 0;
}

/* ── Metadata filters ────────────────────────────────────────────────── */

/** Validate a filter document, surfacing DSL errors at configuration time. */
function validateFilterDocument(filter: unknown, label: string): void {
  if (filter === undefined || filter === null) return;
  try {
    parseVectorFilter(filter);
  } catch (error) {
    throw new VectorFilterError(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Reject a query filter that touches a metadata key the module does not
 * expose. Modules that declare no `filterableFields` allow any key. A
 * provider-native `$raw` clause cannot be checked against the list, so a
 * module that declares one does not accept it.
 */
function assertFilterFieldsAllowed(
  filter: unknown,
  filterableFields: string[] | undefined,
): void {
  if (!filterableFields || filterableFields.length === 0) return;
  const parsed = parseVectorFilter(filter);
  if (!parsed) return;

  if (collectFilterOperators(parsed).has('$raw')) {
    throw new VectorFilterError(
      '"$raw" filters are not accepted by a module that lists its filterable fields.',
    );
  }

  const allowed = new Set(filterableFields);
  const rejected = [...collectFilterFields(parsed)].filter((field) => !allowed.has(field));

  if (rejected.length > 0) {
    throw new VectorFilterError(
      `Filtering on ${rejected.join(', ')} is not allowed for this Knowledge Engine module. `
      + `Filterable fields: ${filterableFields.join(', ')}.`,
    );
  }
}

/**
 * Extra limits for filters that did not come from the project itself (MCP
 * callers, model-filled tool arguments): no provider-native clauses, and no
 * filtering at all on a module that does not list its filterable fields.
 */
function assertUntrustedFilterAllowed(
  filter: unknown,
  filterableFields: string[] | undefined,
): void {
  const parsed = parseVectorFilter(filter);
  if (!parsed) return;

  if (!filterableFields || filterableFields.length === 0) {
    throw new VectorFilterError('This knowledge base does not accept filters.');
  }
  if (collectFilterOperators(parsed).has('$raw')) {
    throw new VectorFilterError('"$raw" filters are not accepted from this caller.');
  }
}

/**
 * Combine the module's standing filter, the per-request one and the isolation
 * guard into a single filter document. Isolation goes through here rather than
 * around it so a module with a defaultFilter keeps both constraints.
 */
function mergeFilters(
  defaultFilter: Record<string, unknown> | undefined,
  requestFilter: Record<string, unknown> | undefined,
  isolationFilter?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const parts = [defaultFilter, requestFilter, isolationFilter].filter(
    (part): part is Record<string, unknown> => Boolean(part) && Object.keys(part!).length > 0,
  );

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

/**
 * Whether `_ragModule` is ANDed into this module's queries.
 *
 * An explicit setting wins. With the field unset we have to guess, and the two
 * wrong guesses fail very differently: isolating an index that someone else's
 * pipeline filled returns NOTHING, because its vectors carry no `_ragModule`;
 * not isolating a shared index returns the OTHER module's chunks. So default to
 * on only when the index is demonstrably shared with another module of ours.
 * Every module we create now carries the flag, so this branch only ever runs
 * for modules that predate it.
 */
async function resolveModuleIsolation(
  db: Awaited<ReturnType<typeof getDatabase>>,
  ragModule: IRagModule,
): Promise<boolean> {
  if (typeof ragModule.isolateByModule === 'boolean') return ragModule.isolateByModule;

  try {
    const others = await db.countRagModulesByVectorIndexKey(ragModule.vectorIndexKey, {
      projectId: ragModule.projectId,
      excludeKey: ragModule.key,
    });
    return others > 0;
  } catch (error) {
    logger.warn('Could not tell whether the vector index is shared; leaving isolation off', {
      ragModuleKey: ragModule.key,
      vectorIndexKey: ragModule.vectorIndexKey,
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

/**
 * Whether a module update invalidates the stored vectors, and why.
 *
 * The embedding-model case is the one nothing else would catch: swapping to a
 * different model of the SAME dimension raises no error anywhere — the store
 * accepts the query vector and returns neighbours computed in a different
 * space, so the results are meaningless rather than absent.
 */
export function reindexReasonForUpdate(
  current: Pick<IRagModule, 'chunkConfig' | 'embeddingModelKey'>,
  update: Pick<UpdateRagModuleRequest, 'chunkConfig' | 'embeddingModelKey'>,
): 'chunk-config' | 'embedding-model' | undefined {
  if (update.embeddingModelKey && update.embeddingModelKey !== current.embeddingModelKey) {
    return 'embedding-model';
  }
  if (update.chunkConfig && chunkConfigRequiresReindex(current.chunkConfig, update.chunkConfig)) {
    return 'chunk-config';
  }
  return undefined;
}

/* ── Module CRUD ─────────────────────────────────────────────────────── */

export async function createRagModule(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: CreateRagModuleRequest,
): Promise<RagModule> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const key = generateKey(request.name, request.key);

  validateFilterDocument(request.defaultFilter, 'Invalid defaultFilter');

  // Check uniqueness
  const existing = await db.findRagModuleByKey(key, projectId);
  if (existing) {
    throw new Error(`Knowledge Engine module with key "${key}" already exists`);
  }

  return db.createRagModule({
    tenantId,
    projectId,
    key,
    name: request.name,
    description: request.description,
    embeddingModelKey: request.embeddingModelKey,
    vectorProviderKey: request.vectorProviderKey,
    vectorIndexKey: request.vectorIndexKey,
    fileBucketKey: request.fileBucketKey,
    fileProviderKey: request.fileProviderKey,
    chunkConfig: request.chunkConfig,
    status: 'active',
    rerankerKey: request.rerankerKey,
    rerankerOversample: request.rerankerOversample,
    defaultTopK: request.defaultTopK,
    defaultMinScore: request.defaultMinScore,
    defaultFilter: request.defaultFilter,
    filterableFields: request.filterableFields,
    responseDetail: request.responseDetail,
    hybrid: request.hybrid,
    // Our own ingest stamps `_ragModule` on every vector, so isolation is free
    // and stops a shared index from ever answering with another module's text.
    isolateByModule: request.isolateByModule ?? true,
    totalDocuments: 0,
    totalChunks: 0,
    metadata: request.metadata,
    createdBy: request.createdBy,
  });
}

export async function updateRagModule(
  tenantDbName: string,
  moduleId: string,
  request: UpdateRagModuleRequest,
): Promise<RagModule | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const current = await db.findRagModuleById(moduleId);
  const updates: Record<string, unknown> = {};
  if (request.name !== undefined) updates.name = request.name;
  if (request.description !== undefined) updates.description = request.description;
  if (request.embeddingModelKey !== undefined) updates.embeddingModelKey = request.embeddingModelKey;
  if (request.vectorProviderKey !== undefined) updates.vectorProviderKey = request.vectorProviderKey;
  if (request.vectorIndexKey !== undefined) updates.vectorIndexKey = request.vectorIndexKey;
  if (request.chunkConfig !== undefined) updates.chunkConfig = request.chunkConfig;
  if (request.status !== undefined) updates.status = request.status;
  if (request.metadata !== undefined) updates.metadata = request.metadata;
  if (request.rerankerKey !== undefined) updates.rerankerKey = request.rerankerKey ?? undefined;
  if (request.rerankerOversample !== undefined) updates.rerankerOversample = request.rerankerOversample ?? undefined;
  if (request.defaultTopK !== undefined) updates.defaultTopK = request.defaultTopK ?? undefined;
  if (request.defaultMinScore !== undefined) updates.defaultMinScore = request.defaultMinScore ?? undefined;
  if (request.defaultFilter !== undefined) {
    validateFilterDocument(request.defaultFilter, 'Invalid defaultFilter');
    updates.defaultFilter = request.defaultFilter ?? undefined;
  }
  if (request.filterableFields !== undefined) {
    updates.filterableFields = request.filterableFields ?? undefined;
  }
  if (request.responseDetail !== undefined) updates.responseDetail = request.responseDetail ?? undefined;
  if (request.hybrid !== undefined) updates.hybrid = request.hybrid ?? undefined;
  if (request.isolateByModule !== undefined) updates.isolateByModule = request.isolateByModule ?? undefined;
  if (request.access === null) {
    updates.access = undefined;
  } else if (request.access !== undefined) {
    // Merged into the stored setting: what the request leaves out stays, so switching access control off and on
    // again does not give the admin exception back to a module that removed it.
    const adminBypass = request.access.adminBypass ?? current?.access?.adminBypass;
    updates.access = {
      enabled: request.access.enabled === true,
      ...(adminBypass === false ? { adminBypass: false } : {}),
    };
  }

  // The stored vectors keep answering queries against the old settings until a
  // re-index run rebuilds them, so the flag is what tells anyone they are stale.
  const reindexReason = current ? reindexReasonForUpdate(current, request) : undefined;
  if (reindexReason) {
    updates.reindexRequired = true;
    logger.warn('Knowledge Engine module change requires a re-index', {
      moduleId,
      ragModuleKey: current?.key,
      reason: reindexReason,
    });
  }

  updates.updatedBy = request.updatedBy;
  return db.updateRagModule(moduleId, updates as Partial<IRagModule>);
}

/** Documents whose rows are torn down at once, so the rare path cannot flood the DB. */
const CASCADE_DELETE_BATCH_SIZE = 25;

/** Two documents belong to the same project only if both name it the same way. */
function sameProject(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') === (b ?? '');
}

/**
 * Delete a module and everything it owns.
 *
 * This used to delete one row, orphaning every document, chunk and vector: the
 * tenant kept paying for the storage, and the next module pointed at the same
 * index answered out of the dead one's vectors.
 *
 * ── Which rows are "its own" ──────────────────────────────────────────────
 * `deleteRagChunksByModuleKey` / `deleteRagDocumentsByModuleKey` match on
 * ragModuleKey alone, and a module key is unique only WITHIN a project. Firing
 * them for a module named "docs" therefore also wipes project B's "docs" —
 * silent, unrecoverable, cross-project data loss. So the bulk teardown is taken
 * only when this module is the tenant's sole owner of its key; otherwise the
 * rows are deleted one document at a time, and a document that cannot be
 * attributed to either module is left alone. An orphaned row is recoverable,
 * another project's deleted corpus is not.
 *
 * Documents are enumerated with NO project filter on purpose: everything
 * ingested through /client/v1 carries no projectId at all, even when its module
 * has one, and a project-scoped enumeration would delete those rows in bulk
 * while leaving their vectors and their bucket objects behind forever.
 *
 * The external store and the bucket are cleaned up best effort — a provider
 * outage must not make a module undeletable — but the row deletions are
 * allowed to throw, because a module row that disappears while its documents
 * survive recreates exactly the orphaning this fixes.
 */
export async function deleteRagModule(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  moduleId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleById(moduleId);
  if (!ragModule) return false;

  const siblings = (await db.listRagModules())
    .filter((m) => m.key === ragModule.key && String(m._id) !== String(ragModule._id));
  const keyIsUnambiguous = siblings.length === 0;

  const candidates = await db.listRagDocuments(ragModule.key);
  const documents = keyIsUnambiguous
    ? candidates
    : candidates.filter((doc) => sameProject(doc.projectId, ragModule.projectId));

  if (!keyIsUnambiguous) {
    logger.warn('Another project owns a module with this key; tearing down only this one', {
      ragModuleKey: ragModule.key,
      siblingCount: siblings.length,
      documentCount: documents.length,
      unattributableCount: candidates.length - documents.length,
    });
  }

  const vectorIds = documents.flatMap((doc) => documentVectorIds(
    ragModule.key,
    String(doc._id),
    doc.chunkCount ?? 0,
  ));
  await removeVectors(
    tenantDbName, tenantId, projectId, ragModule, vectorIds, `teardown of module ${ragModule.key}`,
  );

  await Promise.all(documents.map((doc) => discardDocumentSource(
    tenantDbName, tenantId, projectId, doc, CASCADE_ACTOR,
  )));

  if (keyIsUnambiguous) {
    // Also sweeps chunk rows whose document row is already gone, which the
    // per-document path below cannot reach.
    await db.deleteRagChunksByModuleKey(ragModule.key);
    await db.deleteRagDocumentsByModuleKey(ragModule.key);
  } else {
    for (let i = 0; i < documents.length; i += CASCADE_DELETE_BATCH_SIZE) {
      await Promise.all(documents.slice(i, i + CASCADE_DELETE_BATCH_SIZE).map(async (doc) => {
        await db.deleteRagChunksByDocumentId(String(doc._id));
        await db.deleteRagDocument(String(doc._id));
      }));
    }
  }

  // Folders and permissions are keyed by module key and project; a module
  // without a project that shares its key with another one cannot tell its own
  // apart, so those are left (they match nothing once the module is gone).
  if (keyIsUnambiguous || ragModule.projectId) {
    await deleteRagModuleAccessData(db, tenantDbName, ragModule);
  }

  return db.deleteRagModule(moduleId);
}

export async function getRagModule(
  tenantDbName: string,
  key: string,
  projectId?: string,
): Promise<RagModule | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findRagModuleByKey(key, projectId);
}

export async function getRagModuleById(
  tenantDbName: string,
  id: string,
): Promise<RagModule | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findRagModuleById(id);
}

export async function listRagModules(
  tenantDbName: string,
  filters?: { projectId?: string; status?: 'active' | 'disabled'; search?: string },
): Promise<RagModule[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listRagModules(filters);
}

/* ── Document CRUD ───────────────────────────────────────────────────── */

/**
 * Drop the inline source from a document before it leaves the service.
 *
 * `sourceText` is up to INLINE_SOURCE_MAX_CHARS of markdown that only the
 * re-index path ever reads; carrying it in a list of a few hundred documents
 * would turn a small JSON response into tens of megabytes.
 */
function withoutInlineSource(document: RagDocument): RagDocument {
  if (document.sourceText === undefined) return document;
  const trimmed = { ...document };
  delete trimmed.sourceText;
  return trimmed;
}

export async function listRagDocuments(
  tenantDbName: string,
  ragModuleKey: string,
  filters?: { projectId?: string; search?: string; access?: RagDocumentAccessFilter },
): Promise<RagDocument[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const documents = await db.listRagDocuments(ragModuleKey, filters);
  // Trimmed in place rather than mapped into a second array. Each row carries
  // up to INLINE_SOURCE_MAX_CHARS of sourceText and the DB contract has no
  // projection, so a module's whole corpus arrives in memory whichever way this
  // is written; replacing each row as we go at least keeps ONE copy of it
  // reachable instead of the trimmed set and the untrimmed set at once.
  for (let i = 0; i < documents.length; i += 1) {
    documents[i] = withoutInlineSource(documents[i]);
  }
  return documents;
}

export interface RagDocumentPage {
  documents: RagDocument[];
  total: number;
  limit: number;
  offset: number;
}

/** Page size bounds of a document list; the largest page keeps one response well under a few MB. */
export const RAG_DOCUMENT_PAGE_DEFAULT = 25;
export const RAG_DOCUMENT_PAGE_MAX = 100;

/**
 * One page of a module's documents (newest first) plus the total that matches
 * the same filters, so a caller can render a pager without a second request.
 * Unlike `listRagDocuments` this never loads the whole corpus.
 */
export async function listRagDocumentsPage(
  tenantDbName: string,
  ragModuleKey: string,
  filters: {
    projectId?: string;
    status?: RagDocumentStatus;
    search?: string;
    /** Only documents in this folder; null = only the top level. */
    folderId?: string | null;
    /** Only the documents an access scope lists (`scope.managementFilter()`). */
    access?: RagDocumentAccessFilter;
  },
  page: { limit?: number; offset?: number } = {},
): Promise<RagDocumentPage> {
  const limit = Math.min(
    Math.max(1, Math.floor(page.limit ?? RAG_DOCUMENT_PAGE_DEFAULT)),
    RAG_DOCUMENT_PAGE_MAX,
  );
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const [rows, total] = await Promise.all([
    db.listRagDocuments(ragModuleKey, { ...filters, limit, offset }),
    db.countRagDocuments(ragModuleKey, filters.projectId, {
      status: filters.status,
      search: filters.search,
      ...(filters.folderId !== undefined ? { folderId: filters.folderId } : {}),
      ...(filters.access ? { access: filters.access } : {}),
    }),
  ]);
  return {
    documents: rows.map((row) => withoutInlineSource(row)),
    total,
    limit,
    offset,
  };
}

export async function getRagDocument(
  tenantDbName: string,
  documentId: string,
): Promise<RagDocument | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findRagDocumentById(documentId);
}

/* ── Full-text read (two modes: whole document, or a line range) ──────── */

/**
 * Hard ceiling on what "give me the whole document" hands back in one call.
 * A few hundred KB of markdown is still tens of thousands of tokens; beyond
 * this the caller is pointed at the line-range mode instead of silently
 * blowing a model's context window.
 */
const FULL_TEXT_MAX_CHARS = 60_000;

export interface RagDocumentFullTextResult {
  documentId: string;
  fileName: string;
  contentType?: string;
  text: string;
  totalChars: number;
  totalLines: number;
  truncated: boolean;
}

/** The whole document, capped at FULL_TEXT_MAX_CHARS. Use getRagDocumentTextLines for the rest. */
export async function getRagDocumentFullText(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  document: IRagDocument,
): Promise<RagDocumentFullTextResult | undefined> {
  const text = await loadSourceText(tenantDbName, tenantId, projectId, document);
  if (text === undefined) return undefined;
  const truncated = text.length > FULL_TEXT_MAX_CHARS;
  return {
    documentId: String(document._id),
    fileName: document.fileName,
    contentType: document.contentType,
    text: truncated ? text.slice(0, FULL_TEXT_MAX_CHARS) : text,
    totalChars: text.length,
    totalLines: text.split('\n').length,
    truncated,
  };
}

const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 1000;

export interface RagDocumentLinesResult {
  documentId: string;
  fileName: string;
  contentType?: string;
  totalLines: number;
  /** 1-indexed, inclusive. 0 when the document (or the requested offset) has no lines. */
  startLine: number;
  endLine: number;
  hasMore: boolean;
  /** `${lineNumber}\t${text}` per line, joined by \n — same convention as the Read tool. */
  lines: string;
}

/** A 1-indexed line range, so a caller can page through a document it can't read whole. */
export async function getRagDocumentTextLines(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  document: IRagDocument,
  options?: { offset?: number; limit?: number },
): Promise<RagDocumentLinesResult | undefined> {
  const text = await loadSourceText(tenantDbName, tenantId, projectId, document);
  if (text === undefined) return undefined;

  const allLines = text.split('\n');
  const totalLines = allLines.length;
  const offset = Math.max(1, Math.floor(options?.offset ?? 1));
  const limit = Math.min(MAX_LINE_LIMIT, Math.max(1, Math.floor(options?.limit ?? DEFAULT_LINE_LIMIT)));

  const startIndex = offset - 1;
  const slice = startIndex < totalLines ? allLines.slice(startIndex, startIndex + limit) : [];
  const endLine = startIndex + slice.length;

  return {
    documentId: String(document._id),
    fileName: document.fileName,
    contentType: document.contentType,
    totalLines,
    startLine: slice.length > 0 ? offset : 0,
    endLine,
    hasMore: endLine < totalLines,
    lines: slice.map((line, i) => `${offset + i}\t${line}`).join('\n'),
  };
}

/* ── Ingest (chunk → embed → upsert) ────────────────────────────────── */

/** What an ingest takes: the request, and who is making it. */
export type RagIngestInput = RagIngestRequest & {
  /**
   * The caller's access scope, for a knowledge base with access control. A document the caller may not read is not
   * handed back to them as the unchanged copy of their upload (see `queryRag`'s `access`). An internal caller
   * (crawler, connector, import) passes none and is not held to it.
   */
  access?: RagAccessScope;
  /** Set by the crawler's ingest only: the document is marked as its page (see crawlerMark.ts). */
  sentByCrawler?: RagSentByCrawler;
};

export async function ingestDocument(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: RagIngestInput,
): Promise<RagDocument> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'rag');
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found`);
  if (ragModule.status !== 'active') throw new Error('Knowledge Engine module is not active');

  // Only the crawler's own ingest marks a document as its page; the mark in anyone's metadata is dropped.
  const metadata = metadataWithCrawlerMark(request.metadata, request.sentByCrawler);

  // A bad folder or permission entry fails the ingest before anything is stored.
  const placementCtx = { tenantDbName, tenantId, projectId, actor: request.createdBy };
  const callerScope = request.access ?? request.placement?.scope;
  const placement: PreparedRagPlacement | undefined = hasRagPlacement(request.placement)
    ? await prepareRagDocumentPlacement(db, placementCtx, ragModule, request.placement!, callerScope)
    : undefined;

  // Uploading the same file twice used to embed it twice, so every query then
  // answered out of two identical copies and paid for both. The crawler already
  // de-dupes by URL; this covers every other way content arrives.
  const sourceHash = hashSourceText(request.content);
  if (!request.force) {
    const existing = await db.findRagDocumentByFileName(
      request.ragModuleKey,
      request.fileName,
      projectId,
    );
    // A document the caller may not read is not theirs to be handed back (or re-placed): theirs is a new one. Nothing
    // stops a second document of the same name (stored objects and vector ids are per document), and answering
    // "already there" would tell the caller that a document with this name and text exists.
    const hiddenFromCaller = Boolean(existing && callerScope?.enforced && !callerScope.manage
      && !callerScope.canReadDocument(existing));
    if (existing && !hiddenFromCaller && existing.status === 'indexed' && existing.sourceHash === sourceHash) {
      logger.info('Skipping ingest of unchanged content', {
        ragModuleKey: request.ragModuleKey,
        fileName: request.fileName,
        documentId: String(existing._id),
      });
      if (placement) {
        await commitRagDocumentPlacement(db, placementCtx, ragModule, existing, placement);
        return withoutInlineSource((await db.findRagDocumentById(String(existing._id))) ?? existing);
      }
      return withoutInlineSource(existing);
    }
  }

  // Stored before the row is written so a single insert carries the result.
  const source = await storeDocumentSource({
    tenantDbName,
    tenantId,
    projectId,
    ragModule,
    fileName: request.fileName,
    contentType: request.contentType,
    text: request.content,
    fileData: request.fileData,
    createdBy: request.createdBy,
  });

  const docRecord = await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: request.ragModuleKey,
    fileName: request.fileName,
    contentType: request.contentType,
    size: Buffer.byteLength(request.content, 'utf-8'),
    status: request.deferIndexing ? 'pending' : 'processing',
    chunkConfig: request.chunkConfig,
    metadata,
    createdBy: request.createdBy,
    ...source,
    // An own ACL starts closed: nobody reads the row until its entries are written just below.
    ...(placement ? ragPlacementRowFields(placement) : {}),
  });

  const documentId = String(docRecord._id);
  if (placement) {
    try {
      await commitRagDocumentPlacement(db, placementCtx, ragModule, docRecord, placement);
    } catch (error) {
      await db.updateRagDocument(documentId, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Could not store the document permissions',
      });
      throw error;
    }
  }

  // The source is committed above, so publishing after it means a crash in
  // between costs the indexing (recovered by the boot sweep), never the content.
  if (request.deferIndexing) {
    await publishRagIngestJob({
      tenantDbName,
      tenantId,
      projectId,
      ragModuleKey: request.ragModuleKey,
      documentId,
    });
    return withoutInlineSource(docRecord);
  }

  try {
    const chunkCount = await indexDocumentContent({
      db,
      tenantDbName,
      tenantId,
      projectId,
      ragModule,
      chunkConfig: chunkConfigFor(ragModule, { chunkConfig: request.chunkConfig }),
      documentId,
      fileName: request.fileName,
      text: request.content,
      metadata,
    });

    const lastIndexedAt = new Date();
    await db.updateRagDocument(documentId, {
      status: 'indexed',
      chunkCount,
      lastIndexedAt,
    });

    await db.incrementRagModuleTotals(String(ragModule._id), { documents: 1, chunks: chunkCount });

    return withoutInlineSource({ ...docRecord, status: 'indexed' as const, chunkCount, lastIndexedAt });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Ingestion failed';
    await db.updateRagDocument(documentId, {
      status: 'failed',
      errorMessage: msg,
    });
    throw error;
  }
}

/**
 * Index a document whose source is already stored — the deferred half of
 * `ingestDocument`, run by the ingest queue consumer.
 *
 * Idempotent on the way in: a document another attempt already indexed returns
 * untouched, so a duplicate delivery (or the boot sweep racing a job that
 * survived the restart) cannot embed the same content twice.
 */
export async function indexPendingRagDocument(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  ragModuleKey: string,
  documentId: string,
): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const doc = await db.findRagDocumentById(documentId);
  if (!doc) {
    logger.warn('Skipping ingest job for a document that no longer exists', {
      documentId,
      ragModuleKey,
    });
    return;
  }
  if (doc.status === 'indexed') return;

  // A queued document whose service has been switched off is failed, not
  // retried: the job is acknowledged and re-ingesting is the operator's call
  // once the service is back.
  const off = await serviceOffReason({ tenantDbName, tenantId }, 'rag');
  if (off) {
    const refusal = new ServiceDisabledError(off);
    await db.updateRagDocument(documentId, { status: 'failed', errorMessage: `${refusal.code}: ${refusal.message}` });
    logger.warn('Deferred Knowledge Engine ingest refused: service is off', { documentId, ragModuleKey, code: refusal.code });
    return;
  }

  const ragModule = await db.findRagModuleByKey(ragModuleKey, projectId);
  if (!ragModule) {
    await db.updateRagDocument(documentId, {
      status: 'failed',
      errorMessage: `Knowledge Engine module "${ragModuleKey}" not found`,
    });
    return;
  }

  const text = await loadSourceText(tenantDbName, tenantId, projectId, doc);
  if (!text) {
    await db.updateRagDocument(documentId, {
      status: 'failed',
      errorMessage: 'Stored source text is unavailable for this document',
    });
    return;
  }

  await db.updateRagDocument(documentId, { status: 'processing' });

  try {
    const chunkCount = await indexDocumentContent({
      db,
      tenantDbName,
      tenantId,
      projectId,
      ragModule,
      chunkConfig: chunkConfigFor(ragModule, { chunkConfig: doc.chunkConfig }),
      documentId,
      fileName: doc.fileName,
      text,
      metadata: doc.metadata,
    });

    await db.updateRagDocument(documentId, {
      status: 'indexed',
      chunkCount,
      lastIndexedAt: new Date(),
    });

    await db.incrementRagModuleTotals(String(ragModule._id), { documents: 1, chunks: chunkCount });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Ingestion failed';
    await db.updateRagDocument(documentId, { status: 'failed', errorMessage: msg });
    logger.error('Deferred Knowledge Engine ingest failed', {
      documentId,
      ragModuleKey,
      error: msg,
    });
    throw error;
  }
}

/* ── File-based ingestion (file → markdown → chunk → embed → upsert) ── */

function extractMarkdownContent(conversion: unknown): string | undefined {
  if (!conversion) return undefined;
  if (typeof conversion === 'string') return conversion;
  if (typeof conversion === 'object') {
    const candidate = conversion as Record<string, unknown>;
    if (typeof candidate.markdown === 'string') return candidate.markdown;
    if (typeof candidate.content === 'string') return candidate.content;
    if (typeof candidate.result === 'string') return candidate.result;
  }
  return undefined;
}

/** Formats we read as UTF-8 rather than handing to the markdown converter. */
function isPlainTextFile(fileName: string, contentType?: string): boolean {
  return Boolean(
    contentType?.startsWith('text/')
    || /\.(txt|md|csv|json|xml|html|htm)$/i.test(fileName),
  );
}

/**
 * Convert an uploaded file buffer to plain text/markdown without ingesting it.
 * Shares the same conversion rules as `ingestFile` so callers that only need
 * the extracted text (e.g. dataset generation) don't have to re-implement it.
 */
export async function convertFileToText(
  fileName: string,
  fileData: Buffer,
  contentType?: string,
): Promise<string> {
  if (isPlainTextFile(fileName, contentType)) return fileData.toString('utf-8');
  const conversion = await convertToMarkdown(fileData, { fileName });
  const markdown = extractMarkdownContent(conversion);
  if (!markdown || markdown.trim().length === 0) {
    throw new Error(
      `Failed to convert "${fileName}" to text. The file format may not be supported.`,
    );
  }
  return markdown;
}

/**
 * Ingest a file into a Knowledge Engine module.
 * Converts the file to markdown/text using @cognipeer/to-markdown, then
 * delegates to ingestDocument for chunking + embedding + vector upsert. The
 * bytes travel with it so the module's bucket can keep the original.
 */
export async function ingestFile(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: {
    ragModuleKey: string;
    fileName: string;
    fileData: Buffer;
    contentType?: string;
    metadata?: Record<string, unknown>;
    chunkConfig?: IRagChunkConfig;
    force?: boolean;
    /**
     * Defer chunking + embedding to the ingest queue. File→text conversion
     * still runs here: the bytes have to become text before the document can be
     * persisted, and the stored text is what the job indexes.
     */
    deferIndexing?: boolean;
    /** Folder and permissions (see RagIngestRequest.placement). */
    placement?: RagDocumentPlacementInput;
    /** The caller's access scope (see RagIngestInput.access). */
    access?: RagAccessScope;
    createdBy: string;
  },
): Promise<RagDocument> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'rag');
  const isPlainText = isPlainTextFile(request.fileName, request.contentType);

  let textContent: string;
  try {
    textContent = await convertFileToText(request.fileName, request.fileData, request.contentType);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Failed to convert')) {
      throw error;
    }
    throw new Error(
      `File conversion failed for "${request.fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  return ingestDocument(tenantDbName, tenantId, projectId, {
    ragModuleKey: request.ragModuleKey,
    fileName: request.fileName,
    content: textContent,
    fileData: request.fileData,
    contentType: request.contentType,
    chunkConfig: request.chunkConfig,
    force: request.force,
    deferIndexing: request.deferIndexing,
    metadata: {
      ...request.metadata,
      _sourceType: isPlainText ? 'text' : 'converted',
    },
    ...(request.placement ? { placement: request.placement } : {}),
    ...(request.access ? { access: request.access } : {}),
    createdBy: request.createdBy,
  });
}

/* ── Query (embed → vector search) ───────────────────────────────────── */

/**
 * Small-to-big retrieval: the small chunk is what got embedded and matched, but
 * what the model reads is a wider window of the document around it, cut from
 * the stored source using the chunk's recorded offsets.
 *
 * The source is read once per document, not once per match — several matches
 * from the same document are the normal case, and each read can be a bucket
 * round trip.
 *
 * The module's `parentWindowSize` is what turns this on; a per-document
 * override only changes the width. Honouring an override on a module that has
 * the feature off would mean fetching every match's document on every query
 * just to discover it usually says nothing.
 */
async function applyParentWindows(params: {
  db: Awaited<ReturnType<typeof getDatabase>>;
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  ragModule: IRagModule;
  matches: RagQueryMatch[];
  chunkByVectorId: Map<string, IRagChunk>;
}): Promise<RagQueryMatch[]> {
  const { db, ragModule, matches, chunkByVectorId } = params;
  const moduleWindowSize = ragModule.chunkConfig.parentWindowSize;
  if (!moduleWindowSize || moduleWindowSize <= 0 || matches.length === 0) return matches;

  const documentIds = [...new Set(
    matches.map((m) => m.documentId).filter((id): id is string => Boolean(id)),
  )];

  const sources = new Map<string, { text: string; windowSize: number }>();
  await Promise.all(documentIds.map(async (documentId) => {
    const document = await db.findRagDocumentById(documentId);
    if (!document) return;
    const text = await loadSourceText(
      params.tenantDbName, params.tenantId, params.projectId, document,
    );
    if (!text) return;
    sources.set(documentId, {
      text,
      windowSize: chunkConfigFor(ragModule, document).parentWindowSize ?? moduleWindowSize,
    });
  }));

  if (sources.size === 0) {
    logger.warn('Parent windows are configured but no document source could be read', {
      ragModuleKey: ragModule.key,
      documentCount: documentIds.length,
    });
    return matches;
  }

  return matches.map((match) => {
    const source = match.documentId ? sources.get(match.documentId) : undefined;
    const chunk = chunkByVectorId.get(match.id);
    if (!source || !chunk) return match;
    const window = resolveParentWindow(source.text, chunk, source.windowSize);
    return window ? { ...match, content: window } : match;
  });
}

export interface RagQueryOptions {
  signal?: AbortSignal;
  /**
   * Who is reading. Only knowledge bases with access control look at it; for
   * those, a query without a caller (and without `access`) sees only what is
   * open to everyone.
   */
  caller?: KbCaller;
  /** A scope already resolved for this module (the answer service resolves one per request). */
  access?: RagAccessScope;
}

/**
 * The access scope a query runs with, or undefined when the module has no
 * access control (the query then runs exactly as it always did).
 */
async function resolveQueryAccess(
  tenantDbName: string,
  tenantId: string,
  ragModule: IRagModule,
  options: RagQueryOptions | undefined,
): Promise<RagAccessScope | undefined> {
  if (ragModule.access?.enabled !== true) return undefined;
  const given = options?.access;
  if (
    given
    && given.enabled
    && given.moduleKey === ragModule.key
    && (given.projectId ?? '') === (ragModule.projectId ?? '')
  ) {
    return given;
  }
  return resolveRagAccess({
    tenantDbName,
    tenantId,
    module: ragModule,
    caller: options?.caller ?? anonymousKbCaller('unknown'),
  });
}

/** The driver behind a vector provider key, for planning a filtered search; undefined when it cannot be read. */
async function vectorDriverOf(
  db: DatabaseProvider,
  tenantId: string,
  providerKey: string,
  projectId: string | undefined,
): Promise<string | undefined> {
  try {
    const record = await db.findProviderByKey(tenantId, providerKey, projectId || undefined);
    return record?.driver;
  } catch {
    return undefined;
  }
}

/** Who stored a match: the module key and project its chunk row carries, or only the key its vector names. */
interface MatchOwner {
  key: string;
  /** '' for a row stored without a project; absent when only the vector's `_ragModule` tells. */
  projectId?: string;
}

/**
 * Takes the matches of OTHER modules with access control out of a search that did not check access (a module without
 * it, or a caller who skips it). Two modules on one vector index get each other's vectors back when one of them does
 * not isolate itself, or when a module of another project with the same key keeps its vectors in the same index, and
 * with them text that the other module's checks guard.
 *
 * A match belongs to the module its stored chunk names, in the chunk's project (a project's own module of that key,
 * else the workspace-wide one); a chunk of this module's key stored in another project is another module's. A chunk
 * row written before rows carried a project, and a vector without a chunk row (it has only its `_ragModule`), are
 * judged by key, as such documents are: controlled when any other module of the tenant with that key has access
 * control on. The modules are looked up only when a match may be another module's (never for a module that has its
 * index to itself); when they cannot be looked up, those matches are dropped.
 */
async function withoutControlledOtherModules(
  db: DatabaseProvider,
  ragModule: IRagModule,
  matches: VectorQueryMatch[],
  chunks: ReadonlyMap<string, IRagChunk>,
): Promise<VectorQueryMatch[]> {
  const ownProject = ragModule.projectId ? String(ragModule.projectId) : '';
  const owners = new Map<VectorQueryMatch, MatchOwner>();
  for (const match of matches) {
    const chunk = chunks.get(match.id);
    if (typeof chunk?.ragModuleKey === 'string' && chunk.ragModuleKey !== '') {
      const projectId = chunk.projectId ? String(chunk.projectId) : '';
      // A workspace-wide module stores its rows in whichever project wrote them; a project's module, in its project.
      const own = chunk.ragModuleKey === ragModule.key && (ownProject === '' || projectId === ownProject);
      if (!own) owners.set(match, { key: chunk.ragModuleKey, projectId });
      continue;
    }
    const named = match.metadata?._ragModule;
    if (typeof named === 'string' && named !== '' && named !== ragModule.key) owners.set(match, { key: named });
  }
  if (owners.size === 0) return matches;

  let controlled: (owner: MatchOwner) => boolean;
  try {
    const modules = await db.listRagModules();
    const projectOf = (other: IRagModule) => (other.projectId ? String(other.projectId) : '');
    const isSelf = (other: IRagModule) => other.key === ragModule.key && projectOf(other) === ownProject;
    const controlledKeys = new Set(
      modules.filter((other) => other.access?.enabled === true && !isSelf(other)).map((other) => other.key),
    );
    controlled = (owner) => {
      if (!owner.projectId) return controlledKeys.has(owner.key);
      const owning = modules.find((other) => other.key === owner.key && projectOf(other) === owner.projectId)
        ?? modules.find((other) => other.key === owner.key && projectOf(other) === '');
      return owning ? owning.access?.enabled === true : controlledKeys.has(owner.key);
    };
  } catch (error) {
    logger.warn('Could not tell which modules on this vector index have access control; dropping their matches', {
      ragModuleKey: ragModule.key,
      error: error instanceof Error ? error.message : error,
    });
    controlled = () => true;
  }

  const kept = matches.filter((match) => {
    const owner = owners.get(match);
    return !owner || !controlled(owner);
  });
  if (kept.length < matches.length) {
    logger.debug('Dropped matches of other modules with access control that share the vector index', {
      ragModuleKey: ragModule.key,
      dropped: matches.length - kept.length,
    });
  }
  return kept;
}

/** What `runRagQuery` learned about the module, for the failure path in `queryRag`. */
interface RagQueryState {
  moduleFound: boolean;
  key?: string;
  projectId?: string;
}

/**
 * Runs a knowledge-base query and feeds the health rollup. Success is recorded
 * by `runRagQuery` (it knows the match count); a failure anywhere in the
 * pipeline is recorded here as an error (or cancelled when the caller aborted)
 * plus a usage event, then rethrown unchanged. Failures are deliberately NOT
 * written to `rag_query_logs`: that collection feeds the zero-result panel and
 * the score histogram, which would misread an error row as an empty search.
 */
export async function queryRag(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: RagQueryRequest,
  options?: RagQueryOptions,
): Promise<RagQueryResult> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'rag');
  const startTime = Date.now();
  const state: RagQueryState = { moduleFound: false };
  try {
    // In the work it is part of, or in its own: the reranker's model calls must know what passages they carry.
    return await withKnowledgeExposure(() => runRagQuery(tenantDbName, tenantId, projectId, request, options, state));
  } catch (err) {
    // An unknown module key and a rejected request filter are caller mistakes,
    // not knowledge-base faults: recording them would mint a health row per
    // mistyped key and push the error rate up for a healthy knowledge base.
    if (state.moduleFound && !(err instanceof VectorFilterError)) {
      const aborted = options?.signal?.aborted === true
        || (err instanceof Error && err.name === 'AbortError');
      const latencyMs = Date.now() - startTime;
      recordEntityMetric({
        tenantDbName,
        tenantId,
        projectId: state.projectId ?? projectId,
        entityType: 'kb',
        entityKey: state.key ?? request.ragModuleKey,
        source: 'service',
        outcome: aborted ? 'cancelled' : 'error',
        latencyMs,
      });
      recordUsageEvent({
        tenantDbName,
        tenantId,
        projectId,
        service: 'rag',
        refKey: request.ragModuleKey,
        status: aborted ? 'cancelled' : 'error',
        latencyMs,
      });
    }
    throw err;
  }
}

async function runRagQuery(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: RagQueryRequest,
  options: RagQueryOptions | undefined,
  state: RagQueryState,
): Promise<RagQueryResult> {
  const signal = options?.signal;
  const startTime = Date.now();
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found`);
  // A switched-off module is not queried. Checked before moduleFound is set so
  // the refusal is not recorded as a health fault of the knowledge base.
  if (ragModule.status !== 'active') throw new RagModuleInactiveError();
  state.moduleFound = true;
  state.key = ragModule.key;
  state.projectId = ragModule.projectId;

  // 1. Embed the query — and, when the module has access control, work out
  //    meanwhile what the caller may read.
  const embeddingStartedAt = Date.now();
  let embeddingMs = 0;
  const [[queryEmbedding], access] = await Promise.all([
    getEmbeddings(
      tenantDbName,
      projectId ?? '',
      ragModule.embeddingModelKey,
      [request.query],
      signal,
    ).then((embeddings) => {
      embeddingMs = Date.now() - embeddingStartedAt;
      return embeddings;
    }),
    resolveQueryAccess(tenantDbName, tenantId, ragModule, options),
  ]);

  // 2. Build the metadata filter: the module's standing filter ANDed with the
  //    caller's and, when the module is isolated, with its own key — after
  //    validating the request filter and checking it only touches fields the
  //    module exposes.
  validateFilterDocument(request.filter, 'Invalid filter');
  if (request.filterSource === 'untrusted') {
    assertUntrustedFilterAllowed(request.filter, ragModule.filterableFields);
  }
  assertFilterFieldsAllowed(request.filter, ragModule.filterableFields);
  const isolated = await resolveModuleIsolation(db, ragModule);
  const filter = mergeFilters(
    ragModule.defaultFilter,
    request.filter,
    isolated ? { _ragModule: ragModule.key } : undefined,
  );

  // 3. Query vector store. If reranker is configured, oversample candidates
  //    so the reranker has more to work with.
  const topK = request.topK ?? ragModule.defaultTopK ?? 5;
  const minScore = request.minScore ?? ragModule.defaultMinScore;
  const useReranker = Boolean(ragModule.rerankerKey);
  const oversampleMultiplier = ragModule.rerankerOversample ?? 3;
  const fetchTopK = useReranker ? Math.max(topK, topK * oversampleMultiplier) : topK;
  const hybrid = ragModule.hybrid?.enabled === true;

  const searchStore = (fetch: number, aclFilter?: Record<string, unknown>) => queryVectorIndex(tenantDbName, tenantId, projectId ?? '', {
    providerKey: ragModule.vectorProviderKey,
    indexKey: ragModule.vectorIndexKey,
    query: {
      vector: queryEmbedding,
      topK: fetch,
      // The access part is a system guard: ANDed after the caller's filter was checked against filterableFields.
      filter: aclFilter ? (filter ? { $and: [filter, aclFilter] } : aclFilter) : filter,
      // The keyword half needs the words themselves — an embedding carries no
      // signal for an error code, a SKU or a part number.
      ...(hybrid ? {
        text: request.query,
        hybrid: {
          mode: ragModule.hybrid?.mode,
          alpha: ragModule.hybrid?.alpha,
          k: ragModule.hybrid?.k,
        },
      } : {}),
    },
  }, ...(signal ? [{ signal }] as const : []));

  const vectorStartedAt = Date.now();
  let vectorMatches: VectorQueryMatch[];
  // Keyed by vectorId and holding the whole row, because a parent window needs
  // the chunk's charStart/charEnd as well as its text.
  let chunkByVectorId: Map<string, IRagChunk> = new Map();
  let aclStats: RagAclSearchStats | undefined;
  if (access?.enforced) {
    // Access control: only documents the caller may read reach anything below
    // (hydration, the reranker, the threshold, the logs). See ragAclSearch.ts.
    const driver = await vectorDriverOf(db, tenantId, ragModule.vectorProviderKey, projectId);
    const acl = await runRagAclSearch({
      db,
      scope: access,
      moduleKey: ragModule.key,
      moduleProjectId: ragModule.projectId,
      driver,
      operators: driver ? vectorFilterOperatorsOf(driver) : [],
      pushdownBroken: isAclPushdownBroken(tenantDbName, ragModule.vectorProviderKey),
      fetchTopK,
      topK,
      hybrid,
      search: async (fetch, aclFilter) => searchStore(fetch, aclFilter),
      onPushdownRefused: (error) => {
        markAclPushdownBroken(tenantDbName, ragModule.vectorProviderKey);
        logger.warn('Vector store refused the document-id filter; filtering after the search instead', {
          ragModuleKey: ragModule.key,
          driver,
          error: error instanceof Error ? error.message : String(error),
        });
      },
      signal,
    });
    vectorMatches = acl.matches;
    chunkByVectorId = acl.chunks;
    aclStats = acl.stats;
  } else {
    vectorMatches = (await searchStore(fetchTopK)).matches;
  }

  // Time spent in the vector store alone (with access control: plus the
  // document checks around it). This used to be measured from the very start
  // of the request, which hid where the time actually went.
  const vectorLatencyMs = Date.now() - vectorStartedAt;

  // 4. Hydrate chunk content from MongoDB (done above, and verified, when access control applied)
  const hydrateStartedAt = Date.now();
  const vectorIds = vectorMatches.map((m) => m.id).filter(Boolean);
  if (!aclStats && vectorIds.length > 0) {
    try {
      const storedChunks = await db.findRagChunksByVectorIds(vectorIds);
      chunkByVectorId = new Map(storedChunks.map((c) => [c.vectorId, c]));
    } catch (err) {
      logger.warn('Failed to hydrate chunk content from MongoDB', { error: err });
    }
  }
  const hydrateLatencyMs = Date.now() - hydrateStartedAt;

  // A search that did not check access (the checks above keep to this module's own documents) must not hand on what
  // another module with access control keeps on the same index. Before anything reads the matches: the reranker, the
  // parent windows and the response all work from what is left.
  if (!aclStats) vectorMatches = await withoutControlledOtherModules(db, ragModule, vectorMatches, chunkByVectorId);

  // 5. Map results
  let matches: RagQueryMatch[] = vectorMatches.map((m) => ({
    id: m.id,
    score: m.score,
    denseScore: m.denseScore,
    lexicalScore: m.lexicalScore,
    content: chunkByVectorId.get(m.id)?.content ?? resolveMetadataContent(m.metadata),
    metadata: m.metadata,
    documentId: typeof m.metadata?._documentId === 'string'
      ? m.metadata._documentId
      // with access control every match was verified against its stored chunk, which names the document
      : (aclStats ? chunkByVectorId.get(m.id)?.documentId : undefined),
    fileName: typeof m.metadata?._fileName === 'string' ? m.metadata._fileName : undefined,
    chunkIndex: typeof m.metadata?._chunkIndex === 'number' ? m.metadata._chunkIndex : undefined,
  }));

  // Vectors written outside our ingest pipeline have no rag_chunks row, so their
  // text can only come from vector metadata. Without this warning the empty
  // passages reach the LLM silently and it answers from nothing.
  const contentlessCount = matches.filter((m) => !(m.content ?? '').trim()).length;
  if (contentlessCount > 0) {
    logger.warn('RAG matches resolved with no content', {
      ragModuleKey: request.ragModuleKey,
      contentlessCount,
      totalMatches: matches.length,
      hint: 'Vectors not ingested through this product must carry their text in vector metadata '
        + `(one of: ${CONTENT_METADATA_KEYS.join(', ')}).`,
    });
  }

  // 5a. Passages of documents not open to everyone go on from here: the work this query is part of (an agent turn, an
  //     evaluation item...) is marked before anything below - the reranker's model calls included - can copy them.
  let restricted = false;
  if (ragModule.access?.enabled === true) {
    const handedOn = matches.filter((m) => (m.content ?? '').trim());
    if (handedOn.length > 0) {
      const ids = [...new Set(handedOn.map((m) => m.documentId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
      const rows = ids.length > 0 ? await db.findRagDocumentsByIds(ids) : [];
      const byId = new Map(rows.map((row) => [String(row._id), row]));
      restricted = (await noteRestrictedDocuments({
        tenantDbName,
        tenantId,
        module: ragModule,
        // A passage that names no document cannot be judged: it counts as closed.
        documents: handedOn.map((m) => (m.documentId ? byId.get(m.documentId) : undefined)),
      })) !== null;
    }
  }

  // 5b. Optional reranker pass.
  let rerankLatencyMs: number | undefined;
  if (useReranker && matches.length > 0 && ragModule.rerankerKey) {
    try {
      const rerankerInput = matches
        .map((m) => ({
          id: m.id,
          content: m.content ?? '',
          score: m.score,
          metadata: m.metadata,
        }))
        .filter((d) => d.content.length > 0);
      if (rerankerInput.length > 0) {
        const rerankResult = await runReranker(
          tenantDbName,
          tenantId,
          projectId,
          ragModule.rerankerKey,
          {
            query: request.query,
            documents: rerankerInput,
            topN: topK,
            source: 'rag',
            ragModuleKey: request.ragModuleKey,
          },
        );
        rerankLatencyMs = rerankResult.latencyMs;
        // Re-build matches in reranker-determined order. Preserve original
        // vector score under `vectorScore` for inspection.
        const byId = new Map(matches.map((m) => [m.id, m]));
        matches = rerankResult.results
          .map((r) => {
            const original = r.id ? byId.get(r.id) : undefined;
            if (!original) return null;
            return {
              ...original,
              score: r.score,
              vectorScore: r.originalScore,
            } as RagQueryMatch;
          })
          .filter((v): v is RagQueryMatch => v !== null);
      }
    } catch (err) {
      logger.warn('Reranker failed, falling back to vector order', { error: err });
    }
  }

  // What the store actually returned. Recorded because "nothing was retrieved"
  // and "the threshold discarded everything" look identical in matchCount alone
  // and want opposite fixes.
  const preFilterMatchCount = matches.length;
  // The best score BEFORE the threshold ran. Taken here rather than from the
  // survivors because a query the threshold emptied would otherwise be logged
  // with topScore 0 — and the zero-result panel and the score histogram exist
  // precisely to explain those queries and to re-tune the threshold that
  // emptied them, so a zero is the one value that tells them nothing.
  const bestRetrievedScore = matches.length > 0
    ? Math.max(...matches.map(rankedScoreOf))
    : 0;

  // 5c. Apply the minimum score threshold, if configured. See rankedScoreOf for
  //     why the threshold is compared against the pipeline's final score and
  //     never against a preserved retrieval-time similarity.
  if (typeof minScore === 'number' && minScore > 0) {
    matches = matches.filter((m) => rankedScoreOf(m) >= minScore);
  }

  // 5d. Apply final topK (in case reranker skipped or returned more).
  matches = matches.slice(0, topK);

  // 5e. Small-to-big: swap each match's text for the window around it in the
  //     document's source. Deliberately after the slice — the reranker has to
  //     score the passage that was actually retrieved, and only the surviving
  //     matches are worth the source read.
  matches = await applyParentWindows({
    db,
    tenantDbName,
    tenantId,
    projectId,
    ragModule,
    matches,
    chunkByVectorId,
  });

  const scores = matches.map((m) => rankedScoreOf(m));
  const latencyMs = Date.now() - startTime;

  // 6. Log the query.
  // No tokens — query embedding flows through the models service.
  const attribution = recordUsageEvent({
    tenantDbName,
    tenantId,
    projectId,
    service: 'rag',
    refKey: request.ragModuleKey,
    status: 'success',
    latencyMs,
    units: { matches: matches.length },
  });
  recordEntityMetric({
    tenantDbName,
    tenantId,
    projectId: ragModule.projectId ?? projectId,
    entityType: 'kb',
    entityKey: ragModule.key,
    source: 'service',
    outcome: 'ok',
    latencyMs,
    emptyResults: matches.length === 0 ? 1 : 0,
  });
  // Where the time actually went. vectorLatencyMs used to be computed and then
  // thrown away unless a reranker ran, which made slow searches undiagnosable.
  logger.debug('RAG query timing', {
    ragModuleKey: request.ragModuleKey,
    totalMs: latencyMs,
    embeddingMs,
    vectorMs: vectorLatencyMs,
    rerankMs: rerankLatencyMs,
    hydrateMs: hydrateLatencyMs,
    matches: matches.length,
  });

  // Telemetry off the critical path — this insert was adding a full DB round
  // trip to every search.
  fireAndForget('rag-query-log', async () => {
    await db.createRagQueryLog({
      userId: attribution.userId,
      apiTokenId: attribution.apiTokenId,
      actorType: attribution.actorType,
      tenantId,
      projectId,
      ragModuleKey: request.ragModuleKey,
      query: request.query,
      topK,
      matchCount: matches.length,
      preFilterMatchCount,
      // topScore describes RETRIEVAL — the best thing the store had, threshold
      // or no threshold — because that is what the histogram tunes the
      // threshold against. avgScore describes the ANSWER: how good the passages
      // that actually reached the caller were. Both on the scale rankedScoreOf
      // defines, so neither can mix rank confidence with similarity.
      topScore: bestRetrievedScore,
      avgScore: scores.length > 0 ? scores.reduce((sum, s) => sum + s, 0) / scores.length : 0,
      ...(typeof minScore === 'number' ? { minScoreApplied: minScore } : {}),
      hybrid,
      latencyMs,
      metadata: {
        embeddingMs,
        vectorLatencyMs,
        // an application's token acted for the person in `userId` (the token is `apiTokenId`)
        ...(attribution.via ? { via: attribution.via } : {}),
        // counts only: which plan ran and how many candidates the checks removed
        ...(aclStats ? {
          acl: {
            mode: aclStats.mode,
            dropped: aclStats.dropped,
            ...(aclStats.retried ? { retried: true } : {}),
            ...(aclStats.fellBack ? { fellBack: true } : {}),
          },
        } : {}),
        ...(useReranker ? {
          reranked: true,
          rerankerKey: ragModule.rerankerKey,
          rerankLatencyMs,
        } : {}),
      },
    });
  });

  return {
    matches,
    query: request.query,
    ragModuleKey: request.ragModuleKey,
    latencyMs,
    // Echoed so the API layer can shape the payload. Internal consumers
    // (answer service, agents, MCP tool) keep the full match set regardless —
    // they need documentId/fileName for citations and grouping.
    responseDetail: ragModule.responseDetail ?? 'full',
    ...(restricted ? { restricted: true } : {}),
  };
}

/**
 * Applies a module's `responseDetail` setting to a query result, producing the
 * JSON payload the public query endpoints return. 'text' strips everything but
 * the chunk text; 'full' (default) is the complete match.
 */
export function shapeRagQueryResponse(result: RagQueryResult): Record<string, unknown> {
  // `restricted` is for the server's own stored copies, not part of the response.
  const { responseDetail, matches, restricted: _restricted, ...rest } = result;
  return {
    ...rest,
    matches: responseDetail === 'text'
      ? matches.map((m) => ({ content: m.content }))
      : matches,
  };
}

/* ── Delete document (remove chunks from vector store) ───────────────── */

export async function deleteRagDocument(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: RagDocumentDeleteRequest,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found`);

  const doc = await db.findRagDocumentById(request.documentId);
  if (!doc) throw new Error('Document not found');

  const chunkCount = doc.chunkCount ?? 0;
  await removeVectors(
    tenantDbName, tenantId, projectId, ragModule,
    documentVectorIds(request.ragModuleKey, request.documentId, chunkCount),
    `deletion of document ${request.documentId}`,
  );

  // Delete chunk content from MongoDB
  try {
    await db.deleteRagChunksByDocumentId(request.documentId);
  } catch (err) {
    logger.warn('Failed to delete MongoDB chunks for document', { error: err });
  }

  // The stored source outlives the row unless it is deleted here.
  await discardDocumentSource(tenantDbName, tenantId, projectId, doc, CASCADE_ACTOR);

  // Update module stats
  await db.incrementRagModuleTotals(String(ragModule._id), { documents: -1, chunks: -chunkCount });

  const deleted = await db.deleteRagDocument(request.documentId);
  await deleteRagDocumentAcl(db, ragModule, request.documentId);
  return deleted;
}

/**
 * The document-row fields describing where its source now lives.
 *
 * The hash is what de-duplication and "has this changed?" compare against, so
 * it is withheld for a reconstruction: the joined text is kept so a later run
 * has something to rebuild from, but re-uploading the real original must never
 * be mistaken for a duplicate of the join — and the stale hash of the true
 * original must not survive next to the join either. Both are passed as an
 * explicit undefined so each provider's partial update clears them.
 */
function sourceRowFields(
  stored: Awaited<ReturnType<typeof storeDocumentSource>>,
  doc: IRagDocument,
  trustworthy: boolean,
): Partial<IRagDocument> {
  return {
    sourceHash: trustworthy ? stored.sourceHash : undefined,
    sourceText: stored.sourceText,
    sourceTextKey: stored.sourceTextKey,
    fileKey: stored.fileKey ?? doc.fileKey,
    fileBucketKey: stored.fileBucketKey ?? doc.fileBucketKey,
    fileProviderKey: stored.fileProviderKey ?? doc.fileProviderKey,
  };
}

/* ── Re-ingest document ───────────────────────────────────────────────── */

/**
 * Where the text for a re-ingest came from, best first.
 *
 * `chunk-join` is the old behaviour and the reason source persistence exists:
 * chunks overlap by design, so joining them repeats every overlap and produces
 * a document that is longer than, and different from, the one that was indexed.
 */
type ReingestOrigin = 'request-content' | 'request-file' | 'stored-file' | 'stored-text' | 'chunk-join';

interface ReingestSource {
  text: string;
  origin: ReingestOrigin;
  /** Bytes that still need storing — only set when they came in with the request. */
  fileData?: Buffer;
}

async function resolveReingestSource(
  db: Awaited<ReturnType<typeof getDatabase>>,
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  document: IRagDocument,
  request: { documentId: string; content?: string; fileData?: Buffer; fileName?: string; contentType?: string },
): Promise<ReingestSource> {
  if (request.content) {
    return { text: request.content, origin: 'request-content' };
  }

  const fileName = request.fileName ?? document.fileName;
  if (request.fileData) {
    return {
      text: await convertFileToText(fileName, request.fileData, request.contentType),
      origin: 'request-file',
      fileData: request.fileData,
    };
  }

  // The original upload beats our own extraction: a converter improvement only
  // reaches an already-ingested document if the bytes are re-run through it.
  const original = await loadOriginalFile(tenantDbName, tenantId, projectId, document);
  if (original) {
    return {
      text: await convertFileToText(original.fileName, original.data, original.contentType),
      origin: 'stored-file',
    };
  }

  const stored = await loadSourceText(tenantDbName, tenantId, projectId, document);
  if (stored) {
    return { text: stored, origin: 'stored-text' };
  }

  const existingChunks = await db.findRagChunksByDocumentId(request.documentId);
  if (existingChunks.length === 0) {
    throw new Error('No content provided and no existing chunks found for re-ingest');
  }
  logger.warn('Rebuilding a document from its own chunks — the result repeats every overlap '
    + 'and is deliberately not stored as the document source', {
    documentId: request.documentId,
    fileName,
    chunkCount: existingChunks.length,
  });
  return { text: existingChunks.map((c) => c.content).join('\n'), origin: 'chunk-join' };
}

/**
 * Re-ingest a document: deletes old chunks (vectors + MongoDB) and
 * re-runs the full ingest pipeline with the provided content / file.
 */
export async function reingestDocument(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: {
    ragModuleKey: string;
    documentId: string;
    content?: string;
    fileData?: Buffer;
    fileName?: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
    /** Re-chunk this document differently from the rest of the module. */
    chunkConfig?: IRagChunkConfig;
    /** Folder and permissions to apply along with the new content. */
    placement?: RagDocumentPlacementInput;
    /** Set by the crawler's ingest only (see RagIngestInput.sentByCrawler). */
    sentByCrawler?: RagSentByCrawler;
    updatedBy: string;
  },
): Promise<RagDocument> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'rag');
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found`);
  if (ragModule.status !== 'active') throw new Error('Knowledge Engine module is not active');

  const doc = await db.findRagDocumentById(request.documentId);
  if (!doc) throw new Error('Document not found');

  if (hasRagPlacement(request.placement)) {
    const placementCtx = { tenantDbName, tenantId, projectId, actor: request.updatedBy };
    const prepared = await prepareRagDocumentPlacement(
      db, placementCtx, ragModule, request.placement!, request.placement!.scope,
    );
    await commitRagDocumentPlacement(db, placementCtx, ragModule, doc, prepared);
  }

  const source = await resolveReingestSource(db, tenantDbName, tenantId, projectId, doc, request);
  const textContent = source.text;

  // The re-index job calls this with no metadata at all. Writing
  // `request.metadata` straight through therefore stripped every user- and
  // crawler-supplied key from the rebuilt vectors and chunk rows — and those
  // keys are exactly what defaultFilter/filterableFields filter on, so every
  // filtered query went empty after a re-index. The document's own metadata is
  // the floor; an explicit request only adds to and overrides it.
  // The crawler mark is the document's: nobody's metadata sets or clears it, only the crawler's own re-ingest.
  const requested = metadataWithCrawlerMark(request.metadata, request.sentByCrawler);
  const metadata = requested
    ? { ...doc.metadata, ...requested }
    : doc.metadata;

  // A chunk join is a lossy reconstruction — it repeats every overlap region —
  // so it must never become the document's CANONICAL source: hashing it would
  // make the corruption authoritative, and a later re-upload of the real
  // original would be de-duplicated away against it.
  //
  // It must still be PERSISTED, though. The steps below delete this document's
  // vectors and chunk rows, and for a document with no stored source those rows
  // are the only copy of its text. Keeping the join only in a local variable
  // means an embedding timeout or a SIGKILL between the delete and the rebuild
  // destroys the document outright, with a failure counter as the only trace.
  // So: store the text, withhold the hash, and record where it came from.
  const sourceIsTrustworthy = source.origin !== 'chunk-join';

  // Refresh the stored source so the NEXT re-index reads this run's input
  // rather than the one before it. Unchanged text is left alone — a re-index
  // triggered by a chunkConfig change must not rewrite the bucket.
  const sourceHash = hashSourceText(textContent);
  const sourceIsStored = Boolean(doc.sourceText || doc.sourceTextKey);
  let storedSource: Awaited<ReturnType<typeof storeDocumentSource>> | undefined;
  if (doc.sourceHash !== sourceHash || !sourceIsStored) {
    storedSource = await storeDocumentSource({
      tenantDbName,
      tenantId,
      projectId,
      ragModule,
      fileName: request.fileName ?? doc.fileName,
      contentType: request.contentType ?? doc.contentType,
      text: textContent,
      fileData: source.fileData,
      createdBy: request.updatedBy,
    });

    // COMMIT THE SOURCE BEFORE ANYTHING IS DESTROYED.
    //
    // For text under the inline cap storeDocumentSource only builds an
    // in-memory object — it performs no write at all — and the steps below
    // delete this document's vectors and chunk rows, which for a document with
    // no previously stored source are the ONLY copy of its text. Writing the
    // source fields here rather than in the success branch is what makes a
    // failed re-ingest recoverable instead of destructive.
    await db.updateRagDocument(request.documentId, sourceRowFields(storedSource, doc, sourceIsTrustworthy));

    // Upload keys are random, so a replacement never overwrites what it
    // supersedes — the old objects have to be dropped explicitly. Only drop the
    // ones actually replaced: a failed upload must not take the last copy with
    // it, and a RECONSTRUCTION never supersedes anything. A chunk join is what
    // we fall back to when the real source could not be read — very often
    // because reading it failed transiently — so deleting the object it failed
    // to read would destroy the document's only faithful copy.
    if (sourceIsTrustworthy) {
      await discardDocumentSource(tenantDbName, tenantId, projectId, {
        fileBucketKey: doc.fileBucketKey,
        sourceTextKey: storedSource.sourceText || storedSource.sourceTextKey ? doc.sourceTextKey : undefined,
        fileKey: storedSource.fileKey ? doc.fileKey : undefined,
      }, request.updatedBy);
    }
  }

  // 1. Delete old vectors
  const oldChunkCount = doc.chunkCount ?? 0;
  await removeVectors(
    tenantDbName, tenantId, projectId, ragModule,
    documentVectorIds(request.ragModuleKey, request.documentId, oldChunkCount),
    `re-ingest of document ${request.documentId}`,
  );

  // 2. Delete old MongoDB chunks
  try {
    await db.deleteRagChunksByDocumentId(request.documentId);
  } catch (err) {
    logger.warn('Reingest: failed to delete old MongoDB chunks', { error: err });
  }

  // Mark document as processing
  await db.updateRagDocument(request.documentId, { status: 'processing', errorMessage: undefined });

  try {
    const chunkCount = await indexDocumentContent({
      db,
      tenantDbName,
      tenantId,
      projectId,
      ragModule,
      chunkConfig: request.chunkConfig ?? chunkConfigFor(ragModule, doc),
      documentId: request.documentId,
      fileName: request.fileName ?? doc.fileName,
      text: textContent,
      metadata,
    });

    const now = new Date();
    // The whole source block is rewritten, not merged: an inline source that
    // outgrew the cap (or the reverse) has to leave the field it moved out of
    // empty, or the document would carry two disagreeing copies of itself.
    // Already committed above, before the destructive steps.
    const sourceFields = {};

    await db.updateRagDocument(request.documentId, {
      status: 'indexed',
      chunkCount,
      lastIndexedAt: now,
      fileName: request.fileName ?? doc.fileName,
      size: Buffer.byteLength(textContent, 'utf-8'),
      updatedBy: request.updatedBy,
      // Persisted so the next re-index reproduces these chunks rather than
      // silently reverting to the module's config.
      ...(request.chunkConfig ? { chunkConfig: request.chunkConfig } : {}),
      // Only when the caller supplied keys: the row and the vectors have to
      // agree on what this document is filterable by, and an untouched row
      // already does.
      ...(requested ? { metadata } : {}),
      ...sourceFields,
    });

    await db.incrementRagModuleTotals(String(ragModule._id), { chunks: chunkCount - oldChunkCount });

    logger.debug('Re-indexed document', {
      documentId: request.documentId,
      ragModuleKey: request.ragModuleKey,
      origin: source.origin,
      chunkCount,
    });

    return withoutInlineSource({
      ...doc,
      ...sourceFields,
      status: 'indexed' as const,
      chunkCount,
      lastIndexedAt: now,
      fileName: request.fileName ?? doc.fileName,
      ...(request.metadata ? { metadata } : {}),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Re-ingest failed';
    await db.updateRagDocument(request.documentId, {
      status: 'failed',
      errorMessage: msg,
    });
    throw error;
  }
}

/* ── Query logs ──────────────────────────────────────────────────────── */

export async function listRagQueryLogs(
  tenantDbName: string,
  ragModuleKey: string,
  options?: Parameters<DatabaseProvider['listRagQueryLogs']>[1],
): Promise<IRagQueryLog[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listRagQueryLogs(ragModuleKey, options);
}

export async function countRagQueryLogs(
  tenantDbName: string,
  ragModuleKey: string,
  options?: { from?: Date; to?: Date; projectId?: string },
): Promise<Awaited<ReturnType<DatabaseProvider['countRagQueryLogs']>>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.countRagQueryLogs(ragModuleKey, options);
}

/**
 * Distribution of best-score-per-query, so the minScore slider can be set
 * against what this module actually returns rather than guessed at.
 */
export async function aggregateRagQueryScoreDistribution(
  tenantDbName: string,
  ragModuleKey: string,
  options?: { from?: Date; to?: Date; projectId?: string },
): Promise<Array<{ bucket: string; count: number }>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.aggregateRagQueryScoreDistribution(ragModuleKey, options);
}

export { RagModuleInactiveError };
