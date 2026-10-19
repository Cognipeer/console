/**
 * Unit tests — agent memory adapter honours the store's status.
 * An agent neither reads from nor writes to a store that is not active.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMemoryStore: vi.fn(),
  listMemoryItems: vi.fn(),
  addMemory: vi.fn(),
  updateMemoryItem: vi.fn(),
  searchMemories: vi.fn(),
}));

vi.mock('@/lib/services/memory/memoryService', () => mocks);

import { createConsoleMemoryStore } from '@/lib/services/agents/agentMemoryAdapter';

const ctx = {
  tenantDbName: 'db',
  tenantId: 't',
  projectId: 'p',
  storeKey: 'mem',
  scopeIds: { session: 's1' },
  onWarning: vi.fn(),
};

describe('createConsoleMemoryStore with a store that is not active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMemoryStore.mockResolvedValue({ key: 'mem', status: 'inactive' });
  });

  it('reads nothing and reports no warning', async () => {
    const store = createConsoleMemoryStore(ctx);
    expect(await store.get('session')).toEqual([]);
    expect(await store.semanticSearch!('session', 'q')).toEqual([]);
    expect(mocks.listMemoryItems).not.toHaveBeenCalled();
    expect(mocks.searchMemories).not.toHaveBeenCalled();
    expect(ctx.onWarning).not.toHaveBeenCalled();
  });

  it('writes nothing', async () => {
    const store = createConsoleMemoryStore(ctx);
    await store.upsert('session', [{ key: 'k', value: 'v', sourceTurn: 1, confidence: 1, tags: [] } as never]);
    await store.markObsolete('session', ['k']);
    expect(mocks.listMemoryItems).not.toHaveBeenCalled();
    expect(mocks.addMemory).not.toHaveBeenCalled();
    expect(mocks.updateMemoryItem).not.toHaveBeenCalled();
  });

  it('still reads from an active store', async () => {
    mocks.getMemoryStore.mockResolvedValue({ key: 'mem', status: 'active' });
    mocks.listMemoryItems.mockResolvedValue({ items: [], total: 0 });
    const store = createConsoleMemoryStore(ctx);
    await store.get('session');
    expect(mocks.listMemoryItems).toHaveBeenCalledTimes(1);
  });
});
