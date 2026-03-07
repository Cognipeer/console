import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/memory/memoryService', () => ({
  getMemoryStore: vi.fn(),
  updateMemoryStore: vi.fn(),
  deleteMemoryStore: vi.fn(),
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

import { GET, PATCH, DELETE } from '@/server/api/routes/memory/stores/[storeKey]/route';
import {
  getMemoryStore,
  updateMemoryStore,
  deleteMemoryStore,
} from '@/lib/services/memory/memoryService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockGetMemoryStore = getMemoryStore as ReturnType<typeof vi.fn>;
const mockUpdateMemoryStore = updateMemoryStore as ReturnType<typeof vi.fn>;
const mockDeleteMemoryStore = deleteMemoryStore as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ storeKey: 'store-abc' }) };
const mockContext = { projectId: 'project-1' };
const mockStore = { _id: 'store-1', storeKey: 'store-abc', name: 'Test Store', type: 'buffer' };

function makeRequest(opts: { method?: string; body?: unknown } = {}) {
  const method = opts.method ?? 'GET';
  return new NextRequest('http://localhost/api/memory/stores/store-abc', {
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

describe('GET /api/memory/stores/[storeKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns store on success', async () => {
    mockGetMemoryStore.mockResolvedValue(mockStore);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.storeKey).toBe('store-abc');
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/memory/stores/store-abc');
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetMemoryStore.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });

  it('calls service with correct args', async () => {
    mockGetMemoryStore.mockResolvedValue(mockStore);
    const req = makeRequest();
    await GET(req, mockParams);
    expect(mockGetMemoryStore).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      'store-abc',
    );
  });
});

describe('PATCH /api/memory/stores/[storeKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('updates store and returns it', async () => {
    const updated = { ...mockStore, name: 'Updated Store' };
    mockUpdateMemoryStore.mockResolvedValue(updated);
    const req = makeRequest({ method: 'PATCH', body: { name: 'Updated Store' } });
    const res = await PATCH(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.name).toBe('Updated Store');
  });

  it('passes updatedBy to service', async () => {
    mockUpdateMemoryStore.mockResolvedValue(mockStore);
    const req = makeRequest({ method: 'PATCH', body: { name: 'x' } });
    await PATCH(req, mockParams);
    expect(mockUpdateMemoryStore).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      'store-abc',
      expect.objectContaining({ updatedBy: 'user-1' }),
    );
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/memory/stores/store-abc', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('Forbidden', 403),
    );
    const req = makeRequest({ method: 'PATCH', body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockUpdateMemoryStore.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'PATCH', body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/memory/stores/[storeKey]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('deletes store and returns success', async () => {
    mockDeleteMemoryStore.mockResolvedValue(undefined);
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/memory/stores/store-abc', {
      method: 'DELETE',
    });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('calls service with correct args', async () => {
    mockDeleteMemoryStore.mockResolvedValue(undefined);
    const req = makeRequest({ method: 'DELETE' });
    await DELETE(req, mockParams);
    expect(mockDeleteMemoryStore).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      'store-abc',
    );
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No project', 400),
    );
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteMemoryStore.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(500);
  });
});
