import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  incrementProjectVectorCountApprox: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/services/vector', () => ({
  deleteVectors: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(msg: string, status: number) {
      super(msg);
      this.status = status;
    }
  }
  return {
    requireProjectContext: vi.fn(),
    ProjectContextError,
  };
});

vi.mock('@/lib/quota/quotaGuard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true } as any),
}));

import { DELETE } from '@/server/api/routes/vector/indexes/[externalId]/vectors/route';
import { deleteVectors } from '@/lib/services/vector';
import { requireProjectContext } from '@/lib/services/projects/projectContext';
import { checkRateLimit } from '@/lib/quota/quotaGuard';

const mockDeleteVectors = vi.mocked(deleteVectors);
const mockRequireProjectContext = vi.mocked(requireProjectContext);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockParams = { params: Promise.resolve({ externalId: 'idx-1' }) };

function makeRequest(body: Record<string, unknown>, search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/vector/indexes/idx-1/vectors${search}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      'x-license-type': 'PRO',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('DELETE /api/vector/indexes/[externalId]/vectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockDeleteVectors.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValue({ allowed: true } as any);
    mockDb.switchToTenant.mockResolvedValue(undefined);
    mockDb.incrementProjectVectorCountApprox.mockResolvedValue(undefined);
  });

  it('deletes vectors and returns success', async () => {
    const res = await DELETE(makeRequest({ ids: ['v-1', 'v-2'] }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deleteVectors with correct args', async () => {
    await DELETE(makeRequest({ ids: ['v-1', 'v-2'] }, '?providerKey=pv-1'), mockParams);
    expect(mockDeleteVectors).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      expect.objectContaining({
        providerKey: 'pv-1',
        indexExternalId: 'idx-1',
        ids: ['v-1', 'v-2'],
        updatedBy: 'user-1',
      }),
    );
  });

  it('decrements vector count after deletion', async () => {
    await DELETE(makeRequest({ ids: ['v-1', 'v-2'] }, '?providerKey=pv-1'), mockParams);
    expect(mockDb.incrementProjectVectorCountApprox).toHaveBeenCalledWith('proj-1', -2);
  });

  it('returns 400 when ids array is missing', async () => {
    const res = await DELETE(makeRequest({}, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('ids');
  });

  it('returns 400 when ids array is empty', async () => {
    const res = await DELETE(makeRequest({ ids: [] }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await DELETE(makeRequest({ ids: ['v-1'] }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-license-type is missing', async () => {
    const res = await DELETE(
      makeRequest({ ids: ['v-1'] }, '?providerKey=pv-1', { 'x-license-type': '' }),
      mockParams,
    );
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate limit fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, reason: 'Too many requests' } as any);
    const res = await DELETE(makeRequest({ ids: ['v-1'] }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(429);
  });

  it('returns 404 when vector index not found', async () => {
    mockDeleteVectors.mockRejectedValueOnce(new Error('Vector index metadata not found'));
    const res = await DELETE(makeRequest({ ids: ['v-1'] }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteVectors.mockRejectedValueOnce(new Error('DB failure'));
    const res = await DELETE(makeRequest({ ids: ['v-1'] }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(500);
  });

  it('filters out invalid (non-string) ids', async () => {
    const res = await DELETE(makeRequest({ ids: [123, null, 'v-valid'] }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(200);
    expect(mockDeleteVectors).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ ids: ['v-valid'] }),
    );
  });
});
