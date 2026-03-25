import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/inferenceMonitoring', () => ({
  InferenceMonitoringService: {
    getServerByKey: vi.fn(),
    updateServer: vi.fn(),
    deleteServer: vi.fn(),
  },
}));

vi.mock('@/lib/services/inferenceMonitoring/utils', () => ({
  sanitizeServer: vi.fn((s) => s),
  normalizeBaseUrl: vi.fn((url: string) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      return null;
    }
  }),
}));

import { GET, PUT, DELETE } from '@/server/api/routes/inference-monitoring/servers/[serverKey]/route';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';

const mockGetServerByKey = InferenceMonitoringService.getServerByKey as ReturnType<typeof vi.fn>;
const mockUpdateServer = InferenceMonitoringService.updateServer as ReturnType<typeof vi.fn>;
const mockDeleteServer = InferenceMonitoringService.deleteServer as ReturnType<typeof vi.fn>;

const mockParams = { params: Promise.resolve({ serverKey: 'server-abc' }) };

const mockServer = {
  _id: 'srv-1',
  serverKey: 'server-abc',
  name: 'Local vLLM',
  baseUrl: 'http://localhost:8000',
  type: 'vllm',
  status: 'active',
};

function makeRequest(
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const method = opts.method ?? 'GET';
  return new NextRequest('http://localhost/api/inference-monitoring/servers/server-abc', {
    method,
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      'x-user-id': 'user-1',
      'content-type': 'application/json',
      ...opts.headers,
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe('GET /api/inference-monitoring/servers/[serverKey]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server on success', async () => {
    mockGetServerByKey.mockResolvedValue(mockServer);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.server.serverKey).toBe('server-abc');
  });

  it('returns 404 when server not found', async () => {
    mockGetServerByKey.mockResolvedValue(null);
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when tenant headers missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-abc',
    );
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetServerByKey.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/inference-monitoring/servers/[serverKey]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates and returns server on success', async () => {
    const updated = { ...mockServer, name: 'Updated vLLM' };
    mockUpdateServer.mockResolvedValue(updated);
    const req = makeRequest({
      method: 'PUT',
      body: { name: 'Updated vLLM', baseUrl: 'http://localhost:8000' },
    });
    const res = await PUT(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.server.name).toBe('Updated vLLM');
  });

  it('returns 404 when server not found after update', async () => {
    mockUpdateServer.mockResolvedValue(null);
    const req = makeRequest({ method: 'PUT', body: { name: 'x' } });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when userId missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-abc',
      {
        method: 'PUT',
        headers: { 'x-tenant-db-name': 'tenant_acme', 'x-tenant-id': 'tenant-1' },
        body: JSON.stringify({}),
      },
    );
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid baseUrl', async () => {
    const req = makeRequest({
      method: 'PUT',
      body: { baseUrl: 'not-a-valid-url' },
    });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid status value', async () => {
    const req = makeRequest({
      method: 'PUT',
      body: { status: 'unknown-state' },
    });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('accepts valid status "disabled"', async () => {
    mockUpdateServer.mockResolvedValue({ ...mockServer, status: 'disabled' });
    const req = makeRequest({
      method: 'PUT',
      body: { status: 'disabled' },
    });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(200);
  });

  it('clamps pollIntervalSeconds between 10 and 3600', async () => {
    mockUpdateServer.mockResolvedValue(mockServer);
    const req = makeRequest({
      method: 'PUT',
      body: { pollIntervalSeconds: 5 },
    });
    await PUT(req, mockParams);
    expect(mockUpdateServer).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'server-abc',
      expect.objectContaining({ pollIntervalSeconds: 10 }),
      'user-1',
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockUpdateServer.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'PUT', body: {} });
    const res = await PUT(req, mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/inference-monitoring/servers/[serverKey]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes server and returns success', async () => {
    mockDeleteServer.mockResolvedValue(true);
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when server not found', async () => {
    mockDeleteServer.mockResolvedValue(false);
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when tenant headers missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-abc',
      { method: 'DELETE' },
    );
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on unexpected error', async () => {
    mockDeleteServer.mockRejectedValue(new Error('DB error'));
    const req = makeRequest({ method: 'DELETE' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(500);
  });
});
