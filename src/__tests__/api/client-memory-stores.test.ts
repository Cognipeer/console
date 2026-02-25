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

vi.mock('@/lib/services/memory/memoryService', () => ({
  listMemoryStores: vi.fn(),
  createMemoryStore: vi.fn(),
}));

import { GET, POST } from '@/app/api/client/v1/memory/stores/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listMemoryStores, createMemoryStore } from '@/lib/services/memory/memoryService';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
  user: { email: 'user@example.com' },
};

function makeReq(url = 'http://localhost/api/client/v1/memory/stores', body?: object): NextRequest {
  return new NextRequest(url, body ? {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  } : { method: 'GET' });
}

describe('GET /api/client/v1/memory/stores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  it('returns 200 with stores list', async () => {
    const stores = [{ _id: 's1', name: 'My Store', vectorProviderKey: 'qdrant' }];
    (listMemoryStores as ReturnType<typeof vi.fn>).mockResolvedValue(stores);

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stores).toEqual(stores);
  });

  it('passes status filter to service', async () => {
    (listMemoryStores as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq('http://localhost/api/client/v1/memory/stores?status=active'));

    expect(listMemoryStores).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('passes search filter to service', async () => {
    (listMemoryStores as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq('http://localhost/api/client/v1/memory/stores?search=my+store'));

    expect(listMemoryStores).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ search: 'my store' }),
    );
  });

  it('returns 401 on ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid token', 401),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Invalid token');
  });

  it('returns 500 on unexpected error', async () => {
    (listMemoryStores as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB unavailable'),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(500);
  });
});

describe('POST /api/client/v1/memory/stores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  const validBody = {
    name: 'Customer Memory',
    vectorProviderKey: 'qdrant-main',
    embeddingModelKey: 'text-embedding-3-small',
  };

  it('returns 201 with created store', async () => {
    const created = { _id: 'store-1', ...validBody };
    (createMemoryStore as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const res = await POST(makeReq(undefined, validBody));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.store).toEqual(created);
  });

  it('passes createdBy from user email when available', async () => {
    (createMemoryStore as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 's1' });

    await POST(makeReq(undefined, validBody));

    expect(createMemoryStore).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ createdBy: 'user@example.com' }),
    );
  });

  it('falls back to tokenRecord.userId when user.email is absent', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_CTX,
      user: undefined,
    });
    (createMemoryStore as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 's1' });

    await POST(makeReq(undefined, validBody));

    expect(createMemoryStore).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ createdBy: 'user-1' }),
    );
  });

  it('returns 400 when name is missing', async () => {
    const body = { ...validBody };
    delete (body as Record<string, unknown>)['name'];

    const res = await POST(makeReq(undefined, body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/name/i);
  });

  it('returns 400 when vectorProviderKey is missing', async () => {
    const body = { ...validBody };
    delete (body as Record<string, unknown>)['vectorProviderKey'];

    const res = await POST(makeReq(undefined, body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/vectorProviderKey/i);
  });

  it('returns 400 when embeddingModelKey is missing', async () => {
    const body = { ...validBody };
    delete (body as Record<string, unknown>)['embeddingModelKey'];

    const res = await POST(makeReq(undefined, body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/embeddingModelKey/i);
  });

  it('passes optional config to service', async () => {
    (createMemoryStore as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 's1' });

    await POST(makeReq(undefined, { ...validBody, config: { maxItems: 1000 } }));

    expect(createMemoryStore).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ config: { maxItems: 1000 } }),
    );
  });

  it('returns 403 on ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Forbidden', 403),
    );

    const res = await POST(makeReq(undefined, validBody));
    expect(res.status).toBe(403);
  });

  it('returns 500 on service error', async () => {
    (createMemoryStore as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Failed to create store'),
    );

    const res = await POST(makeReq(undefined, validBody));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to create store');
  });
});
