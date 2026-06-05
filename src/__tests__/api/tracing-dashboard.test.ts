import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/agentTracing', () => ({
  AgentTracingService: {
    getDashboardOverview: vi.fn(),
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

import { GET } from '@/server/api/routes/tracing/dashboard/route';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockGetDashboardOverview = AgentTracingService.getDashboardOverview as ReturnType<typeof vi.fn>;
const mockRequireProjectContext = requireProjectContext as ReturnType<typeof vi.fn>;

const mockContext = { projectId: 'project-1' };

const mockOverview = {
  totalSessions: 100,
  activeSessions: 5,
  completedSessions: 90,
  errorSessions: 5,
  recentSessions: [],
  topAgents: [{ agentName: 'agent-x', sessionCount: 50 }],
};

function makeRequest(searchParams = '') {
  return new NextRequest(
    `http://localhost/api/tracing/dashboard${searchParams ? '?' + searchParams : ''}`,
    {
      headers: {
        'x-tenant-db-name': 'tenant_acme',
        'x-tenant-id': 'tenant-1',
        'x-user-id': 'user-1',
      },
    },
  );
}

describe('GET /api/tracing/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue(mockContext);
  });

  it('returns overview on success', async () => {
    mockGetDashboardOverview.mockResolvedValue(mockOverview);
    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalSessions).toBe(100);
    expect(body.topAgents).toHaveLength(1);
  });

  it('returns 401 when headers missing', async () => {
    const req = new NextRequest('http://localhost/api/tracing/dashboard');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns ProjectContextError status', async () => {
    mockRequireProjectContext.mockRejectedValue(
      new ProjectContextError('No active project', 400),
    );
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it('passes date range to service', async () => {
    mockGetDashboardOverview.mockResolvedValue(mockOverview);
    const req = makeRequest('from=2025-01-01&to=2025-01-31&timezone=UTC');
    await GET(req);
    expect(mockGetDashboardOverview).toHaveBeenCalledWith(
      'tenant_acme',
      'project-1',
      expect.objectContaining({ from: '2025-01-01', to: '2025-01-31', timezone: 'UTC' }),
    );
  });

  it('returns 500 on unexpected error', async () => {
    mockGetDashboardOverview.mockRejectedValue(new Error('DB error'));
    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(500);
  });
});
