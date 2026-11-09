import { enforceServiceQuota, type ServiceCallOptions } from '@/lib/quota/serviceQuota';
import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
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

/**
 * The metadata a memory's vector carries. Searches filter on scope and scopeId
 * here, so every upsert writes all of it: an upsert replaces the metadata.
 */
function vectorMetadata(
  storeKey: string,
  item: Pick<IMemoryItem, 'scope' | 'scopeId' | 'source' | 'tags' | 'importance'>,
): Record<string, unknown> {
  return {
    storeKey,
    scope: item.scope,
    scopeId: item.scopeId ?? '',
    source: item.source ?? 'api',
    tags: (item.tags ?? []).join(','),
    importance: item.importance ?? 0.5,
  };
}

/** When a memory written now expires under the store's `ttlDays`; undefined when the store sets none. */
function expiresAtFor(store: IMemoryStore, from: Date = new Date()): Date | undefined {
  const days = store.config?.ttlDays;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return undefined;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function isExpired(item: Pick<IMemoryItem, 'expiresAt'>, now: Date): boolean {
  if (!item.expiresAt) return false;
  return new Date(item.expiresAt).getTime() <= now.getTime();
}

/** Raised when a store already holds its `maxMemories`; routes answer it with a 409. */
export class MemoryStoreFullError extends Error {
  readonly statusCode = 409;
  constructor(storeKey: string, maxMemories: number) {
    super(`Memory store "${storeKey}" is full (maxMemories: ${maxMemories}).`);
    this.name = 'MemoryStoreFullError';
  }
}

/**
 * Resolve a memory item by id within the store and project the caller addressed.
 *
 * findMemoryItemById is scoped only by the tenant database, so an id taken from
 * the URL would otherwise reach any project's item in the same tenant. Returns
 * null for an out-of-scope id so callers report it exactly as they report a
 * missing one and the route is not an existence oracle. Items written before
 * project stamping carry no projectId and stay reachable.
 */
async function findMemoryItemInScope(
  db: DatabaseProvider,
  storeKey: string,
  memoryId: string,
  projectId: string,
): Promise<IMemoryItem | null> {
  const item = await db.findMemoryItemById(memoryId);
  if (!item) return null;
  if (item.storeKey !== storeKey) return null;
  if (!item.projectId) return item;
  return String(item.projectId) === String(projectId) ? item : null;
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

/** Raised for a store update the caller got wrong; routes answer it with a 400. */
export class MemoryStoreInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'MemoryStoreInputError';
  }
}

/** The statuses an operator may set; 'error' is only ever recorded by the system. */
const SETTABLE_STORE_STATUSES = new Set(['active', 'inactive']);

export async function updateMemoryStore(
  tenantDbName: string,
  _tenantId: string,
  projectId: string,
  storeKey: string,
  updates: UpdateMemoryStoreRequest,
): Promise<IMemoryStore> {
  if (updates.status !== undefined && !SETTABLE_STORE_STATUSES.has(updates.status as string)) {
    throw new MemoryStoreInputError('status must be "active" or "inactive"');
  }
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

  // Delete all memory items. Another project may have a store with the same key.
  await db.deleteMemoryItems(storeKey, { projectId });

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
  options: ServiceCallOptions = {},
): Promise<IMemoryItem> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'memory');
  if (options.quota !== false) {
    await enforceServiceQuota(
      { tenantDbName, tenantId, projectId },
      { domain: 'memory', resourceKey: storeKey, cost: { requests: 1 } },
    );
  }
  return addMemoryUnchecked(tenantDbName, tenantId, projectId, storeKey, request);
}

