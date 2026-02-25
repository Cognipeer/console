import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/rag/ragService', () => ({
  getRagModule: vi.fn(),
  updateRagModule: vi.fn(),
  deleteRagModule: vi.fn(),
}));

import { GET, PATCH, DELETE } from '@/app/api/rag/modules/[key]/route';
import {
  getRagModule,
  updateRagModule,
  deleteRagModule,
} from '@/lib/services/rag/ragService';

const mockGetRagModule = getRagModule as ReturnType<typeof vi.fn>;
const mockUpdateRagModule = updateRagModule as ReturnType<typeof vi.fn>;
const mockDeleteRagModule = deleteRagModule as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ key: 'rag-abc' }) };
const mockModule = {
  _id: 'mod-1',
  key: 'rag-abc',
  name: 'Test RAG',
  vectorProviderKey: 'pinecone-1',
  projectId: 'project-1',
};

function makeRequest(opts: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const method = opts.method ?? 'GET';
  return new NextRequest('http://localhost/api/rag/modules/rag-abc', {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-project-id': 'project-1',
      'x-user-id': 'user-1',
      'content-type': 'application/json',
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/rag/modules/[key]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns module on success', async () => {
    mockGetRagModule.mockResolvedValue(mockModule);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.module.key).toBe('rag-abc');
  });

  it('returns 404 when module not found', async () => {
    mockGetRagModule.mockResolvedValue(null);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when tenantDbName missing', async () => {
    const req = new NextRequest('http://localhost/api/rag/modules/rag-abc');
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('passes projectId from header to service', async () => {
    mockGetRagModule.mockResolvedValue(mockModule);
    const req = makeRequest();
    await GET(req, mockParams);
    expect(mockGetRagModule).toHaveBeenCalledWith(
      'tenant_acme',
      'rag-abc',
      'project-1',
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockGetRagModule.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/rag/modules/[key]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates module and returns it', async () => {
    const updated = { ...mockModule, name: 'Updated RAG' };
    mockGetRagModule.mockResolvedValue(mockModule);
    mockUpdateRagModule.mockResolvedValue(updated);
    const req = makeRequest({ method: 'PATCH', body: { name: 'Updated RAG' } });
    const res = await PATCH(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.module.name).toBe('Updated RAG');
  });

  it('returns 404 when module not found', async () => {
    mockGetRagModule.mockResolvedValue(null);
    const req = makeRequest({ method: 'PATCH', body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when tenantDbName missing', async () => {
    const req = new NextRequest('http://localhost/api/rag/modules/rag-abc', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('passes updatedBy to service', async () => {
    mockGetRagModule.mockResolvedValue(mockModule);
    mockUpdateRagModule.mockResolvedValue(mockModule);
    const req = makeRequest({ method: 'PATCH', body: { name: 'x' } });
    await PATCH(req, mockParams);
    expect(mockUpdateRagModule).toHaveBeenCalledWith(
      'tenant_acme',
      'mod-1',
      expect.objectContaining({ updatedBy: 'user-1' }),
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockGetRagModule.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'PATCH', body: {} });
    const res = await PATCH(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/rag/modules/[key]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes module and returns success', async () => {
    mockGetRagModule.mockResolvedValue(mockModule);
    mockDeleteRagModule.mockResolvedValue(undefined);
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when module not found', async () => {
    mockGetRagModule.mockResolvedValue(null);
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when tenantDbName missing', async () => {
    const req = new NextRequest('http://localhost/api/rag/modules/rag-abc', {
      method: 'DELETE',
    });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('calls delete service with module _id', async () => {
    mockGetRagModule.mockResolvedValue(mockModule);
    mockDeleteRagModule.mockResolvedValue(undefined);
    const req = makeRequest({ method: 'DELETE' });
    await DELETE(req, mockParams);
    expect(mockDeleteRagModule).toHaveBeenCalledWith('tenant_acme', 'mod-1');
  });

  it('returns 500 on unexpected error', async () => {
    mockGetRagModule.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(500);
  });
});
