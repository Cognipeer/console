import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  getVectorIndexRecord: vi.fn(),
  updateVectorIndexRecord: vi.fn(),
  decrementVectorCount: vi.fn(),
  getProjectVectorCountApprox: vi.fn().mockResolvedValue(0),
  incrementProjectVectorCountApprox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

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

vi.mock('@/lib/services/vector', () => ({
  getVectorIndex: vi.fn(),
  updateVectorIndex: vi.fn(),
  deleteVectorIndex: vi.fn(),
  queryVectorIndex: vi.fn(),
  upsertVectors: vi.fn(),
  deleteVectors: vi.fn(),
}));

const mockListDescriptors = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock('@/lib/providers', () => ({
  providerRegistry: { listDescriptors: mockListDescriptors },
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn().mockResolvedValue({ allowed: true, effectiveLimits: { quotas: {} } }),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { GET as indexGET, PATCH as indexPATCH, DELETE as indexDELETE } from '@/app/api/client/v1/vector/providers/[providerKey]/indexes/[externalId]/route';
import { POST as queryPOST } from '@/app/api/client/v1/vector/providers/[providerKey]/indexes/[externalId]/query/route';
import { POST as upsertPOST } from '@/app/api/client/v1/vector/providers/[providerKey]/indexes/[externalId]/upsert/route';
import { DELETE as vectorsDELETE } from '@/app/api/client/v1/vector/providers/[providerKey]/indexes/[externalId]/vectors/route';
import { GET as driversGET } from '@/app/api/client/v1/vector/providers/drivers/route';

import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  getVectorIndex,
  updateVectorIndex,
  deleteVectorIndex,
  queryVectorIndex,
  upsertVectors,
  deleteVectors,
} from '@/lib/services/vector';

const mockRequireApiToken = vi.mocked(requireApiToken);
const mockGetVectorIndex = vi.mocked(getVectorIndex);
const mockUpdateVectorIndex = vi.mocked(updateVectorIndex);
const mockDeleteVectorIndex = vi.mocked(deleteVectorIndex);
const mockQueryVectorIndex = vi.mocked(queryVectorIndex);
const mockUpsertVectors = vi.mocked(upsertVectors);
const mockDeleteVectors = vi.mocked(deleteVectors);

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tenant: { licenseType: 'PRO' },
  token: 'tok-1',
  tokenRecord: { _id: 'tr-1', userId: 'user-1' },
  user: { _id: 'user-1', email: 'test@example.com' },
};

const mockIndex = {
  _id: 'idx-1',
  key: 'embeddings',
  name: 'embeddings',
  dimensions: 1536,
  totalVectors: 10,
  metadata: {},
};
const mockProvider = { _id: 'pv-1', key: 'pinecone', label: 'Pinecone', capabilities: {} };
const mockQueryResult = { results: [{ id: 'v-1', score: 0.95, metadata: {} }], count: 1 };
const mockUpsertResult = { upserted: 2 };

const indexParams = { params: Promise.resolve({ providerKey: 'pinecone', externalId: 'embeddings' }) };

function makeReq(method: string, path: string, body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ─── GET index ───────────────────────────────────────────────────────────────

describe('GET /api/client/v1/vector/providers/[providerKey]/indexes/[externalId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetVectorIndex.mockResolvedValue({ index: mockIndex, provider: mockProvider } as any);
  });

  it('returns vector index details', async () => {
    const res = await indexGET(makeReq('GET', '/api/client/v1/vector/providers/pinecone/indexes/embeddings'), indexParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.index).toBeDefined();
    expect(body.provider).toBeDefined();
  });

  it('returns 404 when index not found', async () => {
    mockGetVectorIndex.mockRejectedValueOnce(new Error('vector index record not found'));
    const res = await indexGET(makeReq('GET', '/api/client/v1/vector/providers/pinecone/indexes/embeddings'), indexParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await indexGET(makeReq('GET', '/api/client/v1/vector/providers/pinecone/indexes/embeddings'), indexParams);
    expect(res.status).toBe(401);
  });
});

// ─── PATCH index ──────────────────────────────────────────────────────────────

describe('PATCH /api/client/v1/vector/providers/[providerKey]/indexes/[externalId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateVectorIndex.mockResolvedValue({ index: { ...mockIndex, name: 'updated-name' } } as any);
  });

  it('updates vector index metadata', async () => {
    const res = await indexPATCH(
      makeReq('PATCH', '/api/client/v1/vector/providers/pinecone/indexes/embeddings', { name: 'updated-name' }),
      indexParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.index).toBeDefined();
  });

  it('returns 404 when index not found', async () => {
    mockUpdateVectorIndex.mockRejectedValueOnce(new Error('vector index record not found'));
    const res = await indexPATCH(
      makeReq('PATCH', '/api/client/v1/vector/providers/pinecone/indexes/embeddings', { name: 'new-name' }),
      indexParams,
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await indexPATCH(makeReq('PATCH', '/api/client/v1/vector/providers/pinecone/indexes/embeddings', {}), indexParams);
    expect(res.status).toBe(401);
  });
});

