/**
 * Unit tests — the batch add.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { upsertVectors } from '@/lib/services/vector/vectorService';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { createMockDb } from '../helpers/db.mock';
import { addMemoryBatch, MemoryStoreFullError } from '@/lib/services/memory/memoryService';
import type { IMemoryItem, IMemoryStore } from '@/lib/database';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const STORE_KEY = 'mem-my-memories';
const DAY = 86_400_000;

function makeStore(config: Partial<IMemoryStore['config']> = {}, overrides: Partial<IMemoryStore> = {}): IMemoryStore {
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
      embeddingDimension: 2,
      metric: 'cosine',
      defaultScope: 'global',
      deduplication: true,
      autoSummarize: false,
      ...config,
    },
    status: 'active',
    memoryCount: 0,
    createdBy: 'user-1',
    ...overrides,
  } as IMemoryStore;
}

function makeItem(overrides: Partial<IMemoryItem> = {}): IMemoryItem {
  return {
    _id: 'old-item',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    storeKey: STORE_KEY,
    content: 'Prefers long answers',
    contentHash: 'hash',
    scope: 'global',
    status: 'active',
    accessCount: 0,
    source: 'api',
    importance: 0.5,
    vectorId: 'vec-old',
    tags: [],
    metadata: {},
    ...overrides,
  } as unknown as IMemoryItem;
}

describe('addMemoryBatch', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryStoreByKey.mockResolvedValue(makeStore());
    db.findMemoryItemByHash.mockResolvedValue(null);
    db.listMemoryItems.mockResolvedValue({ items: [], total: 0 });
    db.countMemoryItems.mockResolvedValue(0);
    db.createMemoryItem.mockImplementation(async (item) => ({ _id: 'new-item', ...item }) as IMemoryItem);
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: [0.1, 0.2] }] },
    });
    (upsertVectors as ReturnType<typeof vi.fn>).mockResolvedValue({ upsertedCount: 1 });
  });

  it('adds every item and reports none failed', async () => {
    const result = await addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }, { content: 'b' }]);
    expect(result).toEqual({ added: 2, duplicates: 0, failed: 0 });
  });

  it('does not report success when the store does not exist', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(null);
    await expect(addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }])).rejects.toThrow('Memory store not found.');
  });

  it('does not report success when the store is inactive', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({}, { status: 'inactive' as IMemoryStore['status'] }));
    await expect(addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }])).rejects.toThrow('Memory store is not active.');
  });

  it('does not report success when the store is full and nothing could be stored', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ maxMemories: 2 }));
    db.listMemoryItems.mockResolvedValue({ items: [], total: 2 });
    db.countMemoryItems.mockResolvedValue(2);
    await expect(addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }, { content: 'b' }])).rejects.toBeInstanceOf(MemoryStoreFullError);
  });

  it('does not report success when the embedding model fails for every item', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('embedding down'));
    await expect(addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }])).rejects.toThrow('embedding down');
  });

  it('counts the items that failed when others went through', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('embedding down'))
      .mockResolvedValue({ response: { data: [{ embedding: [0.1, 0.2] }] } });
    const result = await addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }, { content: 'b' }]);
    expect(result).toEqual({ added: 1, duplicates: 0, failed: 1 });
  });

  it('stops and counts the rest as failed when the store fills up part way', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ maxMemories: 1 }));
    db.listMemoryItems.mockResolvedValueOnce({ items: [], total: 0 }).mockResolvedValue({ items: [], total: 1 });
    db.countMemoryItems.mockResolvedValueOnce(0).mockResolvedValue(1);
    const result = await addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }, { content: 'b' }, { content: 'c' }]);
    expect(result).toEqual({ added: 1, duplicates: 0, failed: 2 });
  });

  it('skips the duplicate lookup when deduplication is off', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ deduplication: false }));
    db.findMemoryItemByHash.mockResolvedValue(makeItem());
    const result = await addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }]);
    expect(db.findMemoryItemByHash).not.toHaveBeenCalled();
    expect(result).toEqual({ added: 1, duplicates: 0, failed: 0 });
  });

  it('counts a live duplicate but not an expired one', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ ttlDays: 1 }));
    db.findMemoryItemByHash
      .mockResolvedValueOnce(makeItem({ expiresAt: new Date(Date.now() + DAY) }))
      .mockResolvedValueOnce(makeItem({ _id: 'old-2', expiresAt: new Date(Date.now() - DAY) }));
    db.updateMemoryItem.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ ...makeItem({ _id: id }), ...data }) as IMemoryItem);
    const result = await addMemoryBatch(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, [{ content: 'a' }, { content: 'b' }]);
    expect(result).toEqual({ added: 1, duplicates: 1, failed: 0 });
  });
});
