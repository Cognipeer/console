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
  listVectorProviders: vi.fn(),
  createVectorProvider: vi.fn(),
}));

import { GET, POST } from '@/server/api/routes/client/v1/vector/providers/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { listVectorProviders, createVectorProvider } from '@/lib/services/vector';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

function makeReq(url = 'http://localhost/api/client/v1/vector/providers', body?: object): NextRequest {
  return new NextRequest(url, body ? {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  } : { method: 'GET' });
}

describe('GET /api/client/v1/vector/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  it('returns 200 with providers list', async () => {
    const providers = [{ _id: 'p1', key: 'qdrant', driver: 'qdrant', label: 'Qdrant' }];
    (listVectorProviders as ReturnType<typeof vi.fn>).mockResolvedValue(providers);

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.providers).toEqual(providers);
  });

  it('passes status query param to service', async () => {
    (listVectorProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq('http://localhost/api/client/v1/vector/providers?status=active'));

    expect(listVectorProviders).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ status: 'active' }),
    );
  });

  it('passes driver query param to service', async () => {
    (listVectorProviders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await GET(makeReq('http://localhost/api/client/v1/vector/providers?driver=qdrant'));

    expect(listVectorProviders).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ driver: 'qdrant' }),
    );
  });

  it('returns 401 on ApiTokenAuthError with 401', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Invalid token', 401),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Invalid token');
  });

  it('returns 403 on ApiTokenAuthError with 403', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Forbidden', 403),
    );

    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    (listVectorProviders as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB connection failed'),
    );

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('DB connection failed');
  });
});

describe('POST /api/client/v1/vector/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  const validBody = {
    key: 'qdrant-main',
    driver: 'qdrant',
    label: 'Main Qdrant',
    credentials: { apiKey: 'secret' },
  };

  it('returns 201 with created provider', async () => {
    const created = { _id: 'prov-1', ...validBody, tenantId: 'tenant-1' };
    (createVectorProvider as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const res = await POST(makeReq(undefined, validBody));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.provider).toEqual(created);
  });

  it('passes correct arguments to createVectorProvider', async () => {
    (createVectorProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 'prov-1' });

    await POST(makeReq(undefined, { ...validBody, description: 'My Qdrant' }));

    expect(createVectorProvider).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({
        key: 'qdrant-main',
        driver: 'qdrant',
        label: 'Main Qdrant',
        description: 'My Qdrant',
        credentials: { apiKey: 'secret' },
        createdBy: 'user-1',
      }),
    );
  });

  it.each(['key', 'driver', 'label', 'credentials'])('returns 400 when %s is missing', async (field) => {
    const body = { ...validBody, [field]: undefined };
    delete (body as Record<string, unknown>)[field];

    const res = await POST(makeReq(undefined, body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain(field);
  });

  it('returns 400 when required field is empty string', async () => {
    const res = await POST(makeReq(undefined, { ...validBody, key: '' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('key');
  });

  it('returns 401 on ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Unauthorized', 401),
    );

    const res = await POST(makeReq(undefined, validBody));
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected service error', async () => {
    (createVectorProvider as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Provider creation failed'),
    );

    const res = await POST(makeReq(undefined, validBody));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Provider creation failed');
  });
});
