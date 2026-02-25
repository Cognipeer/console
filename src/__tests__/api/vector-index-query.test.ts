import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/vector', () => ({
  queryVectorIndex: vi.fn(),
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

import { POST } from '@/app/api/vector/indexes/[externalId]/query/route';
import { queryVectorIndex } from '@/lib/services/vector';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockQueryVectorIndex = vi.mocked(queryVectorIndex);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockResult = {
  matches: [{ id: 'vec-1', score: 0.95, values: [0.1, 0.2, 0.3] }],
};

const mockParams = { params: Promise.resolve({ externalId: 'idx-1' }) };

function makeRequest(body: Record<string, unknown>, search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/vector/indexes/idx-1/query${search}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/vector/indexes/[externalId]/query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQueryVectorIndex.mockResolvedValue(mockResult as any);
  });

  it('returns query matches on success', async () => {
    const res = await POST(
      makeRequest({ query: { vector: [0.1, 0.2, 0.3], topK: 5 } }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('result');
  });

  it('calls queryVectorIndex with correct args', async () => {
    await POST(
      makeRequest({ query: { vector: [0.1, 0.2], topK: 3 } }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(mockQueryVectorIndex).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      expect.objectContaining({
        providerKey: 'pv-1',
        indexExternalId: 'idx-1',
        query: expect.objectContaining({ vector: [0.1, 0.2], topK: 3 }),
      }),
    );
  });

  it('uses default topK of 5 when not provided', async () => {
    await POST(
      makeRequest({ query: { vector: [0.5, 0.6] } }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(mockQueryVectorIndex).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ query: expect.objectContaining({ topK: 5 }) }),
    );
  });

  it('returns 400 when query.vector is missing', async () => {
    const res = await POST(
      makeRequest({ query: { topK: 3 } }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('vector');
  });

  it('returns 400 when topK is not a positive number', async () => {
    const res = await POST(
      makeRequest({ query: { vector: [0.1], topK: -1 } }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await POST(
      makeRequest({ query: { vector: [0.1], topK: 5 } }),
      mockParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-tenant-db-name missing', async () => {
    const res = await POST(
      makeRequest({ query: { vector: [0.1], topK: 5 } }, '?providerKey=pv-1', { 'x-tenant-db-name': '' }),
      mockParams,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for not found error', async () => {
    mockQueryVectorIndex.mockRejectedValueOnce(new Error('Vector index metadata not found'));
    const res = await POST(
      makeRequest({ query: { vector: [0.1], topK: 5 } }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockQueryVectorIndex.mockRejectedValueOnce(new Error('DB crash'));
    const res = await POST(
      makeRequest({ query: { vector: [0.1], topK: 5 } }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(res.status).toBe(500);
  });
});
