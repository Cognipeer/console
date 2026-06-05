import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/agentTracing', () => ({
  AgentTracingService: {
    getAgentOverview: vi.fn(),
  },
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

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
}));

import { GET } from '@/server/api/routes/tracing/agents/[agentName]/overview/route';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockGetAgentOverview = vi.mocked(AgentTracingService.getAgentOverview);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockOverview = {
  agentName: 'my-agent',
  totalSessions: 42,
  successRate: 0.95,
  averageLatencyMs: 1200,
  errorCount: 2,
};

const mockParams = { params: Promise.resolve({ agentName: 'my-agent' }) };

function makeRequest(headers: Record<string, string> = {}, search = '') {
  return new NextRequest(`http://localhost/api/tracing/agents/my-agent/overview${search}`, {
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
  });
}

describe('GET /api/tracing/agents/[agentName]/overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAgentOverview.mockResolvedValue(mockOverview as any);
  });

  it('returns agent overview on success', async () => {
    const res = await GET(makeRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totalSessions');
  });

  it('calls getAgentOverview with decoded agentName', async () => {
    const encodedParams = { params: Promise.resolve({ agentName: 'my%20agent' }) };
    await GET(makeRequest(), encodedParams);
    expect(mockGetAgentOverview).toHaveBeenCalledWith(
      'tenant_test',
      'proj-1',
      'my agent',
      expect.any(Object),
    );
  });

  it('passes regular agentName correctly', async () => {
    await GET(makeRequest(), mockParams);
    expect(mockGetAgentOverview).toHaveBeenCalledWith(
      'tenant_test',
      'proj-1',
      'my-agent',
      expect.any(Object),
    );
  });

  it('returns 401 when x-tenant-db-name missing', async () => {
    const res = await GET(makeRequest({ 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id missing', async () => {
    const req = new NextRequest('http://localhost/api/tracing/agents/my-agent/overview', {
      headers: { 'x-tenant-db-name': 'tenant_test', 'x-tenant-id': 'tenant-id-1' },
    });
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status when context fails', async () => {
    const { ProjectContextError } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new ProjectContextError('No project', 400));
    const res = await GET(makeRequest(), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 500 on service error', async () => {
    mockGetAgentOverview.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeRequest(), mockParams);
    expect(res.status).toBe(500);
  });

  it('passes from/to filters from query params', async () => {
    await GET(makeRequest({}, '?from=2024-01-01&to=2024-01-31'), mockParams);
    expect(mockGetAgentOverview).toHaveBeenCalledWith(
      'tenant_test',
      'proj-1',
      'my-agent',
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    );
  });
});
