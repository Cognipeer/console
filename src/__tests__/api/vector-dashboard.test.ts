import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/vector/vectorService', () => ({
  listVectorProviders: vi.fn(),
  listVectorIndexes: vi.fn(),
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

import { GET } from '@/server/api/routes/vector/dashboard/route';
import { listVectorProviders, listVectorIndexes } from '@/lib/services/vector/vectorService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockListVectorProviders = vi.mocked(listVectorProviders);
const mockListVectorIndexes = vi.mocked(listVectorIndexes);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const sampleProviders = [
  { key: 'pv-1', providerKey: 'pv-1', status: 'active', driver: 'pinecone', providerName: 'Pinecone' },
  { key: 'pv-2', providerKey: 'pv-2', status: 'disabled', driver: 'qdrant', providerName: 'Qdrant' },
];

const sampleIndexes = [
  {
    key: 'idx-1',
    name: 'Index 1',
    providerKey: 'pv-1',
    dimension: 1536,
    metric: 'cosine',
    createdAt: new Date().toISOString(),
  },
  {
    key: 'idx-2',
    name: 'Index 2',
    providerKey: 'pv-1',
    dimension: 768,
    metric: 'dotProduct',
    createdAt: new Date().toISOString(),
  },
];

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/vector/dashboard', {
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

describe('GET /api/vector/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorProviders.mockResolvedValue(sampleProviders as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorIndexes.mockResolvedValue(sampleIndexes as any);
  });

  it('returns dashboard overview on success', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('overview');
    expect(body).toHaveProperty('providerBreakdown');
    expect(body).toHaveProperty('recentIndexes');
  });

  it('overview contains correct totals', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.overview.totalProviders).toBe(sampleProviders.length);
    // listVectorIndexes is called once per provider, so totalIndexes = providers * indexes
    expect(body.overview.totalIndexes).toBe(sampleProviders.length * sampleIndexes.length);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await GET(makeRequest({ 'x-tenant-db-name': '' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/vector/dashboard', {
      headers: { 'x-tenant-db-name': 'tenant_test', 'x-user-id': 'user-1' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/vector/dashboard', {
      headers: { 'x-tenant-db-name': 'tenant_test', 'x-tenant-id': 'tenant-id-1' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status when project context fails', async () => {
    const ProjectContextErrorClass = (await import('@/lib/services/projects/projectContext')).ProjectContextError;
    mockRequireProjectContext.mockRejectedValueOnce(
      new ProjectContextErrorClass('No project', 403),
    );
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it('returns 500 when listVectorProviders throws', async () => {
    mockListVectorProviders.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });

  it('handles listVectorIndexes error gracefully (per-provider catch)', async () => {
    // The route catches per-provider errors and returns empty indexes for that provider
    // So the overall response is still 200
    mockListVectorIndexes.mockRejectedValueOnce(new Error('Index error'));
    const res = await GET(makeRequest());
    // Should still succeed because error is caught at provider level
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('overview');
  });

  it('handles empty providers and indexes gracefully', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorProviders.mockResolvedValueOnce([] as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorIndexes.mockResolvedValueOnce([] as any);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overview.totalProviders).toBe(0);
    expect(body.overview.totalIndexes).toBe(0);
    expect(body.recentIndexes).toHaveLength(0);
  });

  it('recentIndexes contains at most 5 entries', async () => {
    const manyIndexes = Array.from({ length: 10 }, (_, i) => ({
      key: `idx-${i}`,
      name: `Index ${i}`,
      providerKey: 'pv-1',
      dimension: 1536,
      metric: 'cosine',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorIndexes.mockResolvedValueOnce(manyIndexes as any);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.recentIndexes.length).toBeLessThanOrEqual(5);
  });

  it('counts active providers in overview', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    // sampleProviders has 1 active, 1 disabled
    expect(body.overview.activeProviders).toBe(1);
    expect(body.overview.disabledProviders).toBe(1);
  });
});
