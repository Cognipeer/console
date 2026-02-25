import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock MongoDB — hoist all helpers to be available in mock factories
const mockToArray = vi.hoisted(() => vi.fn());
const mockAggregate = vi.hoisted(() => vi.fn(() => ({ toArray: mockToArray })));
const mockFindOne = vi.hoisted(() => vi.fn());
const mockCollection = vi.hoisted(() =>
  vi.fn(() => ({ aggregate: mockAggregate, findOne: mockFindOne })),
);
const mockClientDb = vi.hoisted(() => vi.fn(() => ({ collection: mockCollection })));
const mockClientConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// MongoClient must be a real class so `new MongoClient(uri)` works
vi.mock('mongodb', () => ({
  MongoClient: class MockMongoClient {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_uri: string) {}
    connect() {
      return mockClientConnect();
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    db(_name?: string) {
      return mockClientDb();
    }
  },
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
}));

import { GET } from '@/app/api/vector/indexes/[externalId]/stats/route';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockRequireProjectContext = vi.mocked(requireProjectContext);

const BASE_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

const statsParams = { params: Promise.resolve({ externalId: 'idx-ext-1' }) };

const mockDailyData = [
  {
    _id: '2025-01-01',
    queryCount: 10,
    avgLatencyMs: 100,
    avgScore: 0.85,
    filterCount: 3,
  },
];
const mockTotalsData = [
  {
    _id: null,
    totalQueries: 50,
    avgLatencyMs: 120,
    avgScore: 0.88,
    minLatencyMs: 50,
    maxLatencyMs: 300,
  },
];
const mockTopKData = [
  { _id: 5, count: 30 },
  { _id: 10, count: 20 },
];

function makeReq(headers?: Record<string, string>, search = '') {
  return new NextRequest(
    `http://localhost/api/vector/indexes/idx-ext-1/stats${search}`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...(headers ?? BASE_HEADERS) },
    },
  );
}

describe('GET /api/vector/indexes/[externalId]/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);

    // Restore MongoDB mock chain (cleared by vi.clearAllMocks)
    mockClientConnect.mockResolvedValue(undefined);
    mockClientDb.mockReturnValue({ collection: mockCollection });
    mockCollection.mockReturnValue({ aggregate: mockAggregate, findOne: mockFindOne });
    mockAggregate.mockReturnValue({ toArray: mockToArray });
    mockFindOne.mockResolvedValue({ key: 'my-index' });

    // Three Promise.all aggregate calls: daily, totals, topK
    mockToArray
      .mockResolvedValueOnce(mockDailyData)
      .mockResolvedValueOnce(mockTotalsData)
      .mockResolvedValueOnce(mockTopKData);
  });

  it('returns 200 with expected response shape', async () => {
    const res = await GET(makeReq(), statsParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('daily');
    expect(body).toHaveProperty('totals');
    expect(body).toHaveProperty('topKDistribution');
    expect(body).toHaveProperty('days');
  });

  it('returns totals with correct numeric fields', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.totals.totalQueries).toBe(50);
    expect(typeof body.totals.avgLatencyMs).toBe('number');
    expect(typeof body.totals.minLatencyMs).toBe('number');
    expect(typeof body.totals.maxLatencyMs).toBe('number');
    expect(typeof body.totals.avgScore).toBe('number');
  });

  it('returns topKDistribution as array with topK and count', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.topKDistribution).toBeInstanceOf(Array);
    expect(body.topKDistribution).toHaveLength(2);
    expect(body.topKDistribution[0]).toMatchObject({ topK: 5, count: 30 });
  });

  it('fills daily array with date strings', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.daily).toBeInstanceOf(Array);
    expect(body.daily.length).toBeGreaterThan(0);
    expect(body.daily[0]).toHaveProperty('date');
    expect(body.daily[0]).toHaveProperty('queryCount');
    expect(body.daily[0]).toHaveProperty('avgLatencyMs');
    expect(body.daily[0]).toHaveProperty('avgScore');
    expect(body.daily[0]).toHaveProperty('filterCount');
  });

  it('defaults days to 30', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.days).toBe(30);
    expect(body.daily).toHaveLength(30);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const { 'x-tenant-db-name': _, ...headersWithout } = BASE_HEADERS;
    const res = await GET(makeReq(headersWithout), statsParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const { 'x-user-id': _, ...headersWithout } = BASE_HEADERS;
    const res = await GET(makeReq(headersWithout), statsParams);
    expect(res.status).toBe(401);
  });

  it('propagates ProjectContextError (403)', async () => {
    const { ProjectContextError: PCE } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new PCE('No project', 403));
    const res = await GET(makeReq(), statsParams);
    expect(res.status).toBe(403);
  });

  it('handles empty aggregate results gracefully (zero totals)', async () => {
    mockToArray
      .mockReset()
      .mockResolvedValueOnce([]) // daily
      .mockResolvedValueOnce([]) // totals
      .mockResolvedValueOnce([]); // topK
    const res = await GET(makeReq(), statsParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.totalQueries).toBe(0);
    expect(body.topKDistribution).toHaveLength(0);
  });

  it('passes providerKey query param to index lookup', async () => {
    mockToArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await GET(makeReq(BASE_HEADERS, '?providerKey=pinecone'), statsParams);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: 'idx-ext-1', providerKey: 'pinecone' }),
      expect.anything(),
    );
  });

  it('accepts days=14 query param and returns correct count', async () => {
    mockToArray
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await GET(makeReq(BASE_HEADERS, '?days=14'), statsParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(14);
    expect(body.daily).toHaveLength(14);
  });

  it('returns 500 on MongoDB error', async () => {
    mockToArray.mockReset().mockRejectedValue(new Error('Mongo crash'));
    const res = await GET(makeReq(), statsParams);
    expect(res.status).toBe(500);
  });
});
