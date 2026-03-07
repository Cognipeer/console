import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/rag/ragService', () => ({
  listRagModules: vi.fn(),
  createRagModule: vi.fn(),
}));

vi.mock('@/lib/services/memory/memoryService', () => ({
  listMemoryStores: vi.fn(),
  createMemoryStore: vi.fn(),
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

import { GET as getRagModules, POST as postRagModule } from '@/server/api/routes/rag/modules/route';
import { GET as getMemoryStores, POST as postMemoryStore } from '@/server/api/routes/memory/stores/route';
import { listRagModules, createRagModule } from '@/lib/services/rag/ragService';
import { listMemoryStores, createMemoryStore } from '@/lib/services/memory/memoryService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const BASE_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
  'x-project-id': 'proj-1',
};

const DASHBOARD_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = BASE_HEADERS) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MOCK_PROJECT = { projectId: 'proj-1' };
const MOCK_MODULE = {
  _id: 'mod-1', name: 'KB Module', key: 'kb-module',
  embeddingModelKey: 'emb-1', vectorProviderKey: 'vprov-1',
  vectorIndexKey: 'idx-1', chunkConfig: {},
};
const MOCK_STORE = {
  _id: 'store-1', name: 'Main Store', key: 'main-store',
  vectorProviderKey: 'vprov-1', embeddingModelKey: 'emb-1', projectId: 'proj-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireProjectContext as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PROJECT);
  (listRagModules as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_MODULE]);
  (createRagModule as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MODULE);
  (listMemoryStores as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_STORE]);
  (createMemoryStore as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STORE);
});

// --- RAG MODULES ---

describe('GET /api/rag/modules', () => {
  it('returns modules list 200', async () => {
    const res = await getRagModules(makeReq('/api/rag/modules'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.modules).toHaveLength(1);
  });

  it('returns 401 when tenantDbName missing', async () => {
    const res = await getRagModules(makeReq('/api/rag/modules', 'GET', undefined, {}));
    expect(res.status).toBe(401);
  });

  it('passes search and status filters', async () => {
    const res = await getRagModules(makeReq('/api/rag/modules?search=KB&status=active'));
    expect(res.status).toBe(200);
    expect(listRagModules).toHaveBeenCalledWith('tenant_acme', expect.objectContaining({ search: 'KB', status: 'active' }));
  });

  it('passes projectId from header', async () => {
    const res = await getRagModules(makeReq('/api/rag/modules'));
    expect(listRagModules).toHaveBeenCalledWith('tenant_acme', expect.objectContaining({ projectId: 'proj-1' }));
  });

  it('returns 500 on unexpected error', async () => {
    (listRagModules as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await getRagModules(makeReq('/api/rag/modules'));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/rag/modules', () => {
  const VALID_BODY = {
    name: 'KB Module',
    embeddingModelKey: 'emb-1',
    vectorProviderKey: 'vprov-1',
    vectorIndexKey: 'idx-1',
    chunkConfig: { size: 512, overlap: 64 },
  };

  it('creates module and returns 201', async () => {
    const res = await postRagModule(makeReq('/api/rag/modules', 'POST', VALID_BODY));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.module).toBeDefined();
  });

  it('returns 401 when tenantDbName missing', async () => {
    const res = await postRagModule(makeReq('/api/rag/modules', 'POST', VALID_BODY, {}));
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { name: _omit, ...rest } = VALID_BODY;
    const res = await postRagModule(makeReq('/api/rag/modules', 'POST', rest));
    expect(res.status).toBe(400);
  });

  it('returns 400 when embeddingModelKey is missing', async () => {
    const { embeddingModelKey: _omit, ...rest } = VALID_BODY;
    const res = await postRagModule(makeReq('/api/rag/modules', 'POST', rest));
    expect(res.status).toBe(400);
  });

  it('returns 400 when chunkConfig is missing', async () => {
    const { chunkConfig: _omit, ...rest } = VALID_BODY;
    const res = await postRagModule(makeReq('/api/rag/modules', 'POST', rest));
    expect(res.status).toBe(400);
  });

  it('returns 500 on unexpected error', async () => {
    (createRagModule as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await postRagModule(makeReq('/api/rag/modules', 'POST', VALID_BODY));
    expect(res.status).toBe(500);
  });
});

// --- MEMORY STORES ---

describe('GET /api/memory/stores', () => {
  it('returns stores list 200', async () => {
    const res = await getMemoryStores(makeReq('/api/memory/stores', 'GET', undefined, DASHBOARD_HEADERS));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.stores).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const res = await getMemoryStores(makeReq('/api/memory/stores', 'GET', undefined, {}));
    expect(res.status).toBe(401);
  });

  it('passes status and search filters', async () => {
    const res = await getMemoryStores(makeReq('/api/memory/stores?status=active&search=main', 'GET', undefined, DASHBOARD_HEADERS));
    expect(listMemoryStores).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({ status: 'active', search: 'main' }));
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('No project', 404);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await getMemoryStores(makeReq('/api/memory/stores', 'GET', undefined, DASHBOARD_HEADERS));
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    (listMemoryStores as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await getMemoryStores(makeReq('/api/memory/stores', 'GET', undefined, DASHBOARD_HEADERS));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/memory/stores', () => {
  const VALID_BODY = {
    name: 'Main Store',
    vectorProviderKey: 'vprov-1',
    embeddingModelKey: 'emb-1',
  };

  it('creates store and returns 201', async () => {
    const res = await postMemoryStore(makeReq('/api/memory/stores', 'POST', VALID_BODY, DASHBOARD_HEADERS));
    expect(res.status).toBe(201);
    const body = await res.json();
    // The route returns the store object directly
    expect(body).toBeDefined();
    expect(body._id).toBe('store-1');
  });

  it('returns 401 when headers missing', async () => {
    const res = await postMemoryStore(makeReq('/api/memory/stores', 'POST', VALID_BODY, {}));
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { name: _omit, ...rest } = VALID_BODY;
    const res = await postMemoryStore(makeReq('/api/memory/stores', 'POST', rest, DASHBOARD_HEADERS));
    expect(res.status).toBe(400);
  });

  it('returns 400 when vectorProviderKey is missing', async () => {
    const { vectorProviderKey: _omit, ...rest } = VALID_BODY;
    const res = await postMemoryStore(makeReq('/api/memory/stores', 'POST', rest, DASHBOARD_HEADERS));
    expect(res.status).toBe(400);
  });

  it('returns 400 when embeddingModelKey is missing', async () => {
    const { embeddingModelKey: _omit, ...rest } = VALID_BODY;
    const res = await postMemoryStore(makeReq('/api/memory/stores', 'POST', rest, DASHBOARD_HEADERS));
    expect(res.status).toBe(400);
  });

  it('returns ProjectContextError status', async () => {
    const e = new (ProjectContextError as any)('Forbidden', 403);
    (requireProjectContext as ReturnType<typeof vi.fn>).mockRejectedValue(e);
    const res = await postMemoryStore(makeReq('/api/memory/stores', 'POST', VALID_BODY, DASHBOARD_HEADERS));
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    (createMemoryStore as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const res = await postMemoryStore(makeReq('/api/memory/stores', 'POST', VALID_BODY, DASHBOARD_HEADERS));
    expect(res.status).toBe(500);
  });
});
