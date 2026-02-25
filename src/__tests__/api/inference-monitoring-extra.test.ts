import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/inferenceMonitoring', () => ({
  InferenceMonitoringService: {
    listServers: vi.fn(),
    getMetrics: vi.fn(),
    getServerByKey: vi.fn(),
    pollServer: vi.fn(),
  },
}));

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
}));

import { GET as getDashboard } from '@/app/api/inference-monitoring/dashboard/route';
import { GET as getMetrics } from '@/app/api/inference-monitoring/servers/[serverKey]/metrics/route';
import { POST as pollServer } from '@/app/api/inference-monitoring/servers/[serverKey]/poll/route';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';

const mockListServers = InferenceMonitoringService.listServers as ReturnType<typeof vi.fn>;
const mockGetMetrics = InferenceMonitoringService.getMetrics as ReturnType<typeof vi.fn>;
const mockGetServerByKey = InferenceMonitoringService.getServerByKey as ReturnType<typeof vi.fn>;
const mockPollServer = InferenceMonitoringService.pollServer as ReturnType<typeof vi.fn>;

const mockServerKey = { params: Promise.resolve({ serverKey: 'server-1' }) };

const mockServer = {
  _id: 'srv-1',
  serverKey: 'server-1',
  name: 'vLLM Server',
  type: 'vllm',
  status: 'active',
  lastPolledAt: null,
  lastError: null,
};

const mockMetricPoint = {
  timestamp: new Date().toISOString(),
  gpuCacheUsagePercent: 0.5,
  numRequestsRunning: 3,
  numRequestsWaiting: 0,
};

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': 'tenant-1',
      ...headers,
    },
  });
}

describe('GET /api/inference-monitoring/dashboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server metrics overview', async () => {
    mockListServers.mockResolvedValue([mockServer]);
    mockGetMetrics.mockResolvedValue([mockMetricPoint]);
    const req = makeRequest('http://localhost/api/inference-monitoring/dashboard');
    const res = await getDashboard(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.servers).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/inference-monitoring/dashboard');
    const res = await getDashboard(req);
    expect(res.status).toBe(401);
  });

  it('handles empty server list', async () => {
    mockListServers.mockResolvedValue([]);
    const req = makeRequest('http://localhost/api/inference-monitoring/dashboard');
    const res = await getDashboard(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.servers).toHaveLength(0);
  });

  it('returns 500 on unexpected error', async () => {
    mockListServers.mockRejectedValue(new Error('DB error'));
    const req = makeRequest('http://localhost/api/inference-monitoring/dashboard');
    const res = await getDashboard(req);
    expect(res.status).toBe(500);
  });
});

describe('GET /api/inference-monitoring/servers/[serverKey]/metrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns metrics history on success', async () => {
    mockGetServerByKey.mockResolvedValue(mockServer);
    mockGetMetrics.mockResolvedValue([mockMetricPoint]);
    const req = makeRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/metrics',
    );
    const res = await getMetrics(req, mockServerKey);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metrics).toHaveLength(1);
  });

  it('returns 404 when server not found', async () => {
    mockGetServerByKey.mockResolvedValue(null);
    const req = makeRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/metrics',
    );
    const res = await getMetrics(req, mockServerKey);
    expect(res.status).toBe(404);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/metrics',
    );
    const res = await getMetrics(req, mockServerKey);
    expect(res.status).toBe(401);
  });

  it('passes limit param to getMetrics', async () => {
    mockGetServerByKey.mockResolvedValue(mockServer);
    mockGetMetrics.mockResolvedValue([]);
    const req = makeRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/metrics?limit=100',
    );
    await getMetrics(req, mockServerKey);
    expect(mockGetMetrics).toHaveBeenCalledWith(
      'tenant_acme',
      'server-1',
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockGetServerByKey.mockRejectedValue(new Error('DB error'));
    const req = makeRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/metrics',
    );
    const res = await getMetrics(req, mockServerKey);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/inference-monitoring/servers/[serverKey]/poll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('polls server and returns metrics', async () => {
    mockPollServer.mockResolvedValue({ gpuCacheUsagePercent: 0.3 });
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/poll',
      {
        method: 'POST',
        headers: { 'x-tenant-db-name': 'tenant_acme', 'x-tenant-id': 'tenant-1' },
      },
    );
    const res = await pollServer(req, mockServerKey);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.metrics.gpuCacheUsagePercent).toBe(0.3);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/poll',
      { method: 'POST' },
    );
    const res = await pollServer(req, mockServerKey);
    expect(res.status).toBe(401);
  });

  it('calls pollServer with correct args', async () => {
    mockPollServer.mockResolvedValue(null);
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/poll',
      {
        method: 'POST',
        headers: { 'x-tenant-db-name': 'tenant_acme', 'x-tenant-id': 'tenant-1' },
      },
    );
    await pollServer(req, mockServerKey);
    expect(mockPollServer).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'server-1');
  });

  it('returns 500 on unexpected error', async () => {
    mockPollServer.mockRejectedValue(new Error('Connection refused'));
    const req = new NextRequest(
      'http://localhost/api/inference-monitoring/servers/server-1/poll',
      {
        method: 'POST',
        headers: { 'x-tenant-db-name': 'tenant_acme', 'x-tenant-id': 'tenant-1' },
      },
    );
    const res = await pollServer(req, mockServerKey);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error).toBe('Connection refused');
  });
});
