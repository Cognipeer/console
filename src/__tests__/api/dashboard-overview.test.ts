import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/dashboard/dashboardService', () => ({
  getDashboardData: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectContext', () => ({
  requireProjectContext: vi.fn(),
  ProjectContextError: class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/utils/dashboardDateFilter', () => ({
  parseDashboardDateFilterFromSearchParams: vi.fn().mockReturnValue({ from: null, to: null }),
}));

import { GET } from '@/app/api/dashboard/route';
import { getDashboardData } from '@/lib/services/dashboard/dashboardService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

const mockGetDashboardData = vi.mocked(getDashboardData);
const mockRequireProjectContext = vi.mocked(requireProjectContext);

const BASE_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
  'x-user-email': 'user@example.com',
  'x-license-type': 'PRO',
};

const mockDashboardData = {
  totalSessions: 10,
  totalEvents: 50,
  models: [],
};

function makeReq(headers?: Record<string, string>, search = '') {
  return new NextRequest(`http://localhost/api/dashboard${search}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...(headers ?? BASE_HEADERS) },
  });
}

describe('GET /api/dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetDashboardData.mockResolvedValue(mockDashboardData as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue({ projectId: 'proj-1' } as any);
  });

  it('returns dashboard data with user info', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({ email: 'user@example.com', licenseType: 'PRO' });
    expect(body.totalSessions).toBe(10);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const { 'x-tenant-db-name': _, ...headersWithout } = BASE_HEADERS;
    const res = await GET(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const { 'x-tenant-id': _, ...headersWithout } = BASE_HEADERS;
    const res = await GET(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const { 'x-user-id': _, ...headersWithout } = BASE_HEADERS;
    const res = await GET(makeReq(headersWithout));
    expect(res.status).toBe(401);
  });

  it('calls getDashboardData with correct arguments', async () => {
    await GET(makeReq());
    expect(mockGetDashboardData).toHaveBeenCalledWith(
      'tenant_acme',
      'tenant-1',
      'proj-1',
      expect.objectContaining({ from: null, to: null }),
    );
  });

  it('defaults licenseType to FREE when header missing', async () => {
    const headersWithout = { ...BASE_HEADERS };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (headersWithout as any)['x-license-type'];
    const res = await GET(makeReq(headersWithout));
    const body = await res.json();
    expect(body.user.licenseType).toBe('FREE');
  });

  it('propagates ProjectContextError status', async () => {
    const { ProjectContextError: PCE } = await import('@/lib/services/projects/projectContext');
    mockRequireProjectContext.mockRejectedValueOnce(new PCE('No project', 403));
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetDashboardData.mockRejectedValueOnce(new Error('DB error'));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('DB error');
  });

  it('merges dashboard data keys into response', async () => {
    mockGetDashboardData.mockResolvedValueOnce({
      totalSessions: 42,
      activeAgents: 3,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.totalSessions).toBe(42);
    expect(body.activeAgents).toBe(3);
  });
});
