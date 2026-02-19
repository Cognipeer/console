/**
 * RAG Service
 *
 * Orchestrates file ingestion (chunk → embed → vector upsert) and
 * retrieval (query → embed → vector query) using existing services.
 */

import crypto from 'crypto';
import { getDatabase } from '@/lib/database';
import type { IRagModule, IRagQueryLog, IRagChunk } from '@/lib/database';
import { convertToMarkdown } from '@cognipeer/to-markdown';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import {
  queryVectorIndex,
  upsertVectors,
  deleteVectors,
} from '@/lib/services/vector/vectorService';
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

interface ChunkResult {
  content: string;
  index: number;
  metadata: Record<string, unknown>;
}

function chunkRecursiveCharacter(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  separators: string[] = ['\n\n', '\n', '. ', ' ', ''],
): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  const parts = splitBySeparators(text, separators);
  let currentChunk = '';
  let chunkIndex = 0;

  for (const part of parts) {
    if (currentChunk.length + part.length > chunkSize && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.trim(),
        index: chunkIndex,
        metadata: { chunkIndex, chunkSize: currentChunk.trim().length },
      });
      chunkIndex++;
      // Apply overlap
      if (chunkOverlap > 0 && currentChunk.length > chunkOverlap) {
        currentChunk = currentChunk.slice(-chunkOverlap) + part;
      } else {
        currentChunk = part;
      }
    } else {
      currentChunk += part;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      index: chunkIndex,
      metadata: { chunkIndex, chunkSize: currentChunk.trim().length },
    });
  }

  return chunks;
}

function splitBySeparators(text: string, separators: string[]): string[] {
  if (separators.length === 0 || !separators[0]) return [text];
  const sep = separators[0];
  const remaining = separators.slice(1);
  const segments = text.split(sep);

  if (remaining.length === 0) return segments;

  const result: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    result.push(...splitBySeparators(segment, remaining));
  }
  return result;
}

