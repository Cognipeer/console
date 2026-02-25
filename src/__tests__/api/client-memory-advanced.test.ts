import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/memory/memoryService', () => ({
  recallForChat: vi.fn(),
  searchMemories: vi.fn(),
  addMemoryBatch: vi.fn(),
  getMemoryItem: vi.fn(),
  updateMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
}));

import { POST as recallPOST } from '@/app/api/client/v1/memory/stores/[storeKey]/recall/route';
import { POST as searchPOST } from '@/app/api/client/v1/memory/stores/[storeKey]/search/route';
import { POST as batchPOST } from '@/app/api/client/v1/memory/stores/[storeKey]/memories/batch/route';
import { GET as memoryGET, PATCH as memoryPATCH, DELETE as memoryDELETE } from '@/app/api/client/v1/memory/stores/[storeKey]/memories/[memoryId]/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  recallForChat,
  searchMemories,
  addMemoryBatch,
  getMemoryItem,
  updateMemoryItem,
  deleteMemoryItem,
} from '@/lib/services/memory/memoryService';

const mockRequireApiToken = vi.mocked(requireApiToken);
const mockRecallForChat = vi.mocked(recallForChat);
const mockSearchMemories = vi.mocked(searchMemories);
const mockAddMemoryBatch = vi.mocked(addMemoryBatch);
const mockGetMemoryItem = vi.mocked(getMemoryItem);
const mockUpdateMemoryItem = vi.mocked(updateMemoryItem);
const mockDeleteMemoryItem = vi.mocked(deleteMemoryItem);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
  user: { email: 'user@example.com' },
};

const storeParams = { params: Promise.resolve({ storeKey: 'store-1' }) };
const memoryParams = { params: Promise.resolve({ storeKey: 'store-1', memoryId: 'mem-1' }) };

function makeReq(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

function makeGetReq(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer token' },
  });
}

function makePatchReq(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

function makeDeleteReq(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer token' },
  });
}

const mockRecallResult = { memories: [{ content: 'Relevant memory', score: 0.9 }], context: 'Relevant memory' };
const mockSearchResult = { results: [{ _id: 'm-1', content: 'Found', score: 0.85 }] };

describe('POST /api/client/v1/memory/stores/[storeKey]/recall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRecallForChat.mockResolvedValue(mockRecallResult as any);
  });

  it('recalls memories for chat query', async () => {
    const res = await recallPOST(makeReq('/api/client/v1/memory/stores/store-1/recall', { query: 'Hello' }), storeParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toBeDefined();
  });

  it('calls recallForChat with query', async () => {
    await recallPOST(makeReq('/api/client/v1/memory/stores/store-1/recall', { query: 'Tell me about AI', topK: 3 }), storeParams);
    expect(mockRecallForChat).toHaveBeenCalledWith(
      'tenant_acme', 'tenant-1', 'proj-1', 'store-1',
      expect.objectContaining({ query: 'Tell me about AI', topK: 3 }),
    );
  });

  it('returns 400 when query is missing', async () => {
    const res = await recallPOST(makeReq('/api/client/v1/memory/stores/store-1/recall', {}), storeParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await recallPOST(makeReq('/api/client/v1/memory/stores/store-1/recall', { query: 'x' }), storeParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockRecallForChat.mockRejectedValueOnce(new Error('Vector error'));
    const res = await recallPOST(makeReq('/api/client/v1/memory/stores/store-1/recall', { query: 'x' }), storeParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/client/v1/memory/stores/[storeKey]/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSearchMemories.mockResolvedValue(mockSearchResult as any);
  });

  it('returns search results', async () => {
    const res = await searchPOST(makeReq('/api/client/v1/memory/stores/store-1/search', { query: 'AI' }), storeParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toBeDefined();
  });

  it('returns 400 when query is missing', async () => {
    const res = await searchPOST(makeReq('/api/client/v1/memory/stores/store-1/search', {}), storeParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await searchPOST(makeReq('/api/client/v1/memory/stores/store-1/search', { query: 'x' }), storeParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockSearchMemories.mockRejectedValueOnce(new Error('Search failed'));
    const res = await searchPOST(makeReq('/api/client/v1/memory/stores/store-1/search', { query: 'x' }), storeParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/client/v1/memory/stores/[storeKey]/memories/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockAddMemoryBatch.mockResolvedValue({ count: 2, memories: [] } as never);
  });

  it('adds a batch of memories', async () => {
    const res = await batchPOST(
      makeReq('/api/client/v1/memory/stores/store-1/memories/batch', {
        memories: [{ content: 'M1' }, { content: 'M2' }],
      }),
      storeParams,
    );
    expect(res.status).toBe(201);
  });

  it('returns 400 when memories array is empty', async () => {
    const res = await batchPOST(
      makeReq('/api/client/v1/memory/stores/store-1/memories/batch', { memories: [] }),
      storeParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when batch is too large', async () => {
    const memories = Array.from({ length: 101 }, (_, i) => ({ content: `M${i}` }));
    const res = await batchPOST(
      makeReq('/api/client/v1/memory/stores/store-1/memories/batch', { memories }),
      storeParams,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('100');
  });

  it('returns 400 when a memory lacks content', async () => {
    const res = await batchPOST(
      makeReq('/api/client/v1/memory/stores/store-1/memories/batch', { memories: [{ tag: 'no-content' }] }),
      storeParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await batchPOST(
      makeReq('/api/client/v1/memory/stores/store-1/memories/batch', { memories: [{ content: 'M1' }] }),
      storeParams,
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/client/v1/memory/stores/[storeKey]/memories/[memoryId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockGetMemoryItem.mockResolvedValue({ _id: 'mem-1', content: 'Hello' } as never);
  });

  it('returns item by ID', async () => {
    const res = await memoryGET(makeGetReq('/api/client/v1/memory/stores/store-1/memories/mem-1'), memoryParams);
    expect(res.status).toBe(200);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await memoryGET(makeGetReq('/api/client/v1/memory/stores/store-1/memories/mem-1'), memoryParams);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/client/v1/memory/stores/[storeKey]/memories/[memoryId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockUpdateMemoryItem.mockResolvedValue({ _id: 'mem-1', content: 'Updated' } as never);
  });

  it('updates a memory item', async () => {
    const res = await memoryPATCH(
      makePatchReq('/api/client/v1/memory/stores/store-1/memories/mem-1', { content: 'Updated' }),
      memoryParams,
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when no valid fields provided', async () => {
    const res = await memoryPATCH(
      makePatchReq('/api/client/v1/memory/stores/store-1/memories/mem-1', { unknownField: 'x' }),
      memoryParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await memoryPATCH(
      makePatchReq('/api/client/v1/memory/stores/store-1/memories/mem-1', { content: 'x' }),
      memoryParams,
    );
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/client/v1/memory/stores/[storeKey]/memories/[memoryId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDeleteMemoryItem.mockResolvedValue(undefined);
  });

  it('deletes a memory item', async () => {
    const res = await memoryDELETE(makeDeleteReq('/api/client/v1/memory/stores/store-1/memories/mem-1'), memoryParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await memoryDELETE(makeDeleteReq('/api/client/v1/memory/stores/store-1/memories/mem-1'), memoryParams);
    expect(res.status).toBe(401);
  });
});
