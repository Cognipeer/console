import crypto from 'crypto';
import slugify from 'slugify';
import {
  getDatabase,
  type DatabaseProvider,
  type IMemoryStore,
  type IMemoryItem,
} from '@/lib/database';
import {
  upsertVectors,
  queryVectorIndex,
  deleteVectors,
  createVectorIndex,
} from '@/lib/services/vector/vectorService';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { createLogger } from '@/lib/core/logger';
import type {
  CreateMemoryStoreRequest,
  UpdateMemoryStoreRequest,
  AddMemoryRequest,
  UpdateMemoryRequest,
  MemorySearchRequest,
  MemorySearchResponse,
  MemorySearchMatch,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemoryStoreView,
} from './types';

const logger = createLogger('memory');

// ── Helpers ──────────────────────────────────────────────────────────────

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };

function generateStoreKey(name: string): string {
  const slug = slugify(name, SLUG_OPTIONS);
  return slug.length > 0 ? `mem-${slug}` : `mem-${Date.now()}`;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function getRecordId(record: { _id?: unknown }): string {
  if (!record._id) throw new Error('Record missing identifier.');
  return typeof record._id === 'string' ? record._id : String(record._id);
}

// ── Store operations ─────────────────────────────────────────────────────

export async function createMemoryStore(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  request: CreateMemoryStoreRequest,
): Promise<IMemoryStore> {
  const db = await withTenantDb(tenantDbName);

  // Validate embedding model exists
  const model = await db.findModelByKey(request.embeddingModelKey, projectId);
  if (!model) throw new Error('Embedding model not found.');
  if (model.category !== 'embedding') throw new Error('Model must be an embedding model.');

  // Validate vector provider exists
  const provider = await db.findProviderByKey(tenantId, request.vectorProviderKey, projectId);
  if (!provider) throw new Error('Vector provider not found.');
  if (provider.type !== 'vector') throw new Error('Provider must be a vector provider.');
  if (provider.status !== 'active') throw new Error('Vector provider is not active.');

  // Determine embedding dimension from model settings or default
  const embeddingDimension = request.config?.embeddingDimension
    ?? (model.settings?.dimensions as number | undefined)
    ?? 1536;

  const metric = request.config?.metric ?? 'cosine';

  const storeKey = generateStoreKey(request.name);

  // Check uniqueness
  const existing = await db.findMemoryStoreByKey(storeKey, projectId);
  if (existing) throw new Error(`Memory store with key "${storeKey}" already exists.`);

  // Create backing vector index
  const vectorIndex = await createVectorIndex(tenantDbName, tenantId, projectId, {
    providerKey: request.vectorProviderKey,
    name: `memory-${storeKey}`,
    dimension: embeddingDimension,
    metric: metric === 'dotproduct' ? 'cosine' : metric,
    metadata: { purpose: 'memory', storeKey },
    createdBy: request.createdBy,
  });

  const config = {
    embeddingDimension,
    metric,
    defaultScope: request.config?.defaultScope ?? 'global',
    deduplication: request.config?.deduplication ?? true,
    autoSummarize: request.config?.autoSummarize ?? false,
    maxMemories: request.config?.maxMemories,
    ttlDays: request.config?.ttlDays,
  };

  const store = await db.createMemoryStore({
    tenantId,
    projectId,
    key: storeKey,
    name: request.name,
    description: request.description,
    vectorProviderKey: request.vectorProviderKey,
    vectorIndexKey: vectorIndex.key,
    embeddingModelKey: request.embeddingModelKey,
    config,
    status: 'active',
    memoryCount: 0,
    createdBy: request.createdBy,
    updatedBy: request.createdBy,
  });

  return store;
}

export async function listMemoryStores(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  filters?: { status?: IMemoryStore['status']; search?: string },
): Promise<MemoryStoreView[]> {
  const db = await withTenantDb(tenantDbName);
  const stores = await db.listMemoryStores({
    projectId,
    ...filters,
  });
  return stores as MemoryStoreView[];
}

export async function getMemoryStore(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  storeKey: string,
): Promise<MemoryStoreView> {
  const db = await withTenantDb(tenantDbName);
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');
  return store as MemoryStoreView;
}

export async function updateMemoryStore(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  storeKey: string,
  updates: UpdateMemoryStoreRequest,
): Promise<IMemoryStore> {
  const db = await withTenantDb(tenantDbName);
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');

  const payload: Record<string, unknown> = { updatedBy: updates.updatedBy };
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.description !== undefined) payload.description = updates.description;
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.config) {
    payload.config = { ...store.config, ...updates.config };
  }

  const updated = await db.updateMemoryStore(getRecordId(store), payload);
  if (!updated) throw new Error('Failed to update memory store.');
  return updated;
}

