import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/vector', () => ({
  getVectorIndex: vi.fn(),
  updateVectorIndex: vi.fn(),
  deleteVectorIndex: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return { requireProjectContext: vi.fn(), ProjectContextError };
});

import { GET, PATCH, DELETE } from '@/app/api/vector/indexes/[externalId]/route';
import { getVectorIndex, updateVectorIndex, deleteVectorIndex } from '@/lib/services/vector';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockGetVectorIndex = vi.mocked(getVectorIndex);
const mockUpdateVectorIndex = vi.mocked(updateVectorIndex);
const mockDeleteVectorIndex = vi.mocked(deleteVectorIndex);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockIndex = { _id: 'idx-1', key: 'idx-1', name: 'My Index', providerKey: 'pv-1', dimension: 1536 };
const mockProvider = { key: 'pv-1', name: 'Pinecone' };

const mockParams = { params: Promise.resolve({ externalId: 'idx-1' }) };

function makeRequest(method: string, body?: Record<string, unknown>, search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/vector/indexes/idx-1${search}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/vector/indexes/[externalId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetVectorIndex.mockResolvedValue({ index: mockIndex, provider: mockProvider } as any);
  });

  it('returns index and provider on success', async () => {
    const res = await GET(makeRequest('GET', undefined, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('index');
    expect(body).toHaveProperty('provider');
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('providerKey');
  });

  it('returns 401 when x-tenant-db-name missing', async () => {
    const res = await GET(makeRequest('GET', undefined, '?providerKey=pv-1', { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 for not found error', async () => {
    mockGetVectorIndex.mockRejectedValueOnce(new Error('Vector index metadata not found'));
    const res = await GET(makeRequest('GET', undefined, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetVectorIndex.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeRequest('GET', undefined, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/vector/indexes/[externalId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateVectorIndex.mockResolvedValue({ ...mockIndex, name: 'Updated Name' } as any);
  });

  it('updates index name and returns it', async () => {
    const res = await PATCH(makeRequest('PATCH', { name: 'Updated Name' }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('index');
  });

  it('calls updateVectorIndex with correct args', async () => {
    await PATCH(makeRequest('PATCH', { name: 'New Name' }, '?providerKey=pv-1'), mockParams);
    expect(mockUpdateVectorIndex).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'pv-1',
      'idx-1',
      expect.objectContaining({ name: 'New Name', updatedBy: 'user-1' }),
    );
  });

  it('returns 400 when no fields to update provided', async () => {
    const res = await PATCH(makeRequest('PATCH', {}, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('field');
  });

  it('returns 400 when name is not a string', async () => {
    const res = await PATCH(makeRequest('PATCH', { name: 123 }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when metadata is not an object', async () => {
    const res = await PATCH(makeRequest('PATCH', { metadata: 'bad' }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await PATCH(makeRequest('PATCH', { name: 'Test' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 404 for not found error', async () => {
    mockUpdateVectorIndex.mockRejectedValueOnce(new Error('Vector index metadata not found'));
    const res = await PATCH(makeRequest('PATCH', { name: 'x' }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when x-user-id missing', async () => {
    const res = await PATCH(makeRequest('PATCH', { name: 'x' }, '?providerKey=pv-1', { 'x-user-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/vector/indexes/[externalId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockDeleteVectorIndex.mockResolvedValue(undefined);
  });

  it('deletes index and returns success', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deleteVectorIndex with correct args', async () => {
    await DELETE(makeRequest('DELETE', undefined, '?providerKey=pv-1'), mockParams);
    expect(mockDeleteVectorIndex).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      'pv-1',
      'idx-1',
      expect.objectContaining({ updatedBy: 'user-1' }),
    );
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-tenant-id missing', async () => {
    const req = new NextRequest('http://localhost/api/vector/indexes/idx-1?providerKey=pv-1', {
      method: 'DELETE',
      headers: { 'x-tenant-db-name': 'tenant_test', 'x-user-id': 'user-1' },
    });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 for not found error', async () => {
    mockDeleteVectorIndex.mockRejectedValueOnce(new Error('Vector provider configuration not found'));
    const res = await DELETE(makeRequest('DELETE', undefined, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteVectorIndex.mockRejectedValueOnce(new Error('DB crash'));
    const res = await DELETE(makeRequest('DELETE', undefined, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(500);
  });
});
