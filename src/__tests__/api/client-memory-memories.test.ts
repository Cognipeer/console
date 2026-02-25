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
  addMemory: vi.fn(),
  listMemoryItems: vi.fn(),
  deleteMemoryItemsBulk: vi.fn(),
}));

import { GET, POST } from '@/app/api/client/v1/memory/stores/[storeKey]/memories/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { addMemory, listMemoryItems, deleteMemoryItemsBulk } from '@/lib/services/memory/memoryService';

const mockRequireApiToken = vi.mocked(requireApiToken);
const mockAddMemory = vi.mocked(addMemory);
const mockListMemoryItems = vi.mocked(listMemoryItems);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
  user: { email: 'user@example.com' },
};

const mockMemoryItem = { _id: 'm-1', content: 'Hello World', scope: 'global', createdAt: new Date() };
const mockMemoryList = { items: [mockMemoryItem], total: 1 };
const mockParams = { params: Promise.resolve({ storeKey: 'store-1' }) };

function makeRequest(method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>, search = '') {
  return new NextRequest(`http://localhost/api/client/v1/memory/stores/store-1/memories${search}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-abc' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/client/v1/memory/stores/[storeKey]/memories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListMemoryItems.mockResolvedValue(mockMemoryList as any);
  });

  it('returns list of memories', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toBeDefined();
  });

  it('calls listMemoryItems with correct args', async () => {
    await GET(makeRequest('GET'), mockParams);
    expect(mockListMemoryItems).toHaveBeenCalledWith(
      'tenant_acme', 'tenant-1', 'proj-1', 'store-1', expect.any(Object),
    );
  });

  it('passes query params to service', async () => {
    await GET(makeRequest('GET', undefined, '?scope=user&scopeId=s1&limit=10'), mockParams);
    expect(mockListMemoryItems).toHaveBeenCalledWith(
      'tenant_acme', 'tenant-1', 'proj-1', 'store-1',
      expect.objectContaining({ scope: 'user', scopeId: 's1', limit: 10 }),
    );
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockListMemoryItems.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/client/v1/memory/stores/[storeKey]/memories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAddMemory.mockResolvedValue(mockMemoryItem as any);
  });

  it('creates a memory and returns 201', async () => {
    const res = await POST(makeRequest('POST', { content: 'Hello World' }), mockParams);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.memory).toBeDefined();
  });

  it('calls addMemory with correct args', async () => {
    await POST(makeRequest('POST', { content: 'Test memory', scope: 'global' }), mockParams);
    expect(mockAddMemory).toHaveBeenCalledWith(
      'tenant_acme', 'tenant-1', 'proj-1', 'store-1',
      expect.objectContaining({ content: 'Test memory', scope: 'global' }),
    );
  });

  it('returns 400 when content is missing', async () => {
    const res = await POST(makeRequest('POST', {}), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('content');
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await POST(makeRequest('POST', { content: 'Test' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockAddMemory.mockRejectedValueOnce(new Error('Service failed'));
    const res = await POST(makeRequest('POST', { content: 'Test' }), mockParams);
    expect(res.status).toBe(500);
  });
});