export async function deleteMemoryStore(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');

  // Delete all memory items
  await db.deleteMemoryItems(storeKey);

  // Try to delete the backing vector index
  try {
    const { deleteVectorIndex } = await import('@/lib/services/vector/vectorService');
    await deleteVectorIndex(
      tenantDbName,
      tenantId,
      projectId,
      store.vectorProviderKey,
      store.vectorIndexKey,
    );
  } catch (err) {
    logger.warn('Failed to delete backing vector index', { error: err });
  }

  await db.deleteMemoryStore(getRecordId(store));
}

// ── Memory Item operations ───────────────────────────────────────────────

export async function addMemory(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  request: AddMemoryRequest,
): Promise<IMemoryItem> {
  const db = await withTenantDb(tenantDbName);
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');
  if (store.status !== 'active') throw new Error('Memory store is not active.');

  // Dedup check
  const contentHash = hashContent(request.content);
  if (store.config.deduplication) {
    const existing = await db.findMemoryItemByHash(storeKey, contentHash);
    if (existing) {
      // Update access and return existing
      await db.incrementMemoryAccess(getRecordId(existing));
      return existing;
    }
  }

  // Generate embedding
  const embeddingResponse = await handleEmbeddingRequest({
    tenantDbName,
    modelKey: store.embeddingModelKey,
    projectId,
    body: { input: [request.content] },
  });

  const embedding = embeddingResponse.response.data[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Failed to generate embedding for memory content.');
  }

  // Generate a unique vector ID
  const vectorId = `mem-${crypto.randomUUID()}`;

  // Upsert into vector DB
  await upsertVectors(tenantDbName, tenantId, projectId, {
    providerKey: store.vectorProviderKey,
    indexKey: store.vectorIndexKey,
    vectors: [
      {
        id: vectorId,
        values: embedding,
        metadata: {
          storeKey,
          scope: request.scope ?? store.config.defaultScope,
          scopeId: request.scopeId ?? '',
          source: request.source ?? 'api',
          tags: (request.tags ?? []).join(','),
          importance: request.importance ?? 0.5,
        },
      },
    ],
  });

  // Save to MongoDB
  const item = await db.createMemoryItem({
    tenantId,
    projectId,
    storeKey,
    content: request.content,
    contentHash,
    scope: request.scope ?? store.config.defaultScope,
    scopeId: request.scopeId,
    metadata: request.metadata ?? {},
    tags: request.tags ?? [],
    source: request.source ?? 'api',
    importance: request.importance ?? 0.5,
    accessCount: 0,
    embeddingVersion: store.embeddingModelKey,
    vectorId,
    status: 'active',
  });

  // Increment store counter
  await db.updateMemoryStore(getRecordId(store), {
    memoryCount: (store.memoryCount ?? 0) + 1,
    lastActivityAt: new Date(),
  });

  return item;
}

export async function addMemoryBatch(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  memories: AddMemoryRequest[],
): Promise<{ added: number; duplicates: number }> {
  let added = 0;
  let duplicates = 0;
  for (const mem of memories) {
    try {
      const db = await withTenantDb(tenantDbName);
      const hash = hashContent(mem.content);
      const existing = await db.findMemoryItemByHash(storeKey, hash);
      if (existing) {
        duplicates++;
        continue;
      }
      await addMemory(tenantDbName, tenantId, projectId, storeKey, mem);
      added++;
    } catch (err) {
      logger.error('Failed to add memory in batch', { error: err });
    }
  }
  return { added, duplicates };
}

