import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/rag/ragService', () => ({
  listRagQueryLogs: vi.fn(),
}));

import { GET } from '@/server/api/routes/rag/modules/[key]/usage/route';
import { listRagQueryLogs } from '@/lib/services/rag/ragService';

const mockListRagQueryLogs = vi.mocked(listRagQueryLogs);

const mockParams = { params: Promise.resolve({ key: 'module-abc' }) };

function makeRequest(search = '', tenantDbName = 'tenant_test') {
  return new NextRequest(`http://localhost/api/rag/modules/module-abc/usage${search}`, {
    method: 'GET',
    headers: {
      'x-tenant-db-name': tenantDbName,
    },
  });
}

const sampleLogs = [
  { id: 'log-1', moduleKey: 'module-abc', timestamp: new Date('2024-01-01') },
  { id: 'log-2', moduleKey: 'module-abc', timestamp: new Date('2024-01-02') },
];

describe('GET /api/rag/modules/[key]/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListRagQueryLogs.mockResolvedValue(sampleLogs as any);
  });

  it('returns query logs for a module', async () => {
    const res = await GET(makeRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(2);
  });

  it('calls listRagQueryLogs with correct args', async () => {
    await GET(makeRequest(), mockParams);
    expect(mockListRagQueryLogs).toHaveBeenCalledWith('tenant_test', 'module-abc', {
      limit: 50,
      from: undefined,
      to: undefined,
    });
  });

  it('passes custom limit from query param', async () => {
    await GET(makeRequest('?limit=10'), mockParams);
    expect(mockListRagQueryLogs).toHaveBeenCalledWith('tenant_test', 'module-abc', expect.objectContaining({ limit: 10 }));
  });

  it('passes from and to date params', async () => {
    await GET(makeRequest('?from=2024-01-01&to=2024-12-31'), mockParams);
    expect(mockListRagQueryLogs).toHaveBeenCalledWith('tenant_test', 'module-abc', expect.objectContaining({
      from: expect.any(Date),
      to: expect.any(Date),
    }));
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await GET(makeRequest('', ''), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockListRagQueryLogs.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeRequest(), mockParams);
    expect(res.status).toBe(500);
  });

  it('returns empty logs array on empty response', async () => {
    mockListRagQueryLogs.mockResolvedValueOnce([]);
    const res = await GET(makeRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toEqual([]);
  });
});
