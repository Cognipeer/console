import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/vector', () => ({
  listVectorIndexes: vi.fn(),
  createVectorIndex: vi.fn(),
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
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true } as any),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true } as any),
}));

import { GET, POST } from '@/app/api/vector/indexes/route';
import { listVectorIndexes, createVectorIndex } from '@/lib/services/vector';
import { requireProjectContext } from '@/lib/services/projects/projectContext';
import { checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';

const mockListVectorIndexes = vi.mocked(listVectorIndexes);
const mockCreateVectorIndex = vi.mocked(createVectorIndex);
const mockRequireProjectContext = vi.mocked(requireProjectContext);
const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockCheckResourceQuota = vi.mocked(checkResourceQuota);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const sampleIndexes = [
  { _id: 'idx-1', key: 'idx-1', name: 'Index One', providerKey: 'pv-1', dimension: 1536, metric: 'cosine', tenantId: 'tenant-id-1' },
];

const sampleIndex = { _id: 'new-1', key: 'new-1', name: 'New Index', providerKey: 'pv-1', dimension: 768, metric: 'cosine' };

function makeGetRequest(search = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/vector/indexes${search}`, {
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

function makePostRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/vector/indexes', {
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

describe('GET /api/vector/indexes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorIndexes.mockResolvedValue(sampleIndexes as any);
  });

  it('returns indexes for a provider', async () => {
    const res = await GET(makeGetRequest('?providerKey=pv-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('indexes');
    expect(body.indexes).toHaveLength(1);
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('providerKey');
  });

  it('returns 401 when x-tenant-db-name missing', async () => {
    const res = await GET(makeGetRequest('?providerKey=pv-1', { 'x-tenant-db-name': '' }));
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status on context failure', async () => {
    const { ProjectContextError } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new ProjectContextError('No project', 400));
    const res = await GET(makeGetRequest('?providerKey=pv-1'));
    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    mockListVectorIndexes.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeGetRequest('?providerKey=pv-1'));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/vector/indexes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorIndexes.mockResolvedValue([] as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateVectorIndex.mockResolvedValue(sampleIndex as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValue({ allowed: true } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckResourceQuota.mockResolvedValue({ allowed: true } as any);
  });

  it('creates vector index and returns 201', async () => {
    const res = await POST(makePostRequest({ providerKey: 'pv-1', name: 'My Index', dimension: 1536 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('index');
  });

  it('returns 400 when providerKey is missing', async () => {
    const res = await POST(makePostRequest({ name: 'My Index', dimension: 1536 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('providerKey');
  });

  it('returns 400 when name is missing', async () => {
    const res = await POST(makePostRequest({ providerKey: 'pv-1', dimension: 1536 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when dimension is invalid', async () => {
    const res = await POST(makePostRequest({ providerKey: 'pv-1', name: 'Test', dimension: -5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('dimension');
  });

  it('returns existing index when name matches (reuse)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListVectorIndexes.mockResolvedValueOnce([{ ...sampleIndexes[0], name: 'Index One' }] as any);
    const res = await POST(makePostRequest({ providerKey: 'pv-1', name: 'index one', dimension: 1536 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reused).toBe(true);
  });

  it('returns 429 when rate limit exceeded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, reason: 'Too many requests' } as any);
    const res = await POST(makePostRequest({ providerKey: 'pv-1', name: 'Test', dimension: 1536 }));
    expect(res.status).toBe(429);
  });

  it('returns 429 when resource quota exceeded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckResourceQuota.mockResolvedValueOnce({ allowed: false, reason: 'Quota exceeded' } as any);
    const res = await POST(makePostRequest({ providerKey: 'pv-1', name: 'Test', dimension: 1536 }));
    expect(res.status).toBe(429);
  });

  it('returns 401 when x-license-type is missing', async () => {
    const res = await POST(makePostRequest({ providerKey: 'pv-1', name: 'Test', dimension: 1536 }, { 'x-license-type': '' }));
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockCreateVectorIndex.mockRejectedValueOnce(new Error('DB crash'));
    const res = await POST(makePostRequest({ providerKey: 'pv-1', name: 'New', dimension: 1536 }));
    expect(res.status).toBe(500);
  });
});