/** `addMemory` without the quota check, for a batch that counted the call once. */
async function addMemoryUnchecked(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  request: AddMemoryRequest,
): Promise<IMemoryItem> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'memory');
  const db = await withTenantDb(tenantDbName);
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');
  if (store.status !== 'active') throw new Error('Memory store is not active.');

  // Dedup check
  const contentHash = hashContent(request.content);
  if (store.config.deduplication) {
    const existing = await db.findMemoryItemByHash(storeKey, contentHash, projectId);
    if (existing) {
      if (isExpired(existing, new Date())) {
        // Search and recall hide an expired item, so answering with it would lose the fact:
        // the same content gets a fresh expiry (its vector is still in the index).
        const expiresAt = expiresAtFor(store);
        const renewed = await db.updateMemoryItem(getRecordId(existing), { expiresAt });
        if (renewed) return renewed;
      } else {
        // Update access and return existing
        await db.incrementMemoryAccess(getRecordId(existing));
        return existing;
      }
    }
  }

  const maxMemories = store.config.maxMemories;
  if (typeof maxMemories === 'number' && maxMemories > 0) {
    // Expired memories are not visible to anyone, so they do not take a place in the store.
    const { total } = await db.listMemoryItems(storeKey, { projectId, notExpiredAt: new Date(), limit: 1 });
    if (total >= maxMemories) throw new MemoryStoreFullError(storeKey, maxMemories);
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
  const scope = request.scope ?? store.config.defaultScope;

  // Upsert into vector DB
  await upsertVectors(tenantDbName, tenantId, projectId, {
    providerKey: store.vectorProviderKey,
    indexKey: store.vectorIndexKey,
    vectors: [
      {
        id: vectorId,
        values: embedding,
        metadata: vectorMetadata(storeKey, {
          scope,
          scopeId: request.scopeId,
          source: request.source ?? 'api',
          tags: request.tags ?? [],
          importance: request.importance ?? 0.5,
        }),
      },
    ],
  });

  const expiresAt = expiresAtFor(store);

  // Save to MongoDB
  const item = await db.createMemoryItem({
    tenantId,
    projectId,
    storeKey,
    content: request.content,
    contentHash,
    scope,
    scopeId: request.scopeId,
    metadata: request.metadata ?? {},
    tags: request.tags ?? [],
    source: request.source ?? 'api',
    importance: request.importance ?? 0.5,
    accessCount: 0,
    embeddingVersion: store.embeddingModelKey,
    vectorId,
    ...(expiresAt ? { expiresAt } : {}),
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
): Promise<{ added: number; duplicates: number; failed: number }> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'memory');
  await enforceServiceQuota(
    { tenantDbName, tenantId, projectId },
    { domain: 'memory', resourceKey: storeKey, cost: { requests: 1 } },
  );
  const db = await withTenantDb(tenantDbName);
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');
  if (store.status !== 'active') throw new Error('Memory store is not active.');

  let added = 0;
  let duplicates = 0;
  let failed = 0;
  let firstError: unknown;
  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    try {
      if (store.config.deduplication) {
        const existing = await db.findMemoryItemByHash(storeKey, hashContent(mem.content), projectId);
        if (existing && !isExpired(existing, new Date())) {
          duplicates++;
          continue;
        }
      }
      await addMemoryUnchecked(tenantDbName, tenantId, projectId, storeKey, mem);
      added++;
    } catch (err) {
      logger.error('Failed to add memory in batch', { error: err });
      failed++;
      firstError ??= err;
      if (err instanceof MemoryStoreFullError) {
        // Nothing after this one fits either.
        failed += memories.length - i - 1;
        break;
      }
    }
  }
  // Nothing went in and nothing was already there: answer with the error, as the single add does.
  if (added === 0 && duplicates === 0 && failed > 0) throw firstError;
  return { added, duplicates, failed };
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
    /** Leaves out items whose store TTL ran out by this moment. */
    notExpiredAt?: Date;
    limit?: number;
    skip?: number;
  },
): Promise<{ items: IMemoryItem[]; total: number }> {
  const db = await withTenantDb(tenantDbName);
  return db.listMemoryItems(storeKey, { projectId, ...filters });
}

/** Raised for a memory id that is not in the addressed store and project; routes answer it with a 404. */
export class MemoryItemNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() {
    super('Memory item not found.');
    this.name = 'MemoryItemNotFoundError';
  }
}

