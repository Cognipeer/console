import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/files', () => ({
  listFileBuckets: vi.fn(),
  createFileBucket: vi.fn(),
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
  checkResourceQuota: vi.fn(),
}));

import { GET, POST } from '@/server/api/routes/files/buckets/route';
import { listFileBuckets, createFileBucket } from '@/lib/services/files';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';

const mockListFileBuckets = listFileBuckets as ReturnType<typeof vi.fn>;
const mockCreateFileBucket = createFileBucket as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;
const mockCheckResourceQuota = checkResourceQuota as ReturnType<typeof vi.fn>;

const mockContext = { projectId: 'project-1' };
const mockBucket = {
  _id: 'bucket-1',
  key: 'my-bucket',
  name: 'My Bucket',
  providerKey: 'minio-1',
};

function makeRequest(opts: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const method = opts.method ?? 'GET';
  return new NextRequest('http://localhost/api/files/buckets', {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'x-license-type': 'pro',
      'content-type': 'application/json',
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/files/buckets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns buckets list', async () => {
    mockListFileBuckets.mockResolvedValue([mockBucket]);
    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].key).toBe('my-bucket');
  });

  it('returns empty list when no buckets', async () => {
    mockListFileBuckets.mockResolvedValue([]);
    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.buckets).toHaveLength(0);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/files/buckets');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockListFileBuckets.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/files/buckets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
    mockListFileBuckets.mockResolvedValue([]);
    mockCheckResourceQuota.mockResolvedValue({ allowed: true });
  });

  it('creates a bucket and returns 201', async () => {
    mockCreateFileBucket.mockResolvedValue(mockBucket);
    const req = makeRequest({
      method: 'POST',
      body: { key: 'my-bucket', name: 'My Bucket', providerKey: 'minio-1' },
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.bucket.key).toBe('my-bucket');
  });

  it('returns 400 when key is missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { name: 'My Bucket', providerKey: 'minio-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { key: 'my-bucket', providerKey: 'minio-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when providerKey is missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { key: 'my-bucket', name: 'My Bucket' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 when licenseType missing', async () => {
    const req = makeRequest({
      method: 'POST',
      body: { key: 'my-bucket', name: 'My Bucket', providerKey: 'minio-1' },
      headers: { 'x-license-type': '' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 429 when quota exceeded', async () => {
    mockCheckResourceQuota.mockResolvedValue({
      allowed: false,
      reason: 'Quota exceeded',
    });
    const req = makeRequest({
      method: 'POST',
      body: { key: 'my-bucket', name: 'My Bucket', providerKey: 'minio-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it('returns 401 when required headers missing', async () => {
    const req = new NextRequest('http://localhost/api/files/buckets', {
      method: 'POST',
      body: JSON.stringify({ key: 'k', name: 'n', providerKey: 'p' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('Forbidden', 403),
    );
    const req = makeRequest({
      method: 'POST',
      body: { key: 'my-bucket', name: 'My Bucket', providerKey: 'minio-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockCreateFileBucket.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({
      method: 'POST',
      body: { key: 'my-bucket', name: 'My Bucket', providerKey: 'minio-1' },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
