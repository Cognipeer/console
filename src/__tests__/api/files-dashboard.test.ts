import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/files', () => ({
  listFileBuckets: vi.fn(),
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

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
  isDateInDashboardRange: vi.fn().mockReturnValue(true),
}));

import { GET } from '@/app/api/files/dashboard/route';
import { listFileBuckets } from '@/lib/services/files';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockListFileBuckets = vi.mocked(listFileBuckets);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const sampleBuckets = [
  { key: 'bucket-1', name: 'Bucket 1', providerKey: 'prov-1', status: 'active', createdAt: new Date().toISOString() },
  { key: 'bucket-2', name: 'Bucket 2', providerKey: 'prov-1', status: 'disabled', createdAt: new Date().toISOString() },
  { key: 'bucket-3', name: 'Bucket 3', providerKey: 'prov-2', status: 'active', createdAt: new Date().toISOString() },
];

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/files/dashboard', {
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

describe('GET /api/files/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListFileBuckets.mockResolvedValue(sampleBuckets as any);
  });

  it('returns dashboard data on success', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('overview');
    expect(body).toHaveProperty('providerBreakdown');
    expect(body).toHaveProperty('recentBuckets');
  });

  it('overview counts active and disabled buckets correctly', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.overview.totalBuckets).toBe(sampleBuckets.length);
    expect(body.overview.activeBuckets).toBe(2);
    expect(body.overview.disabledBuckets).toBe(1);
  });

  it('provides provider breakdown', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(Array.isArray(body.providerBreakdown)).toBe(true);
    // prov-1 has 2, prov-2 has 1
    const prov1 = body.providerBreakdown.find((p: { providerKey: string }) => p.providerKey === 'prov-1');
    expect(prov1?.count).toBe(2);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await GET(makeRequest({ 'x-tenant-db-name': '' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/files/dashboard', {
      headers: { 'x-tenant-db-name': 'tenant_test', 'x-tenant-id': 'tenant-id-1' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status on context failure', async () => {
    const { ProjectContextError } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new ProjectContextError('No project', 400));
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    mockListFileBuckets.mockRejectedValueOnce(new Error('DB fail'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });

  it('recentBuckets contains at most 6 entries', async () => {
    const manyBuckets = Array.from({ length: 10 }, (_, i) => ({
      key: `bucket-${i}`,
      name: `Bucket ${i}`,
      providerKey: 'prov-1',
      status: 'active',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListFileBuckets.mockResolvedValueOnce(manyBuckets as any);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.recentBuckets.length).toBeLessThanOrEqual(6);
  });

  it('handles empty buckets gracefully', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListFileBuckets.mockResolvedValueOnce([] as any);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.overview.totalBuckets).toBe(0);
    expect(body.recentBuckets).toHaveLength(0);
  });
});