export async function getMemoryItem(
  tenantDbName: string,
  projectId: string,
  storeKey: string,
  id: string,
): Promise<IMemoryItem> {
  const db = await withTenantDb(tenantDbName);
  const item = await findMemoryItemInScope(db, storeKey, id, projectId);
  if (!item) throw new MemoryItemNotFoundError();
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
  const item = await findMemoryItemInScope(db, storeKey, memoryId, projectId);
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

    // The upsert replaces the vector's metadata, so it carries all of it again:
    // with only the store key left, scoped searches no longer found the item.
    await upsertVectors(tenantDbName, tenantId, projectId, {
      providerKey: store.vectorProviderKey,
      indexKey: store.vectorIndexKey,
      vectors: [{
        id: item.vectorId,
        values: embedding,
        metadata: vectorMetadata(storeKey, {
          scope: item.scope,
          scopeId: item.scopeId,
          source: item.source,
          tags: updates.tags ?? item.tags,
          importance: updates.importance ?? item.importance,
        }),
      }],
    });

    // New content is a fresh memory as far as the store's TTL goes.
    const expiresAt = expiresAtFor(store);
    if (expiresAt) payload.expiresAt = expiresAt;
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
  const item = await findMemoryItemInScope(db, storeKey, memoryId, projectId);
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

const VECTOR_LIST_PAGE = 500;
const VECTOR_DELETE_CHUNK = 100;

/** The vector ids of the items a bulk delete with this filter removes. */
async function collectVectorIds(
  db: Awaited<ReturnType<typeof withTenantDb>>,
  storeKey: string,
  projectId: string,
  filter?: { scope?: IMemoryItem['scope']; scopeId?: string; tags?: string[]; before?: Date },
): Promise<string[]> {
  const before = filter?.before ? new Date(filter.before).getTime() : undefined;
  const ids: string[] = [];
  for (let skip = 0; ; skip += VECTOR_LIST_PAGE) {
    const { items } = await db.listMemoryItems(storeKey, {
      projectId,
      ...(filter?.scope ? { scope: filter.scope } : {}),
      ...(filter?.scopeId ? { scopeId: filter.scopeId } : {}),
      ...(filter?.tags?.length ? { tags: filter.tags } : {}),
      limit: VECTOR_LIST_PAGE,
      skip,
    });
    for (const item of items) {
      const created = item.createdAt ? new Date(item.createdAt).getTime() : Number.NaN;
      if (before !== undefined && !(created < before)) continue;
      if (item.vectorId) ids.push(item.vectorId);
    }
    if (items.length < VECTOR_LIST_PAGE) return ids;
  }
}

export async function deleteMemoryItemsBulk(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  storeKey: string,
  filter?: { scope?: IMemoryItem['scope']; scopeId?: string; tags?: string[]; before?: Date },
): Promise<number> {
  const db = await withTenantDb(tenantDbName);
  // Resolving the store within the caller's project first keeps a store key
  // belonging to another project from being emptied through this route, and
  // keeps the counter update on the store the caller actually owns.
  const store = await db.findMemoryStoreByKey(storeKey, projectId);
  if (!store) throw new Error('Memory store not found.');

  // The rows go with their vectors, as in deleteMemoryItem: the ids are read first because the delete only returns a count.
  const vectorIds = await collectVectorIds(db, storeKey, projectId, filter);
  for (let i = 0; i < vectorIds.length; i += VECTOR_DELETE_CHUNK) {
    try {
      await deleteVectors(tenantDbName, tenantId, projectId, {
        providerKey: store.vectorProviderKey,
        indexKey: store.vectorIndexKey,
        ids: vectorIds.slice(i, i + VECTOR_DELETE_CHUNK),
      });
    } catch (err) {
      logger.warn('Failed to remove vectors', { error: err });
    }
  }

  const deleted = await db.deleteMemoryItems(storeKey, { ...filter, projectId });

  if (deleted > 0) {
    const newCount = await db.countMemoryItems(storeKey, projectId);
    await db.updateMemoryStore(getRecordId(store), {
      memoryCount: newCount,
      lastActivityAt: new Date(),
    });
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
  options: ServiceCallOptions = {},
): Promise<MemorySearchResponse> {
  await assertServiceEnabled({ tenantDbName, tenantId }, 'memory');
  if (options.quota !== false) {
    await enforceServiceQuota(
      { tenantDbName, tenantId, projectId },
      { domain: 'memory', resourceKey: storeKey, cost: { requests: 1 } },
    );
  }
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
  // Archived, expired and (when asked) untagged items are dropped after the
  // vector query, so it asks for more than topK to still fill the page.
  const candidateK = Math.max(topK, Math.min(topK * 3, 100));

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
      topK: candidateK,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    },
  });

  const minScore = request.minScore ?? 0;
  const matches = (queryResult.matches ?? []).filter((match) => match.score >= minScore);

  // Load exactly the items behind these vectors: a store can hold far more
  // items than one page of a listing.
  const items = await db.findMemoryItemsByVectorIds(storeKey, matches.map((match) => match.id), projectId);
  const byVectorId = new Map(items.map((item) => [item.vectorId, item]));

  const now = new Date();
  const memories: MemorySearchMatch[] = [];
  for (const match of matches) {
    if (memories.length >= topK) break;
    const memoryItem = byVectorId.get(match.id);
    // A vector with no item behind it was deleted; it has no content to return.
    if (!memoryItem) continue;
    // Forgotten (archived) and expired memories are not recalled.
    if (memoryItem.status !== 'active' || isExpired(memoryItem, now)) continue;
    if (request.tags?.length && !request.tags.some((tag) => memoryItem.tags.includes(tag))) continue;
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
  }

  await Promise.all(memories.map((memory) => db.incrementMemoryAccess(memory.id)));

  return {
    memories,
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
  await assertServiceEnabled({ tenantDbName, tenantId }, 'memory');
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
