import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/files', () => ({
  listFileProviders: vi.fn(),
  createFileProvider: vi.fn(),
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

import { GET, POST } from '@/server/api/routes/files/providers/route';
import { listFileProviders, createFileProvider } from '@/lib/services/files';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockListFileProviders = vi.mocked(listFileProviders);
const mockCreateFileProvider = vi.mocked(createFileProvider);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockProviders = [{ key: 'fp-1', driver: 's3', label: 'S3 Storage', status: 'active' }];
const mockProvider = { key: 'fp-2', driver: 's3', label: 'New Provider', status: 'active' };

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/files/providers', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/files/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListFileProviders.mockResolvedValue(mockProviders as any);
  });

  it('returns list of file providers', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(1);
  });

  it('calls listFileProviders with correct args', async () => {
    await GET(makeRequest('GET'));
    expect(mockListFileProviders).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-1',
      expect.any(Object),
    );
  });

  it('returns 401 when headers missing', async () => {
    const res = await GET(makeRequest('GET', undefined, { 'x-tenant-db-name': '' }));
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockListFileProviders.mockRejectedValueOnce(new Error('Service crash'));
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(500);
  });
});

const validBody = {
  key: 'fp-new',
  driver: 's3',
  label: 'My S3 Provider',
  credentials: { bucket: 'my-bucket', region: 'us-east-1' },
};

describe('POST /api/files/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateFileProvider.mockResolvedValue(mockProvider as any);
  });

  it('creates a file provider and returns 201', async () => {
    const res = await POST(makeRequest('POST', validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider).toBeDefined();
  });

  it('returns 400 when key is missing', async () => {
    const res = await POST(makeRequest('POST', { ...validBody, key: '' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('key');
  });

  it('returns 400 when driver is missing', async () => {
    const res = await POST(makeRequest('POST', { ...validBody, driver: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when credentials is missing', async () => {
    const { credentials: _, ...withoutCreds } = validBody;
    const res = await POST(makeRequest('POST', withoutCreds));
    expect(res.status).toBe(400);
  });

  it('returns 401 when headers missing', async () => {
    const res = await POST(makeRequest('POST', validBody, { 'x-user-id': '' }));
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockCreateFileProvider.mockRejectedValueOnce(new Error('Creation failed'));
    const res = await POST(makeRequest('POST', validBody));
    expect(res.status).toBe(500);
  });
});
