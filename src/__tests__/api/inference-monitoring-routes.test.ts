import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/inferenceMonitoring', () => ({
  InferenceMonitoringService: {
    listServers: vi.fn(),
    createServer: vi.fn(),
    getServer: vi.fn(),
    updateServer: vi.fn(),
    deleteServer: vi.fn(),
  },
}));

vi.mock('@/lib/services/inferenceMonitoring/utils', () => ({
  sanitizeServer: vi.fn((s) => s),
  normalizeBaseUrl: vi.fn((url: string) => url.startsWith('http') ? url : null),
}));

import { GET, POST } from '@/app/api/inference-monitoring/servers/route';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';
import { normalizeBaseUrl } from '@/lib/services/inferenceMonitoring/utils';

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

const MOCK_SERVER = {
  _id: 'srv-1',
  name: 'vLLM Server',
  type: 'vllm',
  baseUrl: 'http://localhost:8000',
  status: 'online',
};

beforeEach(() => {
  vi.clearAllMocks();
  (InferenceMonitoringService.listServers as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_SERVER]);
  (InferenceMonitoringService.createServer as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SERVER);
  (normalizeBaseUrl as ReturnType<typeof vi.fn>).mockImplementation((url: string) => url.startsWith('http') ? url : null);
});

describe('GET /api/inference-monitoring/servers', () => {
  it('returns servers list 200', async () => {
    const req = makeReq('/api/inference-monitoring/servers');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.servers).toHaveLength(1);
  });

  it('returns 401 when tenantDbName missing', async () => {
    const req = makeReq('/api/inference-monitoring/servers', 'GET', undefined, {
      'x-tenant-id': 'tenant-1',
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when tenantId missing', async () => {
    const req = makeReq('/api/inference-monitoring/servers', 'GET', undefined, {
      'x-tenant-db-name': 'tenant_acme',
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('calls listServers with correct params', async () => {
    const req = makeReq('/api/inference-monitoring/servers');
    await GET(req);
    expect(InferenceMonitoringService.listServers).toHaveBeenCalledWith('tenant_acme', 'tenant-1');
  });

  it('returns 500 on unexpected error', async () => {
    (InferenceMonitoringService.listServers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeReq('/api/inference-monitoring/servers');
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/inference-monitoring/servers', () => {
  const VALID_BODY = {
    name: 'vLLM Server',
    type: 'vllm',
    baseUrl: 'http://localhost:8000',
  };

  it('creates server and returns 201', async () => {
    const req = makeReq('/api/inference-monitoring/servers', 'POST', VALID_BODY);
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.server).toBeDefined();
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/inference-monitoring/servers', 'POST', VALID_BODY, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { name: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/inference-monitoring/servers', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is missing', async () => {
    const { type: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/inference-monitoring/servers', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when baseUrl is missing', async () => {
    const { baseUrl: _omit, ...rest } = VALID_BODY;
    const req = makeReq('/api/inference-monitoring/servers', 'POST', rest);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for unsupported server type', async () => {
    const req = makeReq('/api/inference-monitoring/servers', 'POST', { ...VALID_BODY, type: 'invalid-type' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Unsupported');
  });

  it('returns 400 for invalid baseUrl', async () => {
    (normalizeBaseUrl as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const req = makeReq('/api/inference-monitoring/servers', 'POST', { ...VALID_BODY, baseUrl: 'not-a-url' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid base URL');
  });

  it('supports llamacpp type', async () => {
    const req = makeReq('/api/inference-monitoring/servers', 'POST', { ...VALID_BODY, type: 'llamacpp' });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('passes correct args to createServer', async () => {
    const req = makeReq('/api/inference-monitoring/servers', 'POST', { ...VALID_BODY, apiKey: 'secret-key' });
    await POST(req);
    expect(InferenceMonitoringService.createServer).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      expect.objectContaining({
        name: 'vLLM Server',
        type: 'vllm',
        baseUrl: 'http://localhost:8000',
        apiKey: 'secret-key',
      }),
      'user-1',
    );
  });

  it('returns 500 on unexpected error', async () => {
    (InferenceMonitoringService.createServer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db error'));
    const req = makeReq('/api/inference-monitoring/servers', 'POST', VALID_BODY);
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
