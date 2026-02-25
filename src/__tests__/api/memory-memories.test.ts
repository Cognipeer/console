import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/memory/memoryService', () => ({
  listMemoryItems: vi.fn(),
  searchMemories: vi.fn(),
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

import { GET } from '@/app/api/memory/stores/[storeKey]/memories/route';
import { listMemoryItems, searchMemories } from '@/lib/services/memory/memoryService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockListMemoryItems = listMemoryItems as ReturnType<typeof vi.fn>;
const mockSearchMemories = searchMemories as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ storeKey: 'store-abc' }) };
const mockContext = { projectId: 'project-1' };

const mockMemoryItems = {
  items: [
    { _id: 'mem-1', content: 'Hello world', score: 0.9 },
    { _id: 'mem-2', content: 'Foo bar', score: 0.7 },
  ],
  total: 2,
};

function makeRequest(searchParams = '') {
  return new NextRequest(
    `http://localhost/api/memory/stores/store-abc/memories${searchParams ? '?' + searchParams : ''}`,
    {
      headers: {
        'x-tenant-db-name': 'tenant_acme',
        'x-tenant-id': 'tenant-1',
        'x-user-id': 'user-1',
      },
    },
  );
}

describe('GET /api/memory/stores/[storeKey]/memories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns paginated memory items', async () => {
    mockListMemoryItems.mockResolvedValue(mockMemoryItems);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('calls listMemoryItems with page/limit', async () => {
    mockListMemoryItems.mockResolvedValue(mockMemoryItems);
    const req = makeRequest('page=2&limit=10');
    await GET(req, mockParams);
    expect(mockListMemoryItems).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      'store-abc',
      expect.objectContaining({ skip: 10, limit: 10 }),
    );
  });

  it('uses semantic search when query param present', async () => {
    const searchResult = { results: [{ content: 'Hello world', score: 0.95 }] };
    mockSearchMemories.mockResolvedValue(searchResult);
    const req = makeRequest('query=hello');
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockSearchMemories).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      'store-abc',
      expect.objectContaining({ query: 'hello' }),
    );
    expect(mockListMemoryItems).not.toHaveBeenCalled();
    expect(body.results).toBeDefined();
  });

  it('passes scope and scopeId filters', async () => {
    mockListMemoryItems.mockResolvedValue(mockMemoryItems);
    const req = makeRequest('scope=session&scopeId=sess-1');
    await GET(req, mockParams);
    expect(mockListMemoryItems).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'project-1',
      'store-abc',
      expect.objectContaining({ scope: 'session', scopeId: 'sess-1' }),
    );
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/memory/stores/store-abc/memories');
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
    mockListMemoryItems.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });
});
