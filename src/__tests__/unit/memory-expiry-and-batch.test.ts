/**
 * Unit tests — memory writes next to expired items.
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
import { addMemory, MemoryStoreFullError } from '@/lib/services/memory/memoryService';
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

describe('adding a memory next to expired items', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findMemoryItemByHash.mockResolvedValue(null);
    db.listMemoryItems.mockResolvedValue({ items: [], total: 0 });
    db.countMemoryItems.mockResolvedValue(0);
    db.createMemoryItem.mockImplementation(async (item) => ({ _id: 'new-item', ...item }) as IMemoryItem);
    db.updateMemoryItem.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ ...makeItem({ _id: id }), ...data }) as IMemoryItem);
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: { data: [{ embedding: [0.1, 0.2] }] },
    });
    (upsertVectors as ReturnType<typeof vi.fn>).mockResolvedValue({ upsertedCount: 1 });
  });

  it('gives an expired duplicate a new expiry instead of answering with the hidden item', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ ttlDays: 2 }));
    db.findMemoryItemByHash.mockResolvedValue(makeItem({ expiresAt: new Date(Date.now() - DAY) }));
    const before = Date.now();
    const item = await addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'Prefers long answers' });
    expect(db.updateMemoryItem).toHaveBeenCalledTimes(1);
    expect(db.updateMemoryItem.mock.calls[0][0]).toBe('old-item');
    const expiresAt = (item.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * DAY);
    expect(db.incrementMemoryAccess).not.toHaveBeenCalled();
  });

  it('still answers with the item when the duplicate has not expired', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ ttlDays: 2 }));
    const live = makeItem({ expiresAt: new Date(Date.now() + DAY) });
    db.findMemoryItemByHash.mockResolvedValue(live);
    const item = await addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'Prefers long answers' });
    expect(item).toBe(live);
    expect(db.incrementMemoryAccess).toHaveBeenCalledWith('old-item');
    expect(db.updateMemoryItem).not.toHaveBeenCalled();
  });

  it('counts only memories that have not expired against maxMemories', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ ttlDays: 2, maxMemories: 3 }));
    // three rows exist, but two of them are past their TTL
    db.countMemoryItems.mockResolvedValue(3);
    db.listMemoryItems.mockImplementation(async (_key: string, filters?: { notExpiredAt?: Date }) => ({
      items: [],
      total: filters?.notExpiredAt ? 1 : 3,
    }));
    await expect(addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'new fact' })).resolves.toBeDefined();
    expect(db.createMemoryItem).toHaveBeenCalledTimes(1);
  });

  it('still refuses a memory when maxMemories live items exist', async () => {
    db.findMemoryStoreByKey.mockResolvedValue(makeStore({ ttlDays: 2, maxMemories: 3 }));
    db.listMemoryItems.mockResolvedValue({ items: [], total: 3 });
    await expect(addMemory(TENANT_DB, TENANT_ID, PROJECT_ID, STORE_KEY, { content: 'new fact' })).rejects.toBeInstanceOf(MemoryStoreFullError);
  });
});