export async function listMemoryItems(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  storeKey: string,
  filters?: {
    scope?: IMemoryItem['scope'];
    scopeId?: string;
    tags?: string[];
    status?: IMemoryItem['status'];
    search?: string;
    limit?: number;
    skip?: number;
  },
): Promise<{ items: IMemoryItem[]; total: number }> {
  const db = await withTenantDb(tenantDbName);
  return db.listMemoryItems(storeKey, { projectId, ...filters });
}

export async function getMemoryItem(
  tenantDbName: string,
  id: string,
): Promise<IMemoryItem> {
  const db = await withTenantDb(tenantDbName);
  const item = await db.findMemoryItemById(id);
  if (!item) throw new Error('Memory item not found.');
  await db.incrementMemoryAccess(id);
  return item;
}

export async function updateMemoryItem(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  memoryId: string,
  updates: UpdateMemoryRequest,
): Promise<IMemoryItem> {
  const db = await withTenantDb(tenantDbName);
  const item = await db.findMemoryItemById(memoryId);
  if (!item) throw new Error('Memory item not found.');

  const payload: Record<string, unknown> = {};
  if (updates.metadata !== undefined) payload.metadata = { ...item.metadata, ...updates.metadata };
  if (updates.tags !== undefined) payload.tags = updates.tags;
  if (updates.importance !== undefined) payload.importance = updates.importance;
  if (updates.status !== undefined) payload.status = updates.status;

  // If content changed, re-embed
  if (updates.content !== undefined && updates.content !== item.content) {
    payload.content = updates.content;
    payload.contentHash = hashContent(updates.content);

    const store = await db.findMemoryStoreByKey(storeKey, projectId);
    if (!store) throw new Error('Memory store not found.');

    const embeddingResponse = await handleEmbeddingRequest({
      tenantDbName,
      modelKey: store.embeddingModelKey,
      projectId,
      body: { input: [updates.content] },
    });
    const embedding = embeddingResponse.response.data[0]?.embedding;
    if (!embedding) throw new Error('Failed to generate embedding.');

    // Update vector
    await upsertVectors(tenantDbName, tenantId, projectId, {
      providerKey: store.vectorProviderKey,
      indexKey: store.vectorIndexKey,
      vectors: [{ id: item.vectorId, values: embedding, metadata: { storeKey } }],
    });
  }

  const updated = await db.updateMemoryItem(memoryId, payload);
  if (!updated) throw new Error('Failed to update memory item.');
  return updated;
}

export async function deleteMemoryItem(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  memoryId: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  const item = await db.findMemoryItemById(memoryId);
  if (!item) throw new Error('Memory item not found.');

  // Delete from vector DB
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (store) {
    try {
      await deleteVectors(tenantDbName, tenantId, projectId, {
        providerKey: store.vectorProviderKey,
        indexKey: store.vectorIndexKey,
        ids: [item.vectorId],
      });
    } catch (err) {
      logger.warn('Failed to remove vector', { error: err });
    }
    await db.updateMemoryStore(getRecordId(store), {
      memoryCount: Math.max((store.memoryCount ?? 1) - 1, 0),
      lastActivityAt: new Date(),
    });
  }

  await db.deleteMemoryItem(memoryId);
}

export async function deleteMemoryItemsBulk(
  tenantDbName: string,
  _tenantId: string,
  _projectId: string,
  storeKey: string,
  filter?: { scope?: IMemoryItem['scope']; scopeId?: string; tags?: string[]; before?: Date },
): Promise<number> {
  const db = await withTenantDb(tenantDbName);
  const deleted = await db.deleteMemoryItems(storeKey, filter);

  if (deleted > 0) {
    const store = await db.findMemoryStoreByKey(storeKey);
    if (store) {
      const newCount = await db.countMemoryItems(storeKey);
      await db.updateMemoryStore(getRecordId(store), {
        memoryCount: newCount,
        lastActivityAt: new Date(),
      });
    }
  }

  return deleted;
}