function chunkToken(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
): ChunkResult[] {
  // Simple whitespace-based token splitter
  const tokens = text.split(/\s+/);
  const chunks: ChunkResult[] = [];
  let chunkIndex = 0;
  let start = 0;

  while (start < tokens.length) {
    const end = Math.min(start + chunkSize, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    const content = chunkTokens.join(' ').trim();
    if (content.length > 0) {
      chunks.push({
        content,
        index: chunkIndex,
        metadata: { chunkIndex, tokenCount: chunkTokens.length },
      });
      chunkIndex++;
    }
    start = end - chunkOverlap;
    if (start >= end) start = end;
  }

  return chunks;
}

function chunkText(
  text: string,
  config: IRagModule['chunkConfig'],
): ChunkResult[] {
  switch (config.strategy) {
    case 'recursive_character':
      return chunkRecursiveCharacter(
        text,
        config.chunkSize,
        config.chunkOverlap,
        config.separators,
      );
    case 'token':
      return chunkToken(text, config.chunkSize, config.chunkOverlap);
    default:
      return chunkRecursiveCharacter(text, config.chunkSize, config.chunkOverlap);
  }
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

  // Check uniqueness
  const existing = await db.findRagModuleByKey(key, projectId);
  if (existing) {
    throw new Error(`RAG module with key "${key}" already exists`);
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
  if (request.chunkConfig !== undefined) updates.chunkConfig = request.chunkConfig;
  if (request.status !== undefined) updates.status = request.status;
  if (request.metadata !== undefined) updates.metadata = request.metadata;
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
  if (!ragModule) throw new Error(`RAG module "${request.ragModuleKey}" not found`);
  if (ragModule.status !== 'active') throw new Error('RAG module is not active');

  // Create document record
  const docRecord = await db.createRagDocument({
    tenantId,
    projectId,
    ragModuleKey: request.ragModuleKey,
    fileName: request.fileName,
    contentType: request.contentType,
    size: Buffer.byteLength(request.content, 'utf-8'),
    status: 'processing',
    metadata: request.metadata,
    createdBy: request.createdBy,
  });

  const documentId = String(docRecord._id);

  try {
    // 1. Chunk
    const chunks = chunkText(request.content, ragModule.chunkConfig);
    if (chunks.length === 0) {
      await db.updateRagDocument(documentId, { status: 'indexed', chunkCount: 0 });
      return { ...docRecord, status: 'indexed', chunkCount: 0 };
    }

    // 2. Embed (batch)
    const batchSize = 32;
    const allVectors: Array<{
      id: string;
      values: number[];
      metadata: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await getEmbeddings(
        tenantDbName,
        projectId ?? '',
        ragModule.embeddingModelKey,
        texts,
      );

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const vectorId = `${request.ragModuleKey}:${documentId}:${chunk.index}`;
        allVectors.push({
          id: vectorId,
          values: embeddings[j],
          metadata: {
            _ragModule: request.ragModuleKey,
            _documentId: documentId,
            _fileName: request.fileName,
            _chunkIndex: chunk.index,
            ...chunk.metadata,
            ...(request.metadata ?? {}),
          },
        });
      }
    }

    // 3. Upsert to vector store
    await upsertVectors(tenantDbName, tenantId, projectId ?? '', {
      providerKey: ragModule.vectorProviderKey,
      indexKey: ragModule.vectorIndexKey,
      vectors: allVectors,
    });

    // 3b. Store chunk content in MongoDB (avoids vector metadata size limits)
    const chunkRecords: Omit<IRagChunk, '_id' | 'createdAt'>[] = chunks.map((chunk) => ({
      tenantId,
      projectId,
      ragModuleKey: request.ragModuleKey,
      documentId,
      chunkIndex: chunk.index,
      vectorId: `${request.ragModuleKey}:${documentId}:${chunk.index}`,
      content: chunk.content,
      metadata: { ...chunk.metadata, ...(request.metadata ?? {}) },
    }));
    try {
      await db.bulkInsertRagChunks(chunkRecords as IRagChunk[]);
    } catch (chunkErr) {
      console.warn('[rag] Failed to persist chunk content to MongoDB', chunkErr);
    }

    // 4. Update document and module stats
    await db.updateRagDocument(documentId, {
      status: 'indexed',
      chunkCount: chunks.length,
      lastIndexedAt: new Date(),
    });

    await db.updateRagModule(String(ragModule._id), {
      totalDocuments: (ragModule.totalDocuments ?? 0) + 1,
      totalChunks: (ragModule.totalChunks ?? 0) + chunks.length,
    } as Partial<IRagModule>);

    return {
      ...docRecord,
      status: 'indexed' as const,
      chunkCount: chunks.length,
      lastIndexedAt: new Date(),
    };
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
 * Ingest a file into a RAG module.
 * Converts the file to markdown/text using @cognipeer/to-markdown, then
 * delegates to ingestDocument for chunking + embedding + vector upsert.
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
  if (!ragModule) throw new Error(`RAG module "${request.ragModuleKey}" not found`);

  // 1. Embed the query
  const [queryEmbedding] = await getEmbeddings(
    tenantDbName,
    projectId ?? '',
    ragModule.embeddingModelKey,
    [request.query],
  );

  // 2. Build filter — only include user-supplied filters; each module
  //    already uses a dedicated vector index so no module-level filter needed.
  const filter = request.filter && Object.keys(request.filter).length > 0
    ? request.filter
    : undefined;

  // 3. Query vector store
  const topK = request.topK ?? 5;
  const vectorResult = await queryVectorIndex(tenantDbName, tenantId, projectId ?? '', {
    providerKey: ragModule.vectorProviderKey,
    indexKey: ragModule.vectorIndexKey,
    query: {
      vector: queryEmbedding,
      topK,
      filter,
    },
  });

  const latencyMs = Date.now() - startTime;

  // 4. Hydrate chunk content from MongoDB
  const vectorIds = vectorResult.matches.map((m) => m.id).filter(Boolean);
  let chunkContentMap: Map<string, string> = new Map();
  if (vectorIds.length > 0) {
    try {
      const storedChunks = await db.findRagChunksByVectorIds(vectorIds);
      chunkContentMap = new Map(storedChunks.map((c) => [c.vectorId, c.content]));
    } catch (err) {
      console.warn('[rag] Failed to hydrate chunk content from MongoDB', err);
    }
  }

  // 5. Map results
  const matches: RagQueryMatch[] = vectorResult.matches.map((m) => ({
    id: m.id,
    score: m.score,
    content: chunkContentMap.get(m.id) ?? (typeof m.metadata?._content === 'string' ? m.metadata._content : undefined),
    metadata: m.metadata,
    documentId: typeof m.metadata?._documentId === 'string' ? m.metadata._documentId : undefined,
    fileName: typeof m.metadata?._fileName === 'string' ? m.metadata._fileName : undefined,
    chunkIndex: typeof m.metadata?._chunkIndex === 'number' ? m.metadata._chunkIndex : undefined,
  }));

  // 6. Log the query
  try {
    await db.createRagQueryLog({
      tenantId,
      projectId,
      ragModuleKey: request.ragModuleKey,
      query: request.query,
      topK,
      matchCount: matches.length,
      latencyMs,
    });
  } catch (err) {
    console.warn('[rag] Failed to log query', err);
  }

  return {
    matches,
    query: request.query,
    ragModuleKey: request.ragModuleKey,
    latencyMs,
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
  if (!ragModule) throw new Error(`RAG module "${request.ragModuleKey}" not found`);

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
      console.warn('[rag] Failed to delete vectors for document', err);
    }
  }

  // Delete chunk content from MongoDB
  try {
    await db.deleteRagChunksByDocumentId(request.documentId);
  } catch (err) {
    console.warn('[rag] Failed to delete MongoDB chunks for document', err);
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
  if (!ragModule) throw new Error(`RAG module "${request.ragModuleKey}" not found`);
  if (ragModule.status !== 'active') throw new Error('RAG module is not active');

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
      console.warn('[rag] reingest: failed to delete old vectors', err);
    }
  }

  // 2. Delete old MongoDB chunks
  try {
    await db.deleteRagChunksByDocumentId(request.documentId);
  } catch (err) {
    console.warn('[rag] reingest: failed to delete old MongoDB chunks', err);
  }

  // Mark document as processing
  await db.updateRagDocument(request.documentId, { status: 'processing', errorMessage: undefined });

  try {
    // 3. Chunk
    const chunks = chunkText(textContent, ragModule.chunkConfig);
    if (chunks.length === 0) {
      await db.updateRagDocument(request.documentId, { status: 'indexed', chunkCount: 0 });
      // Adjust module stats
      await db.updateRagModule(String(ragModule._id), {
        totalChunks: Math.max(0, (ragModule.totalChunks ?? 0) - oldChunkCount),
      } as Partial<IRagModule>);
      return { ...doc, status: 'indexed' as const, chunkCount: 0 };
    }

    // 4. Embed (batch)
    const batchSize = 32;
    const allVectors: Array<{
      id: string;
      values: number[];
      metadata: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map((c) => c.content);
      const embeddings = await getEmbeddings(
        tenantDbName,
        projectId ?? '',
        ragModule.embeddingModelKey,
        texts,
      );

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const vectorId = `${request.ragModuleKey}:${request.documentId}:${chunk.index}`;
        allVectors.push({
          id: vectorId,
          values: embeddings[j],
          metadata: {
            _ragModule: request.ragModuleKey,
            _documentId: request.documentId,
            _fileName: request.fileName ?? doc.fileName,
            _chunkIndex: chunk.index,
            ...chunk.metadata,
            ...(request.metadata ?? {}),
          },
        });
      }
    }

    // 5. Upsert to vector store
    await upsertVectors(tenantDbName, tenantId, projectId ?? '', {
      providerKey: ragModule.vectorProviderKey,
      indexKey: ragModule.vectorIndexKey,
      vectors: allVectors,
    });

    // 5b. Store chunk content in MongoDB
    const chunkRecords: Omit<IRagChunk, '_id' | 'createdAt'>[] = chunks.map((chunk) => ({
      tenantId,
      projectId,
      ragModuleKey: request.ragModuleKey,
      documentId: request.documentId,
      chunkIndex: chunk.index,
      vectorId: `${request.ragModuleKey}:${request.documentId}:${chunk.index}`,
      content: chunk.content,
      metadata: { ...chunk.metadata, ...(request.metadata ?? {}) },
    }));
    try {
      await db.bulkInsertRagChunks(chunkRecords as IRagChunk[]);
    } catch (chunkErr) {
      console.warn('[rag] reingest: Failed to persist chunks to MongoDB', chunkErr);
    }

    // 6. Update document and module stats
    const now = new Date();
    await db.updateRagDocument(request.documentId, {
      status: 'indexed',
      chunkCount: chunks.length,
      lastIndexedAt: now,
      fileName: request.fileName ?? doc.fileName,
      size: Buffer.byteLength(textContent, 'utf-8'),
      updatedBy: request.updatedBy,
    });

    // Adjust module chunk totals
    await db.updateRagModule(String(ragModule._id), {
      totalChunks: Math.max(0, (ragModule.totalChunks ?? 0) - oldChunkCount + chunks.length),
    } as Partial<IRagModule>);

    return {
      ...doc,
      status: 'indexed' as const,
      chunkCount: chunks.length,
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
