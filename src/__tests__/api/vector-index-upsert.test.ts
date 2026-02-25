import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  getProjectVectorCountApprox: vi.fn(),
  incrementProjectVectorCountApprox: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/services/vector', () => ({
  upsertVectors: vi.fn(),
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

vi.mock('@/lib/quota/quotaGuard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {} } } as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true } as any),
}));

import { POST } from '@/app/api/vector/indexes/[externalId]/upsert/route';
import { upsertVectors } from '@/lib/services/vector';
import { requireProjectContext } from '@/lib/services/projects/projectContext';
import { checkPerRequestLimits, checkRateLimit } from '@/lib/quota/quotaGuard';

const mockUpsertVectors = vi.mocked(upsertVectors);
const mockRequireProjectContext = vi.mocked(requireProjectContext);
const mockCheckPerRequestLimits = vi.mocked(checkPerRequestLimits);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const sampleVectors = [
  { id: 'v-1', values: [0.1, 0.2, 0.3] },
  { id: 'v-2', values: [0.4, 0.5, 0.6] },
];

const mockParams = { params: Promise.resolve({ externalId: 'idx-1' }) };

function makeRequest(body: Record<string, unknown>, search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/vector/indexes/idx-1/upsert${search}`, {
    method: 'POST',
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

describe('POST /api/vector/indexes/[externalId]/upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockUpsertVectors.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckPerRequestLimits.mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {} } } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValue({ allowed: true } as any);
    mockDb.getProjectVectorCountApprox.mockResolvedValue(0);
    mockDb.incrementProjectVectorCountApprox.mockResolvedValue(undefined);
    mockDb.switchToTenant.mockResolvedValue(undefined);
  });

  it('upserts vectors and returns success', async () => {
    const res = await POST(makeRequest({ vectors: sampleVectors }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls upsertVectors with correct args', async () => {
    await POST(makeRequest({ vectors: sampleVectors }, '?providerKey=pv-1'), mockParams);
    expect(mockUpsertVectors).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      expect.objectContaining({
        providerKey: 'pv-1',
        indexExternalId: 'idx-1',
        vectors: sampleVectors,
        updatedBy: 'user-1',
      }),
    );
  });

  it('returns 400 when vectors array is missing', async () => {
    const res = await POST(makeRequest({}, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('vectors');
  });

  it('returns 400 when vectors array is empty', async () => {
    const res = await POST(makeRequest({ vectors: [] }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when a vector entry is invalid (missing values)', async () => {
    const res = await POST(
      makeRequest({ vectors: [{ id: 'v-1' }] }, '?providerKey=pv-1'),
      mockParams,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('values');
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await POST(makeRequest({ vectors: sampleVectors }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-license-type missing', async () => {
    const res = await POST(makeRequest({ vectors: sampleVectors }, '?providerKey=pv-1', { 'x-license-type': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 429 when checkPerRequestLimits fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckPerRequestLimits.mockResolvedValueOnce({ allowed: false, reason: 'Dimension limit exceeded', effectiveLimits: {} } as any);
    const res = await POST(makeRequest({ vectors: sampleVectors }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(429);
  });

  it('returns 429 when rate limit fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, reason: 'Too fast' } as any);
    const res = await POST(makeRequest({ vectors: sampleVectors }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(429);
  });

  it('returns 404 for vector index not found error', async () => {
    mockUpsertVectors.mockRejectedValueOnce(new Error('Vector index metadata not found'));
    const res = await POST(makeRequest({ vectors: sampleVectors }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockUpsertVectors.mockRejectedValueOnce(new Error('DB crash'));
    const res = await POST(makeRequest({ vectors: sampleVectors }, '?providerKey=pv-1'), mockParams);
    expect(res.status).toBe(500);
  });
});
