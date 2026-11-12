/**
 * Unit tests — memoryService
 * Tests: createMemoryStore, listMemoryStores, getMemoryStore,
 *        updateMemoryStore, deleteMemoryStore
 *
 * Note: addMemory / searchMemories involve external embedding + vector
 *       calls and are tested at integration level through selective mocking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: vi.fn(async (_tenant: string, fn: (db: unknown) => unknown) => fn(await getDatabase())),
  };
});

vi.mock('@/lib/services/vector/vectorService', () => ({
  createVectorIndex: vi.fn(),
  deleteVectorIndex: vi.fn(),
  upsertVectors: vi.fn(),
  queryVectorIndex: vi.fn(),
  deleteVectors: vi.fn(),
}));

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import {
  createVectorIndex,
  deleteVectorIndex,
  upsertVectors,
  queryVectorIndex,
  deleteVectors,
} from '@/lib/services/vector/vectorService';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { createMockDb } from '../helpers/db.mock';
import {
  createMemoryStore,
  listMemoryStores,
  getMemoryStore,
  updateMemoryStore,
  deleteMemoryStore,
  addMemory,
  deleteMemoryItemsBulk,
  getMemoryItem,
  MemoryItemNotFoundError,
  MemoryStoreFullError,
  searchMemories,
  updateMemoryItem,
} from '@/lib/services/memory/memoryService';
import type { IMemoryStore } from '@/lib/database';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const USER_ID = 'user-1';
const STORE_KEY = 'mem-my-memories';

function makeStore(overrides: Partial<IMemoryStore> = {}): IMemoryStore {
  return {
    _id: 'store-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: STORE_KEY,
    name: 'My Memories',
    vectorProviderKey: 'pinecone-main',
    vectorIndexKey: 'memory-mem-my-memories',
    embeddingModelKey: 'text-embedding-3-small',
    config: {
      embeddingDimension: 1536,
      metric: 'cosine',
      defaultScope: 'global',
      deduplication: true,
      autoSummarize: false,
    },
    status: 'active',
    memoryCount: 0,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    ...overrides,
  };
}

function makeEmbeddingModel() {
  return {
    _id: 'model-1',
    key: 'text-embedding-3-small',
    name: 'Embedding Model',
    category: 'embedding' as const,
    tenantId: TENANT_ID,
    providerKey: 'openai-main',
    providerDriver: 'openai',
    modelId: 'text-embedding-3-small',
    settings: { dimensions: 1536 },
    pricing: { inputTokenPer1M: 0.1, outputTokenPer1M: 0 },
    createdBy: USER_ID,
  };
}

function makeVectorProvider() {
  return {
    _id: 'prov-1',
    key: 'pinecone-main',
    type: 'vector' as const,
    status: 'active' as const,
    tenantId: TENANT_ID,
    driver: 'pinecone',
    label: 'Pinecone',
    credentialsEnc: 'encrypted-blob',
    settings: {},
    createdBy: USER_ID,
  };
}

// ── createMemoryStore ─────────────────────────────────────────────────────────

describe('createMemoryStore', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findModelByKey.mockResolvedValue(makeEmbeddingModel());
    db.findProviderByKey.mockResolvedValue(makeVectorProvider());
    db.findMemoryStoreByKey.mockResolvedValue(null);
    (createVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: 'memory-mem-my-memories',
    });
    db.createMemoryStore.mockResolvedValue(makeStore());
  });

  it('creates a memory store and returns it', async () => {
    const result = await createMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, {
      name: 'My Memories',
      vectorProviderKey: 'pinecone-main',
      embeddingModelKey: 'text-embedding-3-small',
      createdBy: USER_ID,
    });

    expect(db.createMemoryStore).toHaveBeenCalledTimes(1);
    expect(result.key).toBe(STORE_KEY);
  });

  it('throws when embedding model is not found', async () => {
    db.findModelByKey.mockResolvedValue(null);

    await expect(
      createMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, {
        name: 'My Memories',
        vectorProviderKey: 'pinecone-main',
        embeddingModelKey: 'missing-model',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('Embedding model not found');
  });

  it('throws when model is not an embedding model', async () => {
    db.findModelByKey.mockResolvedValue({ ...makeEmbeddingModel(), category: 'llm' as const });

    await expect(
      createMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, {
        name: 'My Memories',
        vectorProviderKey: 'pinecone-main',
        embeddingModelKey: 'gpt-4o',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('embedding model');
  });

  it('throws when vector provider is not found', async () => {
    db.findProviderByKey.mockResolvedValue(null);

    await expect(
      createMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, {
        name: 'My Memories',
        vectorProviderKey: 'missing-provider',
        embeddingModelKey: 'text-embedding-3-small',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('Vector provider not found');
  });

  it('throws when vector provider is not active', async () => {
    db.findProviderByKey.mockResolvedValue({ ...makeVectorProvider(), status: 'errored' as const });

    await expect(
      createMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, {
        name: 'My Memories',
        vectorProviderKey: 'pinecone-main',
        embeddingModelKey: 'text-embedding-3-small',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('not active');
  });

  it('throws when store key already exists', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());

    await expect(
      createMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, {
        name: 'My Memories',
        vectorProviderKey: 'pinecone-main',
        embeddingModelKey: 'text-embedding-3-small',
        createdBy: USER_ID,
      }),
    ).rejects.toThrow('already exists');
  });

  it('creates a backing vector index before saving the store', async () => {
    await createMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, {
      name: 'My Memories',
      vectorProviderKey: 'pinecone-main',
      embeddingModelKey: 'text-embedding-3-small',
      createdBy: USER_ID,
    });

    expect(createVectorIndex).toHaveBeenCalledTimes(1);
    expect(db.createMemoryStore).toHaveBeenCalledTimes(1);
  });
});

// ── listMemoryStores ──────────────────────────────────────────────────────────

describe('listMemoryStores', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listMemoryStores.mockResolvedValue([makeStore()]);
  });

  it('returns stores for the project', async () => {
    const result = await listMemoryStores(TENANT_DB, TENANT_ID, PROJECT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe(STORE_KEY);
  });

  it('returns empty array when none exist', async () => {
    db.listMemoryStores.mockResolvedValue([]);
    const result = await listMemoryStores(TENANT_DB, TENANT_ID, PROJECT_ID);
    expect(result).toHaveLength(0);
  });

  it('passes filters to db.listMemoryStores', async () => {
    await listMemoryStores(TENANT_DB, TENANT_ID, PROJECT_ID, { status: 'active' });
    expect(db.listMemoryStores).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', projectId: PROJECT_ID }),
    );
  });
});

// ── getMemoryStore ────────────────────────────────────────────────────────────

describe('getMemoryStore', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns store when found', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    const result = await getMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY);
    expect(result.key).toBe(STORE_KEY);
  });

  it('throws when store not found', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(null);
    await expect(
      getMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, 'nonexistent'),
    ).rejects.toThrow('Memory store not found');
  });
});

// ── updateMemoryStore ─────────────────────────────────────────────────────────

describe('updateMemoryStore', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns updated store', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    db.updateMemoryStore.mockResolvedValue(makeStore({ name: 'Updated Name' }));

    const result = await updateMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, {
      name: 'Updated Name',
      updatedBy: USER_ID,
    });

    expect(result.name).toBe('Updated Name');
  });

  it('rejects a status that an operator cannot set', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());

    await expect(
      updateMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, {
        status: 'error' as never,
        updatedBy: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'MemoryStoreInputError', statusCode: 400 });
    expect(db.updateMemoryStore).not.toHaveBeenCalled();
  });

  it('accepts switching a store to inactive', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    db.updateMemoryStore.mockResolvedValue(makeStore({ status: 'inactive' }));

    await updateMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, {
      status: 'inactive',
      updatedBy: USER_ID,
    });

    expect(db.updateMemoryStore).toHaveBeenCalledWith('store-1', expect.objectContaining({ status: 'inactive' }));
  });

  it('throws when store not found', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(null);

    await expect(
      updateMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, 'missing', {
        name: 'X',
        updatedBy: USER_ID,
      }),
    ).rejects.toThrow('Memory store not found');
  });

  it('throws when db.updateMemoryStore returns null', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    db.updateMemoryStore.mockResolvedValue(null);

    await expect(
      updateMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, {
        name: 'X',
        updatedBy: USER_ID,
      }),
    ).rejects.toThrow('Failed to update memory store');
  });
});

// ── deleteMemoryStore ─────────────────────────────────────────────────────────

describe('deleteMemoryStore', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    db.deleteMemoryItems.mockResolvedValue(0);
    (deleteVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    db.deleteMemoryStore.mockResolvedValue(true);
  });

  it('deletes memory items before deleting the store', async () => {
    await deleteMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY);
    // Another project may have a store with the same key: only this project's items go.
    expect(db.deleteMemoryItems).toHaveBeenCalledWith(STORE_KEY, { projectId: PROJECT_ID });
    expect(db.deleteMemoryStore).toHaveBeenCalledTimes(1);
  });

  it('throws when store not found', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(null);
    await expect(
      deleteMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, 'missing'),
    ).rejects.toThrow('Memory store not found');
  });

  it('continues with store deletion even when vector index deletion fails', async () => {
    (deleteVectorIndex as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('vector delete failed'),
    );

    // Should not throw
    await expect(
      deleteMemoryStore(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY),
    ).resolves.toBeUndefined();

    expect(db.deleteMemoryStore).toHaveBeenCalledTimes(1);
  });
});

// ── addMemory ─────────────────────────────────────────────────────────────────

describe('addMemory', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    db.findMemoryItemByHash.mockResolvedValue(null); // no dedup hit
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: new Array(1536).fill(0.1) }] },
    });
    (upsertVectors as ReturnType<typeof vi.fn>).mockResolvedValue({ upsertedCount: 1 });
    db.createMemoryItem.mockResolvedValue({
      _id: 'item-1',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      storeKey: STORE_KEY,
      content: 'Test content',
      contentHash: 'abc123',
      scope: 'global',
      status: 'active',
      accessCount: 0,
      source: 'api',
      importance: 0.5,
      embeddingVersion: 'text-embedding-3-small',
      vectorId: 'vec-1',
      tags: [],
      metadata: {},
    } as unknown as import('@/lib/database').IMemoryItem);
    db.updateMemoryStore.mockResolvedValue(makeStore({ memoryCount: 1 }));
  });

  it('creates a new memory item', async () => {
    const result = await addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, {
      content: 'Test content',
    });

    expect(db.createMemoryItem).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Test content');
  });

  it('throws when store is not found', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(null);

    await expect(
      addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, 'missing-store', {
        content: 'Test',
      }),
    ).rejects.toThrow('Memory store not found');
  });

  it('throws when store is not active', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ status: 'inactive' as const }));

    await expect(
      addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, {
        content: 'Test',
      }),
    ).rejects.toThrow('not active');
  });

  it('returns existing item when deduplication finds a match', async () => {
    const existingItem = {
      _id: 'existing-item',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      storeKey: STORE_KEY,
      content: 'Test content',
      contentHash: 'abc123',
      scope: 'global' as const,
      status: 'active' as const,
      accessCount: 5,
      source: 'api' as const,
      importance: 0.5,
      embeddingVersion: 'text-embedding-3-small',
      vectorId: 'vec-1',
      tags: [] as string[],
      metadata: {},
    } as const;
    db.findMemoryItemByHash.mockResolvedValue(existingItem);
    db.incrementMemoryAccess.mockResolvedValue(undefined);

    const result = await addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, {
      content: 'Test content',
    });

    expect(db.createMemoryItem).not.toHaveBeenCalled();
    expect(db.incrementMemoryAccess).toHaveBeenCalledTimes(1);
    expect(result).toEqual(existingItem);
  });
});

// ── Project scoping, TTL, capacity, search filtering ─────────────────────────

function makeItem(overrides: Partial<import('@/lib/database').IMemoryItem> = {}): import('@/lib/database').IMemoryItem {
  return {
    _id: 'item-1',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    storeKey: STORE_KEY,
    content: 'Prefers short answers',
    contentHash: 'hash-1',
    scope: 'user',
    scopeId: 'user-42',
    metadata: {},
    tags: [],
    source: 'agent',
    importance: 0.7,
    accessCount: 0,
    embeddingVersion: 'text-embedding-3-small',
    vectorId: 'vec-1',
    status: 'active',
    ...overrides,
  };
}

describe('memory items stay inside their project', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: [0.1, 0.2] }] },
    });
  });

  it('getMemoryItem returns an item of the addressed store and project', async () => {
    db.findMemoryItemById.mockResolvedValue(makeItem());
    await expect(getMemoryItem(TENANT_DB, PROJECT_ID, STORE_KEY, 'item-1')).resolves.toMatchObject({ _id: 'item-1' });
    expect(db.incrementMemoryAccess).toHaveBeenCalledWith('item-1');
  });

  it('getMemoryItem treats an item of another project as missing', async () => {
    db.findMemoryItemById.mockResolvedValue(makeItem({ projectId: 'proj-other' }));
    await expect(getMemoryItem(TENANT_DB, PROJECT_ID, STORE_KEY, 'item-1')).rejects.toBeInstanceOf(MemoryItemNotFoundError);
    expect(db.incrementMemoryAccess).not.toHaveBeenCalled();
  });

  it('getMemoryItem treats an item of another store as missing', async () => {
    db.findMemoryItemById.mockResolvedValue(makeItem({ storeKey: 'mem-other' }));
    await expect(getMemoryItem(TENANT_DB, PROJECT_ID, STORE_KEY, 'item-1')).rejects.toBeInstanceOf(MemoryItemNotFoundError);
  });

  it('addMemory deduplicates within the project only', async () => {
    db.findMemoryItemByHash.mockResolvedValue(null);
    db.createMemoryItem.mockResolvedValue(makeItem());
    await addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'x' });
    expect(db.findMemoryItemByHash).toHaveBeenCalledWith(STORE_KEY, expect.any(String), PROJECT_ID);
  });

  it('deleteMemoryItemsBulk deletes and recounts within the project', async () => {
    db.listMemoryItems.mockResolvedValue({ items: [], total: 0 });
    db.deleteMemoryItems.mockResolvedValue(2);
    db.countMemoryItems.mockResolvedValue(3);
    await deleteMemoryItemsBulk(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { scope: 'user' });
    expect(db.deleteMemoryItems).toHaveBeenCalledWith(STORE_KEY, { scope: 'user', projectId: PROJECT_ID });
    expect(db.countMemoryItems).toHaveBeenCalledWith(STORE_KEY, PROJECT_ID);
  });
});

describe('deleteMemoryItemsBulk and the vector index', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    db.countMemoryItems.mockResolvedValue(0);
  });

  it('removes the vectors of the memories it deletes', async () => {
    db.listMemoryItems.mockResolvedValue({
      items: [makeItem({ _id: 'a', vectorId: 'vec-a' }), makeItem({ _id: 'b', vectorId: 'vec-b' })],
      total: 2,
    });
    db.deleteMemoryItems.mockResolvedValue(2);

    await deleteMemoryItemsBulk(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { scope: 'user', scopeId: 'user-42' });

    expect(db.listMemoryItems).toHaveBeenCalledWith(
      STORE_KEY,
      expect.objectContaining({ projectId: PROJECT_ID, scope: 'user', scopeId: 'user-42' }),
    );
    expect(deleteVectors).toHaveBeenCalledWith(TENANT_DB, TENANT_ID, PROJECT_ID, {
      providerKey: 'pinecone-main',
      indexKey: 'memory-mem-my-memories',
      ids: ['vec-a', 'vec-b'],
    });
  });

  it('only removes the vectors of items older than the before filter', async () => {
    db.listMemoryItems.mockResolvedValue({
      items: [
        makeItem({ _id: 'old', vectorId: 'vec-old', createdAt: new Date('2026-01-01T00:00:00Z') }),
        makeItem({ _id: 'new', vectorId: 'vec-new', createdAt: new Date('2026-03-01T00:00:00Z') }),
      ],
      total: 2,
    });
    db.deleteMemoryItems.mockResolvedValue(1);

    await deleteMemoryItemsBulk(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { before: new Date('2026-02-01T00:00:00Z') });

    expect(deleteVectors).toHaveBeenCalledWith(
      TENANT_DB,
      TENANT_ID,
      PROJECT_ID,
      expect.objectContaining({ ids: ['vec-old'] }),
    );
  });

  it('pages through every matching item', async () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => makeItem({ _id: `i${from + i}`, vectorId: `vec-${from + i}` }));
    db.listMemoryItems
      .mockResolvedValueOnce({ items: page(0, 500), total: 520 })
      .mockResolvedValueOnce({ items: page(500, 20), total: 520 });
    db.deleteMemoryItems.mockResolvedValue(520);

    await deleteMemoryItemsBulk(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY);

    const ids = (deleteVectors as ReturnType<typeof vi.fn>).mock.calls.flatMap((c) => c[3].ids as string[]);
    expect(ids).toHaveLength(520);
    expect(new Set(ids).size).toBe(520);
  });

  it('still deletes the rows when the vector index cannot be reached', async () => {
    db.listMemoryItems.mockResolvedValue({ items: [makeItem()], total: 1 });
    db.deleteMemoryItems.mockResolvedValue(1);
    (deleteVectors as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('index down'));

    await expect(deleteMemoryItemsBulk(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY)).resolves.toBe(1);
    expect(db.deleteMemoryItems).toHaveBeenCalled();
  });

  it('does not call the vector index when nothing matches', async () => {
    db.listMemoryItems.mockResolvedValue({ items: [], total: 0 });
    db.deleteMemoryItems.mockResolvedValue(0);

    await deleteMemoryItemsBulk(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY);
    expect(deleteVectors).not.toHaveBeenCalled();
  });
});

describe('store ttlDays and maxMemories', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryItemByHash.mockResolvedValue(null);
    db.createMemoryItem.mockImplementation(async (item) => ({ _id: 'item-1', ...item }));
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: [0.1, 0.2] }] },
    });
  });

  it('stamps expiresAt from ttlDays', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ config: { ...makeStore().config, ttlDays: 2 } }));
    const before = Date.now();
    const item = await addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'x' });
    const expiresAt = (item.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * 86_400_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000);
  });

  it('writes no expiresAt without ttlDays', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    const item = await addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'x' });
    expect(item.expiresAt).toBeUndefined();
  });

  it('refuses a memory once the store holds maxMemories', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ config: { ...makeStore().config, maxMemories: 3 } }));
    db.listMemoryItems.mockResolvedValue({ items: [], total: 3 });
    await expect(addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'x' })).rejects.toBeInstanceOf(MemoryStoreFullError);
    expect(db.listMemoryItems).toHaveBeenCalledWith(STORE_KEY, expect.objectContaining({ projectId: PROJECT_ID, notExpiredAt: expect.any(Date) }));
    expect(upsertVectors).not.toHaveBeenCalled();
    expect(db.createMemoryItem).not.toHaveBeenCalled();
  });

  it('accepts a memory below maxMemories', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ config: { ...makeStore().config, maxMemories: 3 } }));
    db.listMemoryItems.mockResolvedValue({ items: [], total: 2 });
    await expect(addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'x' })).resolves.toBeDefined();
  });
});

describe('updateMemoryItem', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ config: { ...makeStore().config, ttlDays: 1 } }));
    db.findMemoryItemById.mockResolvedValue(makeItem({ tags: ['pref'] }));
    db.updateMemoryItem.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({ ...makeItem(), ...data }));
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: [0.3, 0.4] }] },
    });
  });

  it('keeps scope and scopeId on the vector when the content changes', async () => {
    await updateMemoryItem(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, 'item-1', { content: 'Prefers long answers', importance: 0.9 });
    const vector = (upsertVectors as ReturnType<typeof vi.fn>).mock.calls[0][3].vectors[0];
    expect(vector).toMatchObject({
      id: 'vec-1',
      metadata: { storeKey: STORE_KEY, scope: 'user', scopeId: 'user-42', source: 'agent', tags: 'pref', importance: 0.9 },
    });
  });

  it('refreshes expiresAt when the content changes', async () => {
    await updateMemoryItem(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, 'item-1', { content: 'Prefers long answers' });
    const payload = db.updateMemoryItem.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.expiresAt).toBeInstanceOf(Date);
  });

  it('does not touch the vector when only the status changes', async () => {
    await updateMemoryItem(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, 'item-1', { status: 'archived' });
    expect(upsertVectors).not.toHaveBeenCalled();
  });
});

describe('searchMemories', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: [0.1, 0.2] }] },
    });
  });

  it('loads only the matched items and leaves out archived, expired and vector-only matches', async () => {
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [
        { id: 'vec-archived', score: 0.95 },
        { id: 'vec-expired', score: 0.93 },
        { id: 'vec-orphan', score: 0.92 },
        { id: 'vec-ok', score: 0.9 },
      ],
    });
    db.findMemoryItemsByVectorIds.mockResolvedValue([
      makeItem({ _id: 'a', vectorId: 'vec-archived', status: 'archived' }),
      makeItem({ _id: 'e', vectorId: 'vec-expired', expiresAt: new Date(Date.now() - 1000) }),
      makeItem({ _id: 'ok', vectorId: 'vec-ok', expiresAt: new Date(Date.now() + 60_000) }),
    ]);

    const result = await searchMemories(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { query: 'answers', topK: 5 });

    expect(result.memories.map((m) => m.id)).toEqual(['ok']);
    expect(db.findMemoryItemsByVectorIds).toHaveBeenCalledWith(
      STORE_KEY,
      ['vec-archived', 'vec-expired', 'vec-orphan', 'vec-ok'],
      PROJECT_ID,
    );
    expect(db.listMemoryItems).not.toHaveBeenCalled();
    expect(db.incrementMemoryAccess).toHaveBeenCalledTimes(1);
    expect(db.incrementMemoryAccess).toHaveBeenCalledWith('ok');
  });

  it('asks the index for more than topK and stops at topK after filtering by tag', async () => {
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [
        { id: 'v1', score: 0.9 },
        { id: 'v2', score: 0.8 },
        { id: 'v3', score: 0.7 },
        { id: 'v4', score: 0.6 },
      ],
    });
    db.findMemoryItemsByVectorIds.mockResolvedValue([
      makeItem({ _id: 'i1', vectorId: 'v1', tags: ['other'] }),
      makeItem({ _id: 'i2', vectorId: 'v2', tags: ['pref'] }),
      makeItem({ _id: 'i3', vectorId: 'v3', tags: ['pref'] }),
      makeItem({ _id: 'i4', vectorId: 'v4', tags: ['pref'] }),
    ]);

    const result = await searchMemories(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { query: 'q', topK: 2, tags: ['pref'] });

    expect((queryVectorIndex as ReturnType<typeof vi.fn>).mock.calls[0][3].query.topK).toBe(6);
    expect(result.memories.map((m) => m.id)).toEqual(['i2', 'i3']);
  });

  it('drops matches under minScore before loading items', async () => {
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [{ id: 'v1', score: 0.9 }, { id: 'v2', score: 0.2 }],
    });
    db.findMemoryItemsByVectorIds.mockResolvedValue([makeItem({ _id: 'i1', vectorId: 'v1' })]);

    await searchMemories(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { query: 'q', minScore: 0.5 });

    expect(db.findMemoryItemsByVectorIds).toHaveBeenCalledWith(STORE_KEY, ['v1'], PROJECT_ID);
  });
});