// ─── DELETE index ─────────────────────────────────────────────────────────────

describe('DELETE /api/client/v1/vector/providers/[providerKey]/indexes/[externalId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDeleteVectorIndex.mockResolvedValue(undefined);
  });

  it('deletes a vector index', async () => {
    const res = await indexDELETE(makeReq('DELETE', '/api/client/v1/vector/providers/pinecone/indexes/embeddings'), indexParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when index not found', async () => {
    mockDeleteVectorIndex.mockRejectedValueOnce(new Error('vector index record not found'));
    const res = await indexDELETE(makeReq('DELETE', '/api/client/v1/vector/providers/pinecone/indexes/embeddings'), indexParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await indexDELETE(makeReq('DELETE', '/api/client/v1/vector/providers/pinecone/indexes/embeddings'), indexParams);
    expect(res.status).toBe(401);
  });
});

// ─── Query POST ───────────────────────────────────────────────────────────────

describe('POST /api/client/v1/vector/providers/[providerKey]/indexes/[externalId]/query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQueryVectorIndex.mockResolvedValue(mockQueryResult as any);
  });

  it('queries a vector index', async () => {
    const res = await queryPOST(
      makeReq('POST', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/query', {
        query: { vector: [0.1, 0.2, 0.3], topK: 5 },
      }),
      indexParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBeDefined();
  });

  it('returns 400 when query vector is missing', async () => {
    const res = await queryPOST(
      makeReq('POST', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/query', { query: {} }),
      indexParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await queryPOST(
      makeReq('POST', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/query', { query: { vector: [] } }),
      indexParams,
    );
    expect(res.status).toBe(401);
  });
});

// ─── Upsert POST ──────────────────────────────────────────────────────────────

describe('POST /api/client/v1/vector/providers/[providerKey]/indexes/[externalId]/upsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpsertVectors.mockResolvedValue(mockUpsertResult as any);
  });

  it('upserts vectors', async () => {
    const res = await upsertPOST(
      makeReq('POST', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/upsert', {
        vectors: [
          { id: 'v-1', values: [0.1, 0.2, 0.3], metadata: {} },
          { id: 'v-2', values: [0.4, 0.5, 0.6], metadata: {} },
        ],
      }),
      indexParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 400 when vectors array is missing', async () => {
    const res = await upsertPOST(
      makeReq('POST', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/upsert', {}),
      indexParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid vector entry (missing values)', async () => {
    const res = await upsertPOST(
      makeReq('POST', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/upsert', {
        vectors: [{ id: 'v-1' }],
      }),
      indexParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await upsertPOST(
      makeReq('POST', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/upsert', { vectors: [] }),
      indexParams,
    );
    expect(res.status).toBe(401);
  });
});

// ─── Vectors DELETE ───────────────────────────────────────────────────────────

describe('DELETE /api/client/v1/vector/providers/[providerKey]/indexes/[externalId]/vectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockDeleteVectors.mockResolvedValue(undefined);
  });

  it('deletes vectors by ids', async () => {
    const res = await vectorsDELETE(
      makeReq('DELETE', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/vectors', {
        ids: ['v-1', 'v-2'],
      }),
      indexParams,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 400 when ids array is missing', async () => {
    const res = await vectorsDELETE(
      makeReq('DELETE', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/vectors', {}),
      indexParams,
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await vectorsDELETE(
      makeReq('DELETE', '/api/client/v1/vector/providers/pinecone/indexes/embeddings/vectors', { ids: ['v-1'] }),
      indexParams,
    );
    expect(res.status).toBe(401);
  });
});

// ─── Drivers GET ──────────────────────────────────────────────────────────────

describe('GET /api/client/v1/vector/providers/drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireApiToken.mockResolvedValue(DEFAULT_CTX as any);
    mockListDescriptors.mockReturnValue([
      { id: 'pinecone', label: 'Pinecone' },
      { id: 'weaviate', label: 'Weaviate' },
    ]);
  });

  it('returns available vector drivers', async () => {
    const res = await driversGET(makeReq('GET', '/api/client/v1/vector/providers/drivers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drivers).toHaveLength(2);
  });

  it('returns 401 on auth error', async () => {
    mockRequireApiToken.mockRejectedValueOnce(new ApiTokenAuthError('Unauthorized', 401));
    const res = await driversGET(makeReq('GET', '/api/client/v1/vector/providers/drivers'));
    expect(res.status).toBe(401);
  });
});
