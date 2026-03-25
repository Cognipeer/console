import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/vector', () => ({
  createVectorProvider: vi.fn(),
  listVectorProviders: vi.fn(),
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

import { GET, POST } from '@/server/api/routes/vector/providers/route';
import { createVectorProvider, listVectorProviders } from '@/lib/services/vector';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = HEADERS) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MOCK_PROJECT = { projectId: 'proj-1' };
const MOCK_PROVIDER = {
  _id: 'vprov-1',
  key: 'pinecone-main',
  driver: 'pinecone',
  label: 'Pinecone Main',
  status: 'active',
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  (listVectorProviders as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PROVIDER]);
  (createVectorProvider as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROVIDER);
});

describe('GET /api/vector/providers', () => {
  it('returns vector providers 200', async () => {
    const req = makeReq('/api/vector/providers');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.providers).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/vector/providers', 'GET', undefined, {});
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('passes driver filter', async () => {
    const req = makeReq('/api/vector/providers?driver=pinecone');
    await GET(req);
    expect(listVectorProviders).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({ driver: 'pinecone' }));
  });

  it('passes status filter', async () => {
    const req = makeReq('/api/vector/providers?status=active');
    await GET(req);
    expect(listVectorProviders).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({ status: 'active' }));
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await GET(makeReq('/api/vector/providers'));
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (listVectorProviders as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await GET(makeReq('/api/vector/providers'));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/vector/providers', () => {
  const VALID_BODY = {
    key: 'pinecone-main',
    driver: 'pinecone',
    label: 'Pinecone Main',
    credentials: { apiKey: 'pc-abc123' },
  };

  it('creates vector provider and returns 201', async () => {
    const req = makeReq('/api/vector/providers', 'POST', VALID_BODY);
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.provider).toBeDefined();
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/vector/providers', 'POST', VALID_BODY, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when key is missing', async () => {
    const { key: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/vector/providers', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('key');
  });

  it('returns 400 when driver is missing', async () => {
    const { driver: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/vector/providers', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when label is missing', async () => {
    const { label: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/vector/providers', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when credentials is missing', async () => {
    const { credentials: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/vector/providers', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('passes correct args to createVectorProvider', async () => {
    const req = makeReq('/api/vector/providers', 'POST', { ...VALID_BODY, description: 'My vector' });
    await POST(req);
    expect(createVectorProvider).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({
      key: 'pinecone-main',
      driver: 'pinecone',
      createdBy: 'user-1',
    }));
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('Forbidden', 403);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await POST(makeReq('/api/vector/providers', 'POST', VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    (createVectorProvider as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await POST(makeReq('/api/vector/providers', 'POST', VALID_BODY));
    expect(res.status).toBe(500);
  });
});
