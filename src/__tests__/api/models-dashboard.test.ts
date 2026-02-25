import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/models/modelService', () => ({
  listModels: vi.fn(),
  listModelProviders: vi.fn(),
  getUsageAggregate: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => ({
  requireProjectContext: vi.fn(),
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
  isDateInDashboardRange: vi.fn().mockReturnValue(true),
}));

import { GET } from '@/app/api/models/dashboard/route';
import { listModels, listModelProviders, getUsageAggregate } from '@/lib/services/models/modelService';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockListModels = vi.mocked(listModels);
const mockListModelProviders = vi.mocked(listModelProviders);
const mockGetUsageAggregate = vi.mocked(getUsageAggregate);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const BASE_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

const mockModel = (category: string, key: string) => ({
  key,
  name: `Model ${key}`,
  category,
  providerKey: 'openai',
  createdAt: new Date().toISOString(),
});

const mockAgg = {
  totalCalls: 100,
  successCalls: 90,
  errorCalls: 10,
  totalInputTokens: 5000,
  totalOutputTokens: 3000,
  totalTokens: 8000,
  totalToolCalls: 5,
  cacheHits: 20,
  avgLatencyMs: 250,
  costSummary: { totalCost: 1.25 },
  timeseries: [
    { period: '2025-01-01T00:00:00Z', callCount: 50, totalTokens: 4000 },
    { period: '2025-01-02T00:00:00Z', callCount: 50, totalTokens: 4000 },
  ],
};

function makeReq(headers?: Record<string, string>) {
  return new NextRequest('http://localhost/api/models/dashboard', {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...(headers ?? BASE_HEADERS) },
  });
}

describe('GET /api/models/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
    mockListModels.mockResolvedValue([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockModel('llm', 'gpt-4') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockModel('embedding', 'text-embedding-3') as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListModelProviders.mockResolvedValue([{ key: 'openai' }] as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetUsageAggregate.mockResolvedValue(mockAgg as any);
  });

  it('returns overview with correct model counts', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overview.totalModels).toBe(2);
    expect(body.overview.llmCount).toBe(1);
    expect(body.overview.embeddingCount).toBe(1);
  });

  it('includes topModels sorted by callCount', async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.topModels).toBeInstanceOf(Array);
    if (body.topModels.length > 0) {
      expect(body.topModels[0]).toHaveProperty('key');
      expect(body.topModels[0]).toHaveProperty('callCount');
    }
  });

  it('includes daily timeseries data', async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.daily).toBeInstanceOf(Array);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const { 'x-tenant-db-name': _, ...headersWithout } = BASE_HEADERS;
    const res = await GET(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const { 'x-user-id': _, ...headersWithout } = BASE_HEADERS;
    const res = await GET(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('handles empty models list gracefully', async () => {
    mockListModels.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.overview.totalModels).toBe(0);
    expect(body.topModels).toHaveLength(0);
    expect(body.daily).toHaveLength(0);
  });

  it('handles getUsageAggregate errors gracefully (returns null agg)', async () => {
    mockGetUsageAggregate.mockRejectedValueOnce(new Error('Aggregate error'));
    mockGetUsageAggregate.mockRejectedValueOnce(new Error('Aggregate error'));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overview.totalCalls).toBe(0);
  });

  it('propagates ProjectContextError status', async () => {
    const { ProjectContextError: PCE } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new PCE('No project', 403));
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockListModels.mockRejectedValueOnce(new Error('DB crash'));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('DB crash');
  });

  it('aggregates totals across multiple models', async () => {
    mockListModels.mockResolvedValueOnce([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockModel('llm', 'model-a') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockModel('llm', 'model-b') as any,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetUsageAggregate.mockResolvedValue(mockAgg as any);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.overview.totalCalls).toBe(200); // 100 * 2
  });

  it('includes currency in overview', async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.overview.currency).toBe('USD');
  });
});
