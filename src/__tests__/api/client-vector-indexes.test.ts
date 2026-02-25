import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireApiToken: vi.fn(),
    ApiTokenAuthError,
  };
});

vi.mock('@/lib/services/vector', () => ({
  listVectorIndexes: vi.fn(),
  createVectorIndex: vi.fn(),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { GET, POST } from '@/app/api/client/v1/vector/providers/[providerKey]/indexes/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listVectorIndexes, createVectorIndex } from '@/lib/services/vector';
import { checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  token: 'tok_abc',
  tokenRecord: { _id: 'token-id-1', userId: 'user-1' },
  tenant: { licenseType: 'STARTER' },
};

const ROUTE_CTX = {
  params: Promise.resolve({ providerKey: 'qdrant-main' }),
};

function makeGetReq(): NextRequest {
  return new NextRequest('http://localhost/api/client/v1/vector/providers/qdrant-main/indexes', {
    method: 'GET',
  });
}

function makePostReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/client/v1/vector/providers/qdrant-main/indexes', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const VALID_INDEX = {
  _id: 'idx-1',
  key: 'my-index',
  name: 'My Index',
  externalId: 'qdrant-col-1',
  dimension: 1536,
  metric: 'cosine',
  status: 'active',
  metadata: {},
};

describe('GET /api/client/v1/vector/providers/:providerKey/indexes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  it('returns 200 with serialized indexes', async () => {
    (listVectorIndexes as ReturnType<typeof vi.fn>).mockResolvedValue([VALID_INDEX]);

    const res = await GET(makeGetReq(), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.indexes).toHaveLength(1);
    expect(json.indexes[0]).toMatchObject({
      key: 'my-index',
      indexId: 'my-index',
      metadata: {},
    });
  });

  it('calls listVectorIndexes with correct args including providerKey', async () => {
    (listVectorIndexes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeGetReq(), ROUTE_CTX);

    expect(listVectorIndexes).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      'qdrant-main',
    );
  });

  it('returns empty indexes list when provider has no indexes', async () => {
    (listVectorIndexes as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await GET(makeGetReq(), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.indexes).toEqual([]);
  });

  it('returns 401 on auth error', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid token', 401),
    );

    const res = await GET(makeGetReq(), ROUTE_CTX);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    (listVectorIndexes as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Storage error'),
    );

    const res = await GET(makeGetReq(), ROUTE_CTX);
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.error).toBe('Storage error');
  });
});

describe('POST /api/client/v1/vector/providers/:providerKey/indexes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
    (listVectorIndexes as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
  });

  const validBody = { name: 'customer-vectors', dimension: 1536, metric: 'cosine' };

  it('returns 201 with created index', async () => {
    const created = { ...VALID_INDEX, name: 'customer-vectors' };
    (createVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const res = await POST(makePostReq(validBody), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.index).toMatchObject({ name: 'customer-vectors' });
  });

  it('returns 400 when name is missing', async () => {
    const res = await POST(makePostReq({ dimension: 1536 }), ROUTE_CTX);
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain('name');
  });

  it('returns 400 when dimension is missing', async () => {
    const res = await POST(makePostReq({ name: 'my-index' }), ROUTE_CTX);
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toContain('dimension');
  });

  it('returns 400 when dimension is not a positive number', async () => {
    const res = await POST(makePostReq({ name: 'my-index', dimension: -5 }), ROUTE_CTX);
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/dimension/i);
  });

  it('returns 400 when dimension is zero', async () => {
    const res = await POST(makePostReq({ name: 'my-index', dimension: 0 }), ROUTE_CTX);
    const json = await res.json();
    expect(res.status).toBe(400);
  });

  it('returns 200 with reused:true when index with same name exists', async () => {
    (listVectorIndexes as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...VALID_INDEX, name: 'customer-vectors' },
    ]);

    const res = await POST(makePostReq(validBody), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.reused).toBe(true);
    expect(createVectorIndex).not.toHaveBeenCalled();
  });

  it('deduplicates by normalized name (case + whitespace insensitive)', async () => {
    (listVectorIndexes as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...VALID_INDEX, name: '  Customer-Vectors  ' },
    ]);

    const res = await POST(makePostReq({ ...validBody, name: 'customer-vectors' }), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.reused).toBe(true);
  });

  it('returns 429 when rate limit exceeded', async () => {
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Too many requests',
    });

    const res = await POST(makePostReq(validBody), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toBe('Too many requests');
  });

  it('returns 429 when resource quota exceeded', async () => {
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
      reason: 'Index limit reached',
    });

    const res = await POST(makePostReq(validBody), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toBe('Index limit reached');
  });

  it('returns 401 on auth error', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Unauthorized', 401),
    );

    const res = await POST(makePostReq(validBody), ROUTE_CTX);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    (createVectorIndex as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Index creation failed'),
    );

    const res = await POST(makePostReq(validBody), ROUTE_CTX);
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.error).toBe('Index creation failed');
  });

  it('passes providerKey to createVectorIndex', async () => {
    const created = { ...VALID_INDEX };
    (createVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    await POST(makePostReq(validBody), ROUTE_CTX);

    expect(createVectorIndex).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ providerKey: 'qdrant-main' }),
    );
  });
});