// ── Search & Recall ──────────────────────────────────────────────────────

export async function searchMemories(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  request: MemorySearchRequest,
): Promise<MemorySearchResponse> {
  const db = await withTenantDb(tenantDbName);
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');
  if (store.status !== 'active') throw new Error('Memory store is not active.');

  // Embed query
  const embeddingResponse = await handleEmbeddingRequest({
    tenantDbName,
    modelKey: store.embeddingModelKey,
    projectId,
    body: { input: [request.query] },
  });
  const queryVector = embeddingResponse.response.data[0]?.embedding;
  if (!queryVector) throw new Error('Failed to embed search query.');

  const topK = request.topK ?? 10;

  // Build vector filter
  const filter: Record<string, unknown> = {};
  if (request.scope) filter.scope = request.scope;
  if (request.scopeId) filter.scopeId = request.scopeId;

  // Query vector DB
  const queryResult = await queryVectorIndex(tenantDbName, tenantId, projectId, {
    providerKey: store.vectorProviderKey,
    indexKey: store.vectorIndexKey,
    query: {
      vector: queryVector,
      topK,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    },
  });

  const matches = queryResult.matches ?? [];
  const minScore = request.minScore ?? 0;

  // Pre-load all memory items for this store so we can match by vectorId efficiently
  const allItems = await db.listMemoryItems(storeKey, { projectId, limit: 1000 });
  const vectorIdMap = new Map<string, IMemoryItem>();
  for (const i of allItems.items) {
    if (i.vectorId) vectorIdMap.set(i.vectorId, i);
  }

  // Enrich with MongoDB data
  const memories: MemorySearchMatch[] = [];
  for (const match of matches) {
    if (match.score < minScore) continue;

    const memoryItem = vectorIdMap.get(match.id) ?? null;

    if (memoryItem) {
      await db.incrementMemoryAccess(getRecordId(memoryItem));
      memories.push({
        id: getRecordId(memoryItem),
        content: memoryItem.content,
        score: match.score,
        scope: memoryItem.scope,
        scopeId: memoryItem.scopeId,
        metadata: memoryItem.metadata,
        tags: memoryItem.tags,
        source: memoryItem.source,
        importance: memoryItem.importance,
        createdAt: memoryItem.createdAt,
      });
    } else {
      // Return from vector metadata if DB item not found
      memories.push({
        id: match.id,
        content: '',
        score: match.score,
        scope: (match.metadata?.scope as string as IMemoryItem['scope']) ?? 'global',
        scopeId: match.metadata?.scopeId as string,
        metadata: match.metadata ?? {},
        tags: ((match.metadata?.tags as string) ?? '').split(',').filter(Boolean),
        importance: (match.metadata?.importance as number) ?? 0.5,
      });
    }
  }

  // Filter by tags if specified
  const filteredMemories = request.tags?.length
    ? memories.filter((m) =>
        request.tags!.some((t) => m.tags.includes(t)),
      )
    : memories;

  return {
    memories: filteredMemories,
    query: request.query,
    storeKey,
  };
}

export async function recallForChat(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  request: MemoryRecallRequest,
): Promise<MemoryRecallResponse> {
  const searchResult = await searchMemories(
    tenantDbName,
    tenantId,
    projectId,
    storeKey,
    {
      query: request.query,
      topK: request.topK ?? 5,
      scope: request.scope,
      scopeId: request.scopeId,
      minScore: 0.3,
    },
  );

  // Build context string with token budget awareness
  const maxChars = (request.maxTokens ?? 2000) * 4; // rough char-to-token ratio
  let context = '';

  for (const memory of searchResult.memories) {
    const line = `- ${memory.content}\n`;
    if (context.length + line.length > maxChars) break;
    context += line;
  }

  return {
    context: context.trim(),
    memories: searchResult.memories,
    storeKey,
  };
}
