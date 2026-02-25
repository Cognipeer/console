import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/models/modelService', () => ({
  listModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
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

import { GET, POST } from '@/app/api/models/providers/route';
import { listModelProviders, createModelProvider } from '@/lib/services/models/modelService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockListModelProviders = listModelProviders as ReturnType<typeof vi.fn>;
const mockCreateModelProvider = createModelProvider as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockContext = { projectId: 'project-1' };

const mockProvider = {
  _id: 'prov-1',
  key: 'openai-1',
  label: 'OpenAI Main',
  driver: 'openai',
  status: 'active',
};

function makeRequest(opts: {
  method?: string;
  body?: unknown;
  searchParams?: string;
} = {}) {
  const method = opts.method ?? 'GET';
  const url = `http://localhost/api/models/providers${opts.searchParams ? '?' + opts.searchParams : ''}`;
  return new NextRequest(url, {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'content-type': 'application/json',
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/models/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns providers list', async () => {
    mockListModelProviders.mockResolvedValue([mockProvider]);
    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].key).toBe('openai-1');
  });

  it('returns empty list when no providers', async () => {
    mockListModelProviders.mockResolvedValue([]);
    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.providers).toHaveLength(0);
  });

  it('passes status and driver filters', async () => {
    mockListModelProviders.mockResolvedValue([]);
    const req = makeRequest({ searchParams: 'status=active&driver=openai' });
    await GET(req);
    expect(mockListModelProviders).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      expect.objectContaining({ status: 'active', driver: 'openai' }),
    );
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/models/providers');
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
    mockListModelProviders.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/models/providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('creates a provider and returns 201', async () => {
    mockCreateModelProvider.mockResolvedValue(mockProvider);
    const req = makeRequest({
      method: 'POST',
      body: { key: 'openai-1', label: 'OpenAI Main', driver: 'openai', credentials: {} },
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.provider.key).toBe('openai-1');
  });

  it('returns 400 when required fields missing', async () => {
    const req = makeRequest({ method: 'POST', body: { key: 'openai-1' } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/models/providers', {
      method: 'POST',
      body: JSON.stringify({ key: 'x', label: 'y', driver: 'z' }),
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
      body: { key: 'k', label: 'l', driver: 'd', credentials: {} },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockCreateModelProvider.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({
      method: 'POST',
      body: { key: 'k', label: 'l', driver: 'd', credentials: {} },
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
