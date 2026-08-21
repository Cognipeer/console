/**
 * RAG Service
 *
 * Orchestrates file ingestion (chunk → embed → vector upsert) and
 * retrieval (query → embed → vector query) using existing services.
 */

import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import {
  VectorFilterError,
  collectFilterFields,
  parseVectorFilter,
} from '@/lib/providers';
import { getDatabase } from '@/lib/database';

const logger = createLogger('rag');
import type { IRagModule, IRagQueryLog, IRagChunk, IRagChunkConfig, IRagDocument } from '@/lib/database';
import { convertToMarkdown } from '@cognipeer/to-markdown';
import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import {
  queryVectorIndex,
  upsertVectors,
  deleteVectors,
} from '@/lib/services/vector/vectorService';
import { runReranker } from '@/lib/services/reranker';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { fireAndForget } from '@/lib/core/asyncTask';
import { chunkText, type ChunkContext } from './chunking';
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
): Promise<number[][]> {
  const result = await handleEmbeddingRequest({
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
async function indexDocumentContent(params: {
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
}): Promise<number> {
  const { db, tenantDbName, tenantId, projectId, ragModule, documentId, fileName } = params;

  const chunks = await chunkText(
    params.text,
    params.chunkConfig,
    buildChunkContext(tenantDbName, projectId ?? '', ragModule),
  );
  if (chunks.length === 0) return 0;

  const vectorIdFor = (index: number) => `${ragModule.key}:${documentId}:${index}`;
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
        id: vectorIdFor(chunk.index),
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
    await discardVectors(tenantDbName, tenantId, projectId, ragModule, vectors.map((v) => v.id));
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
    vectorId: vectorIdFor(chunk.index),
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
    await discardVectors(tenantDbName, tenantId, projectId, ragModule, vectors.map((v) => v.id));
    throw new Error(
      `Failed to persist chunk text for "${fileName}": ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  return chunks.length;
}

/** Best-effort cleanup of vectors written by a run that then failed. */
async function discardVectors(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  ragModule: IRagModule,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    await deleteVectors(tenantDbName, tenantId, projectId ?? '', {
      providerKey: ragModule.vectorProviderKey,
      indexKey: ragModule.vectorIndexKey,
      ids,
    });
  } catch (error) {
    logger.warn('Failed to roll back vectors after a failed index run', {
      ragModuleKey: ragModule.key,
      count: ids.length,
      error: error instanceof Error ? error.message : error,
    });
  }
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
 * expose. Modules that declare no `filterableFields` allow any key.
 */
function assertFilterFieldsAllowed(
  filter: unknown,
  filterableFields: string[] | undefined,
): void {
  if (!filterableFields || filterableFields.length === 0) return;
  const parsed = parseVectorFilter(filter);
  if (!parsed) return;

  const allowed = new Set(filterableFields);
  const rejected = [...collectFilterFields(parsed)].filter((field) => !allowed.has(field));

  if (rejected.length > 0) {
    throw new VectorFilterError(
      `Filtering on ${rejected.join(', ')} is not allowed for this Knowledge Engine module. `
      + `Filterable fields: ${filterableFields.join(', ')}.`,
    );
  }
}

/** Combine the module's standing filter with the per-request one. */
function mergeFilters(
  defaultFilter: Record<string, unknown> | undefined,
  requestFilter: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const hasDefault = defaultFilter && Object.keys(defaultFilter).length > 0;
  const hasRequest = requestFilter && Object.keys(requestFilter).length > 0;

  if (hasDefault && hasRequest) return { $and: [defaultFilter, requestFilter] };
  if (hasDefault) return defaultFilter;
  if (hasRequest) return requestFilter;
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
  updates.updatedBy = request.updatedBy;
  return db.updateRagModule(moduleId, updates as Partial<IRagModule>);
}

export async function deleteRagModule(
  tenantDbName: string,
  moduleId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
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

export async function listRagDocuments(
  tenantDbName: string,
  ragModuleKey: string,
  filters?: { projectId?: string; search?: string },
): Promise<RagDocument[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listRagDocuments(ragModuleKey, filters);
}

export async function getRagDocument(
  tenantDbName: string,
  documentId: string,
): Promise<RagDocument | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.findRagDocumentById(documentId);
}

/* ── Ingest (chunk → embed → upsert) ────────────────────────────────── */

export async function ingestDocument(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: RagIngestRequest,
): Promise<RagDocument> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found`);
  if (ragModule.status !== 'active') throw new Error('Knowledge Engine module is not active');

  // Create document record
  const docRecord = await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: request.ragModuleKey,
    fileName: request.fileName,
    contentType: request.contentType,
    size: Buffer.byteLength(request.content, 'utf-8'),
    status: 'processing',
    chunkConfig: request.chunkConfig,
    metadata: request.metadata,
    createdBy: request.createdBy,
  });

  const documentId = String(docRecord._id);

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
      metadata: request.metadata,
    });

    const lastIndexedAt = new Date();
    await db.updateRagDocument(documentId, {
      status: 'indexed',
      chunkCount,
      lastIndexedAt,
    });

    await db.updateRagModule(String(ragModule._id), {
      totalDocuments: (ragModule.totalDocuments ?? 0) + 1,
      totalChunks: (ragModule.totalChunks ?? 0) + chunkCount,
    } as Partial<IRagModule>);

    return { ...docRecord, status: 'indexed' as const, chunkCount, lastIndexedAt };
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Ingestion failed';
    await db.updateRagDocument(documentId, {
      status: 'failed',
      errorMessage: msg,
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

/**
 * Ingest a file into a Knowledge Engine module.
 * Converts the file to markdown/text using @cognipeer/to-markdown, then
 * delegates to ingestDocument for chunking + embedding + vector upsert.
 */
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
  const isPlainText = (
    contentType?.startsWith('text/') ||
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.csv') ||
    fileName.endsWith('.json') ||
    fileName.endsWith('.xml') ||
    fileName.endsWith('.html') ||
    fileName.endsWith('.htm')
  );
  if (isPlainText) return fileData.toString('utf-8');
  const conversion = await convertToMarkdown(fileData, { fileName });
  const markdown = extractMarkdownContent(conversion);
  if (!markdown || markdown.trim().length === 0) {
    throw new Error(
      `Failed to convert "${fileName}" to text. The file format may not be supported.`,
    );
  }
  return markdown;
}

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
    createdBy: string;
  },
): Promise<RagDocument> {
  // 1. Convert file buffer to markdown/text
  let textContent: string;

  const isPlainText = (
    request.contentType?.startsWith('text/') ||
    request.fileName.endsWith('.txt') ||
    request.fileName.endsWith('.md') ||
    request.fileName.endsWith('.csv') ||
    request.fileName.endsWith('.json') ||
    request.fileName.endsWith('.xml') ||
    request.fileName.endsWith('.html') ||
    request.fileName.endsWith('.htm')
  );

  if (isPlainText) {
    // For text-based files, read directly as UTF-8
    textContent = request.fileData.toString('utf-8');
  } else {
    // For binary files (PDF, DOCX, etc.), use to-markdown converter
    try {
      const conversion = await convertToMarkdown(request.fileData, {
        fileName: request.fileName,
      });
      const markdown = extractMarkdownContent(conversion);
      if (!markdown || markdown.trim().length === 0) {
        throw new Error(
          `Failed to convert "${request.fileName}" to text. The file format may not be supported.`,
        );
      }
      textContent = markdown;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to convert')) {
        throw error;
      }
      throw new Error(
        `File conversion failed for "${request.fileName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  // 2. Delegate to ingestDocument with the extracted text
  return ingestDocument(tenantDbName, tenantId, projectId, {
    ragModuleKey: request.ragModuleKey,
    fileName: request.fileName,
    content: textContent,
    contentType: request.contentType,
    chunkConfig: request.chunkConfig,
    metadata: {
      ...request.metadata,
      _sourceType: isPlainText ? 'text' : 'converted',
    },
    createdBy: request.createdBy,
  });
}

/* ── Query (embed → vector search) ───────────────────────────────────── */

export async function queryRag(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: RagQueryRequest,
): Promise<RagQueryResult> {
  const startTime = Date.now();
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found`);

  // 1. Embed the query
  const embeddingStartedAt = Date.now();
  const [queryEmbedding] = await getEmbeddings(
    tenantDbName,
    projectId ?? '',
    ragModule.embeddingModelKey,
    [request.query],
  );
  const embeddingMs = Date.now() - embeddingStartedAt;

  // 2. Build the metadata filter: the module's standing filter ANDed with the
  //    caller's, after validating the request filter and checking it only
  //    touches fields the module exposes.
  validateFilterDocument(request.filter, 'Invalid filter');
  assertFilterFieldsAllowed(request.filter, ragModule.filterableFields);
  const filter = mergeFilters(ragModule.defaultFilter, request.filter);

  // 3. Query vector store. If reranker is configured, oversample candidates
  //    so the reranker has more to work with.
  const topK = request.topK ?? ragModule.defaultTopK ?? 5;
  const minScore = request.minScore ?? ragModule.defaultMinScore;
  const useReranker = Boolean(ragModule.rerankerKey);
  const oversampleMultiplier = ragModule.rerankerOversample ?? 3;
  const fetchTopK = useReranker ? Math.max(topK, topK * oversampleMultiplier) : topK;

  const vectorStartedAt = Date.now();
  const vectorResult = await queryVectorIndex(tenantDbName, tenantId, projectId ?? '', {
    providerKey: ragModule.vectorProviderKey,
    indexKey: ragModule.vectorIndexKey,
    query: {
      vector: queryEmbedding,
      topK: fetchTopK,
      filter,
    },
  });

  // Time spent in the vector store alone. This used to be measured from the
  // very start of the request, which hid where the time actually went.
  const vectorLatencyMs = Date.now() - vectorStartedAt;

  // 4. Hydrate chunk content from MongoDB
  const hydrateStartedAt = Date.now();
  const vectorIds = vectorResult.matches.map((m) => m.id).filter(Boolean);
  let chunkContentMap: Map<string, string> = new Map();
  if (vectorIds.length > 0) {
    try {
      const storedChunks = await db.findRagChunksByVectorIds(vectorIds);
      chunkContentMap = new Map(storedChunks.map((c) => [c.vectorId, c.content]));
    } catch (err) {
      logger.warn('Failed to hydrate chunk content from MongoDB', { error: err });
    }
  }
  const hydrateLatencyMs = Date.now() - hydrateStartedAt;

  // 5. Map results
  let matches: RagQueryMatch[] = vectorResult.matches.map((m) => ({
    id: m.id,
    score: m.score,
    content: chunkContentMap.get(m.id) ?? resolveMetadataContent(m.metadata),
    metadata: m.metadata,
    documentId: typeof m.metadata?._documentId === 'string' ? m.metadata._documentId : undefined,
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

  // 5c. Apply minimum score threshold, if configured.
  if (typeof minScore === 'number' && minScore > 0) {
    matches = matches.filter((m) => (m.score ?? 0) >= minScore);
  }

  // 5d. Apply final topK (in case reranker skipped or returned more).
  matches = matches.slice(0, topK);

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
      latencyMs,
      metadata: {
        embeddingMs,
        vectorLatencyMs,
        ...(useReranker ? {
          reranked: true,
          rerankerKey: ragModule.rerankerKey,
          rerankLatencyMs,
        } : {}),
        ...(typeof minScore === 'number' ? { minScore } : {}),
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
  };
}

/**
 * Applies a module's `responseDetail` setting to a query result, producing the
 * JSON payload the public query endpoints return. 'text' strips everything but
 * the chunk text; 'full' (default) is the complete match.
 */
export function shapeRagQueryResponse(result: RagQueryResult): Record<string, unknown> {
  const { responseDetail, matches, ...rest } = result;
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

  // Build vector IDs to delete (pattern: moduleKey:docId:chunkIndex)
  const chunkCount = doc.chunkCount ?? 0;
  if (chunkCount > 0) {
    const ids: string[] = [];
    for (let i = 0; i < chunkCount; i++) {
      ids.push(`${request.ragModuleKey}:${request.documentId}:${i}`);
    }

    try {
      await deleteVectors(tenantDbName, tenantId, projectId ?? '', {
        providerKey: ragModule.vectorProviderKey,
        indexKey: ragModule.vectorIndexKey,
        ids,
      });
    } catch (err) {
      logger.warn('Failed to delete vectors for document', { error: err });
    }
  }

  // Delete chunk content from MongoDB
  try {
    await db.deleteRagChunksByDocumentId(request.documentId);
  } catch (err) {
    logger.warn('Failed to delete MongoDB chunks for document', { error: err });
  }

  // Update module stats
  await db.updateRagModule(String(ragModule._id), {
    totalDocuments: Math.max(0, (ragModule.totalDocuments ?? 0) - 1),
    totalChunks: Math.max(0, (ragModule.totalChunks ?? 0) - chunkCount),
  } as Partial<IRagModule>);

  return db.deleteRagDocument(request.documentId);
}

/* ── Re-ingest document ───────────────────────────────────────────────── */

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
    updatedBy: string;
  },
): Promise<RagDocument> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found`);
  if (ragModule.status !== 'active') throw new Error('Knowledge Engine module is not active');

  const doc = await db.findRagDocumentById(request.documentId);
  if (!doc) throw new Error('Document not found');

  // Resolve text content from either direct content or file conversion
  let textContent: string;
  if (request.content) {
    textContent = request.content;
  } else if (request.fileData) {
    const fName = request.fileName ?? doc.fileName;
    const isPlainText = (
      request.contentType?.startsWith('text/') ||
      fName.endsWith('.txt') || fName.endsWith('.md') ||
      fName.endsWith('.csv') || fName.endsWith('.json') ||
      fName.endsWith('.xml') || fName.endsWith('.html') || fName.endsWith('.htm')
    );
    if (isPlainText) {
      textContent = request.fileData.toString('utf-8');
    } else {
      const conversion = await convertToMarkdown(request.fileData, { fileName: fName });
      const markdown = extractMarkdownContent(conversion);
      if (!markdown || markdown.trim().length === 0) {
        throw new Error(`Failed to convert "${fName}" to text.`);
      }
      textContent = markdown;
    }
  } else {
    // Reconstruct from existing MongoDB chunks as a fallback
    const existingChunks = await db.findRagChunksByDocumentId(request.documentId);
    if (existingChunks.length === 0) {
      throw new Error('No content provided and no existing chunks found for re-ingest');
    }
    textContent = existingChunks.map((c) => c.content).join('\n');
  }

  // 1. Delete old vectors
  const oldChunkCount = doc.chunkCount ?? 0;
  if (oldChunkCount > 0) {
    const ids: string[] = [];
    for (let i = 0; i < oldChunkCount; i++) {
      ids.push(`${request.ragModuleKey}:${request.documentId}:${i}`);
    }
    try {
      await deleteVectors(tenantDbName, tenantId, projectId ?? '', {
        providerKey: ragModule.vectorProviderKey,
        indexKey: ragModule.vectorIndexKey,
        ids,
      });
    } catch (err) {
      logger.warn('Reingest: failed to delete old vectors', { error: err });
    }
  }

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
      chunkConfig: chunkConfigFor(ragModule, doc),
      documentId: request.documentId,
      fileName: request.fileName ?? doc.fileName,
      text: textContent,
      metadata: request.metadata,
    });

    const now = new Date();
    await db.updateRagDocument(request.documentId, {
      status: 'indexed',
      chunkCount,
      lastIndexedAt: now,
      fileName: request.fileName ?? doc.fileName,
      size: Buffer.byteLength(textContent, 'utf-8'),
      updatedBy: request.updatedBy,
    });

    await db.updateRagModule(String(ragModule._id), {
      totalChunks: Math.max(0, (ragModule.totalChunks ?? 0) - oldChunkCount + chunkCount),
    } as Partial<IRagModule>);

    return {
      ...doc,
      status: 'indexed' as const,
      chunkCount,
      lastIndexedAt: now,
      fileName: request.fileName ?? doc.fileName,
    };
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
  options?: { limit?: number; from?: Date; to?: Date },
): Promise<IRagQueryLog[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.listRagQueryLogs(ragModuleKey, options);
}

export async function countRagQueryLogs(
  tenantDbName: string,
  ragModuleKey: string,
  options?: { from?: Date; to?: Date },
): Promise<{ total: number; avgLatencyMs: number }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.countRagQueryLogs(ragModuleKey, options);
}
