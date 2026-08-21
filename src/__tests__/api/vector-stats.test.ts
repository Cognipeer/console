/**
 * API tests — GET /api/vector/indexes/[externalId]/stats
 *
 * The endpoint reads query analytics through the database abstraction
 * (`aggregateVectorQueryStats`), so it works on every backend. These tests
 * cover the shaping the panel depends on: a zero-filled day series, rounded
 * averages, and the index-key lookup the aggregation is scoped by.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

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

import { GET } from '@/server/api/routes/vector/indexes/[externalId]/stats/route';
import { getDatabase } from '@/lib/database';
import { requireProjectContext } from '@/lib/services/projects/projectContext';
import { createMockDb } from '../helpers/db.mock';

const mockRequireProjectContext = vi.mocked(requireProjectContext);

const BASE_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

const statsParams = { params: Promise.resolve({ externalId: 'idx-ext-1' }) };

const INDEX_RECORD = {
  _id: 'idx-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  providerKey: 'pinecone',
  key: 'my-index',
  name: 'My Index',
  externalId: 'idx-ext-1',
  dimension: 1536,
  metric: 'cosine' as const,
  createdBy: 'user-1',
};

const EMPTY_STATS = {
  daily: [],
  totals: {
    totalQueries: 0,
    avgLatencyMs: null,
    avgScore: null,
    minLatencyMs: null,
    maxLatencyMs: null,
  },
  topKDistribution: [],
};

const POPULATED_STATS = {
  daily: [
    { date: '2025-01-01', queryCount: 10, avgLatencyMs: 100.4, avgScore: 0.85, filterCount: 3 },
  ],
  totals: {
    totalQueries: 50,
    avgLatencyMs: 120.6,
    avgScore: 0.881234,
    minLatencyMs: 50,
    maxLatencyMs: 300,
  },
  topKDistribution: [
    { topK: 5, count: 30 },
    { topK: 10, count: 20 },
  ],
};

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
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);

    db = createMockDb();
    db.findVectorIndexByExternalId.mockResolvedValue(INDEX_RECORD);
    db.listVectorIndexes.mockResolvedValue([INDEX_RECORD]);
    db.aggregateVectorQueryStats.mockResolvedValue(POPULATED_STATS);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns 200 with the expected response shape', async () => {
    const res = await GET(makeReq(), statsParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('daily');
    expect(body).toHaveProperty('totals');
    expect(body).toHaveProperty('topKDistribution');
    expect(body).toHaveProperty('days');
  });

  it('rounds latency and score in totals', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.totals.totalQueries).toBe(50);
    expect(body.totals.avgLatencyMs).toBe(121);
    expect(body.totals.avgScore).toBe(0.8812);
    expect(body.totals.minLatencyMs).toBe(50);
    expect(body.totals.maxLatencyMs).toBe(300);
  });

  it('returns topKDistribution as-is', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.topKDistribution).toEqual([
      { topK: 5, count: 30 },
      { topK: 10, count: 20 },
    ]);
  });

  it('zero-fills every day in the window', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.daily).toHaveLength(30);
    for (const day of body.daily) {
      expect(day).toMatchObject({
        date: expect.any(String),
        queryCount: expect.any(Number),
        avgLatencyMs: expect.any(Number),
        avgScore: expect.any(Number),
        filterCount: expect.any(Number),
      });
    }
  });

  it('scopes the aggregation to the index key, not the external id', async () => {
    await GET(makeReq(BASE_HEADERS, '?providerKey=pinecone'), statsParams);

    expect(db.findVectorIndexByExternalId).toHaveBeenCalledWith(
      'pinecone',
      'idx-ext-1',
      'proj-1',
    );
    expect(db.aggregateVectorQueryStats).toHaveBeenCalledWith(
      expect.objectContaining({ indexKey: 'my-index' }),
    );
  });

  it('finds the index by external id when no providerKey is given', async () => {
    await GET(makeReq(), statsParams);

    expect(db.listVectorIndexes).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(db.aggregateVectorQueryStats).toHaveBeenCalledWith(
      expect.objectContaining({ indexKey: 'my-index' }),
    );
  });

  it('falls back to the external id when no index record matches', async () => {
    db.listVectorIndexes.mockResolvedValue([]);
    const res = await GET(makeReq(), statsParams);

    expect(res.status).toBe(200);
    expect(db.aggregateVectorQueryStats).toHaveBeenCalledWith(
      expect.objectContaining({ indexKey: 'idx-ext-1' }),
    );
  });

  it('defaults days to 30', async () => {
    const res = await GET(makeReq(), statsParams);
    const body = await res.json();
    expect(body.days).toBe(30);
    expect(body.daily).toHaveLength(30);
  });

  it('accepts days=14 and returns that many buckets', async () => {
    const res = await GET(makeReq(BASE_HEADERS, '?days=14'), statsParams);
    const body = await res.json();
    expect(body.days).toBe(14);
    expect(body.daily).toHaveLength(14);
  });

  it('handles an empty window as zero totals', async () => {
    db.aggregateVectorQueryStats.mockResolvedValue(EMPTY_STATS);
    const res = await GET(makeReq(), statsParams);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.totalQueries).toBe(0);
    expect(body.totals.avgLatencyMs).toBe(0);
    expect(body.totals.avgScore).toBe(0);
    expect(body.topKDistribution).toHaveLength(0);
    expect(body.daily.every((d: { queryCount: number }) => d.queryCount === 0)).toBe(true);
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

  it('returns 500 when the aggregation fails', async () => {
    db.aggregateVectorQueryStats.mockRejectedValue(new Error('backend crash'));
    const res = await GET(makeReq(), statsParams);
    expect(res.status).toBe(500);
  });
});
