import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/rag/ragService', () => ({
  queryRag: vi.fn(),
}));

import { POST } from '@/server/api/routes/rag/modules/[key]/query/route';
import { queryRag } from '@/lib/services/rag/ragService';

const mockQueryRag = vi.mocked(queryRag);

function makeRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new NextRequest('http://localhost/api/rag/modules/mod-1/query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const mockParams = { params: Promise.resolve({ key: 'mod-1' }) };

describe('POST /api/rag/modules/[key]/query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRag.mockResolvedValue({ query: 'q', ragModuleKey: 'mod-1', latencyMs: 10, matches: [{ id: 'doc-1', score: 0.9, content: 'hello' }] });
  });

  it('returns query result on success', async () => {
    const res = await POST(makeRequest({ query: 'What is the meaning of life?' }), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('result');
    expect(body.result).toHaveProperty('matches');
  });

  it('calls queryRag with correct arguments', async () => {
    await POST(makeRequest({ query: 'search this', topK: 5 }), mockParams);
    expect(mockQueryRag).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      undefined,
      expect.objectContaining({
        ragModuleKey: 'mod-1',
        query: 'search this',
        topK: 5,
      }),
    );
  });

  it('passes filter to queryRag if provided', async () => {
    const filter = { category: 'tech' };
    await POST(makeRequest({ query: 'test', filter }), mockParams);
    expect(mockQueryRag).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      undefined,
      expect.objectContaining({ filter }),
    );
  });

  it('passes x-project-id header as projectId if present', async () => {
    await POST(
      makeRequest({ query: 'hello' }, { 'x-project-id': 'proj-xyz' }),
      mockParams,
    );
    expect(mockQueryRag).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'proj-xyz',
      expect.any(Object),
    );
  });

  it('returns 400 when query field is missing', async () => {
    const res = await POST(makeRequest({ topK: 3 }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 400 when query is an empty string', async () => {
    const res = await POST(makeRequest({ query: '' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const req = makeRequest({ query: 'test' }, { 'x-tenant-db-name': '' });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const req = new NextRequest('http://localhost/api/rag/modules/mod-1/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-db-name': 'tenant_test' },
      body: JSON.stringify({ query: 'hello' }),
    });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 when queryRag throws', async () => {
    mockQueryRag.mockRejectedValueOnce(new Error('service failure'));
    const res = await POST(makeRequest({ query: 'failing query' }), mockParams);
    expect(res.status).toBe(500);
  });

  it('returns correct result shape', async () => {
    const expected = { query: 'shape test', ragModuleKey: 'mod-1', latencyMs: 5, matches: [{ id: 'doc-2', score: 0.85 }] };
    mockQueryRag.mockResolvedValueOnce(expected);
    const res = await POST(makeRequest({ query: 'shape test' }), mockParams);
    const body = await res.json();
    expect(body.result).toEqual(expected);
  });

  it('uses undefined projectId when x-project-id header is absent', async () => {
    await POST(makeRequest({ query: 'no project' }), mockParams);
    expect(mockQueryRag).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      undefined,
      expect.any(Object),
    );
  });
});
