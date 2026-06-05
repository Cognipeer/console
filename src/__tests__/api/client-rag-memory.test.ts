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
  return { requireApiToken: vi.fn(), ApiTokenAuthError };
});

vi.mock('@/lib/services/rag/ragService', () => ({
  queryRag: vi.fn(),
  listRagModules: vi.fn(),
}));

vi.mock('@/lib/services/memory/memoryService', () => ({
  recallForChat: vi.fn(),
}));

import { POST as ragQueryPOST } from '@/server/api/routes/client/v1/rag/modules/[key]/query/route';
import { GET as ragModulesGET } from '@/server/api/routes/client/v1/rag/modules/route';
import { POST as memoryRecallPOST } from '@/server/api/routes/client/v1/memory/stores/[storeKey]/recall/route';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { queryRag, listRagModules } from '@/lib/services/rag/ragService';
import { recallForChat } from '@/lib/services/memory/memoryService';

const DEFAULT_CTX = {
  tenantId: 'tenant-1',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  tokenRecord: { userId: 'user-1' },
};

// ---- RAG Query Tests ----
describe('POST /api/client/v1/rag/modules/:key/query', () => {
  const ROUTE_CTX = { params: Promise.resolve({ key: 'product-docs' }) };

  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  function makeReq(body: object): NextRequest {
    return new NextRequest('http://localhost/api/client/v1/rag/modules/product-docs/query', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns results on successful query', async () => {
    const result = {
      hits: [{ score: 0.9, content: 'Product info...' }],
      took: 12,
    };
    (queryRag as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    const res = await ragQueryPOST(makeReq({ query: 'How does it work?' }), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.result).toMatchObject({ hits: expect.any(Array) });
  });

  it('returns 400 when query is missing', async () => {
    const res = await ragQueryPOST(makeReq({}), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('query');
  });

  it('passes topK and filter to queryRag', async () => {
    (queryRag as ReturnType<typeof vi.fn>).mockResolvedValue({ hits: [] });

    await ragQueryPOST(
      makeReq({ query: 'test', topK: 10, filter: { category: 'docs' } }),
      ROUTE_CTX,
    );

    expect(queryRag).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      undefined,
      expect.objectContaining({
        ragModuleKey: 'product-docs',
        query: 'test',
        topK: 10,
        filter: { category: 'docs' },
      }),
    );
  });

  it('returns 401 on auth error', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Unauthorized', 401),
    );

    const res = await ragQueryPOST(makeReq({ query: 'test' }), ROUTE_CTX);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    (queryRag as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Index error'));

    const res = await ragQueryPOST(makeReq({ query: 'test' }), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Index error');
  });
});

// ---- RAG Modules List Tests ----
describe('GET /api/client/v1/rag/modules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  function makeReq(): NextRequest {
    return new NextRequest('http://localhost/api/client/v1/rag/modules', { method: 'GET' });
  }

  it('returns 200 with modules list', async () => {
    const modules = [{ _id: 'm1', key: 'product-docs', name: 'Product Docs' }];
    (listRagModules as ReturnType<typeof vi.fn>).mockResolvedValue(modules);

    const res = await ragModulesGET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.modules).toEqual(modules);
  });

  it('returns empty list when no modules exist', async () => {
    (listRagModules as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const res = await ragModulesGET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.modules).toEqual([]);
  });

  it('returns 403 on ApiTokenAuthError', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Forbidden', 403),
    );

    const res = await ragModulesGET(makeReq());
    expect(res.status).toBe(403);
  });

  it('returns 500 on service error', async () => {
    (listRagModules as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

    const res = await ragModulesGET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(500);
  });
});

// ---- Memory Recall Tests ----
describe('POST /api/client/v1/memory/stores/:storeKey/recall', () => {
  const ROUTE_CTX = { params: Promise.resolve({ storeKey: 'customer-mem' }) };

  beforeEach(() => {
    vi.clearAllMocks();
    (requireApiToken as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_CTX);
  });

  function makeReq(body: object): NextRequest {
    return new NextRequest('http://localhost/api/client/v1/memory/stores/customer-mem/recall', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns recall result on success', async () => {
    const result = { memories: [{ content: 'User prefers dark mode' }], context: '...' };
    (recallForChat as ReturnType<typeof vi.fn>).mockResolvedValue(result);

    const res = await memoryRecallPOST(makeReq({ query: 'user preferences' }), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.memories).toHaveLength(1);
  });

  it('returns 400 when query is missing', async () => {
    const res = await memoryRecallPOST(makeReq({}), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('query');
  });

  it('passes topK and scope to recallForChat', async () => {
    (recallForChat as ReturnType<typeof vi.fn>).mockResolvedValue({ memories: [] });

    await memoryRecallPOST(
      makeReq({ query: 'user prefs', topK: 3, scope: 'session', scopeId: 'sess-1' }),
      ROUTE_CTX,
    );

    expect(recallForChat).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      'customer-mem',
      expect.objectContaining({
        query: 'user prefs',
        topK: 3,
        scope: 'session',
        scopeId: 'sess-1',
      }),
    );
  });

  it('uses top_k alias when topK is not provided', async () => {
    (recallForChat as ReturnType<typeof vi.fn>).mockResolvedValue({ memories: [] });

    await memoryRecallPOST(
      makeReq({ query: 'test', top_k: 7 }),
      ROUTE_CTX,
    );

    expect(recallForChat).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      'customer-mem',
      expect.objectContaining({ topK: 7 }),
    );
  });

  it('defaults topK=5 and maxTokens=2000 when not provided', async () => {
    (recallForChat as ReturnType<typeof vi.fn>).mockResolvedValue({ memories: [] });

    await memoryRecallPOST(makeReq({ query: 'test' }), ROUTE_CTX);

    expect(recallForChat).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      'customer-mem',
      expect.objectContaining({ topK: 5, maxTokens: 2000 }),
    );
  });

  it('returns 401 on auth error', async () => {
    (requireApiToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiTokenAuthError('Unauthorized', 401),
    );

    const res = await memoryRecallPOST(makeReq({ query: 'test' }), ROUTE_CTX);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    (recallForChat as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Vector store unavailable'),
    );

    const res = await memoryRecallPOST(makeReq({ query: 'test' }), ROUTE_CTX);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Vector store unavailable');
  });
});
