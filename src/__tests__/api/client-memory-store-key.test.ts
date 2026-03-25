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
  getMemoryStore: vi.fn(),
  updateMemoryStore: vi.fn(),
  deleteMemoryStore: vi.fn(),
}));

import { GET, PATCH, DELETE } from '@/server/api/routes/client/v1/memory/stores/[storeKey]/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { getMemoryStore, updateMemoryStore, deleteMemoryStore } from '@/lib/services/memory/memoryService';

const mockRequireApiToken = vi.mocked(requireApiToken);
const mockGetMemoryStore = vi.mocked(getMemoryStore);
const mockUpdateMemoryStore = vi.mocked(updateMemoryStore);
const mockDeleteMemoryStore = vi.mocked(deleteMemoryStore);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
  user: { email: 'user@example.com' },
};

const mockStore = { key: 'store-1', name: 'My Store', status: 'active' };
const mockParams = { params: Promise.resolve({ storeKey: 'store-1' }) };

function makeRequest(method: 'GET' | 'PATCH' | 'DELETE', body?: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/client/v1/memory/stores/store-1', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-abc' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/client/v1/memory/stores/[storeKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetMemoryStore.mockResolvedValue(mockStore as any);
  });

  it('returns store details', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.store).toBeDefined();
  });

  it('calls getMemoryStore with correct args', async () => {
    await GET(makeRequest('GET'), mockParams);
    expect(mockGetMemoryStore).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'store-1');
  });

  it('returns 404 when store not found', async () => {
    mockGetMemoryStore.mockRejectedValueOnce(new Error('store not found'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetMemoryStore.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/client/v1/memory/stores/[storeKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateMemoryStore.mockResolvedValue({ ...mockStore, name: 'Updated Store' } as any);
  });

  it('updates store and returns it', async () => {
    const res = await PATCH(makeRequest('PATCH', { name: 'Updated Store' }), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.store).toBeDefined();
  });

  it('calls updateMemoryStore with correct args', async () => {
    await PATCH(makeRequest('PATCH', { name: 'New Name' }), mockParams);
    expect(mockUpdateMemoryStore).toHaveBeenCalledWith(
      'tenant_acme', 'tenant-1', 'proj-1', 'store-1',
      expect.objectContaining({ name: 'New Name' }),
    );
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await PATCH(makeRequest('PATCH', {}), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockUpdateMemoryStore.mockRejectedValueOnce(new Error('Update failed'));
    const res = await PATCH(makeRequest('PATCH', { name: 'x' }), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/client/v1/memory/stores/[storeKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDeleteMemoryStore.mockResolvedValue(undefined);
  });

  it('deletes store and returns success', async () => {
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deleteMemoryStore with correct args', async () => {
    await DELETE(makeRequest('DELETE'), mockParams);
    expect(mockDeleteMemoryStore).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'store-1');
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Forbidden', 403));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteMemoryStore.mockRejectedValueOnce(new Error('Conflict'));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(500);
  });
});
