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

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

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
    expect(db.deleteMemoryItems).toHaveBeenCalledWith(STORE_KEY);
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
