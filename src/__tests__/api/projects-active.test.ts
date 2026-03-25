import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findUserById: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn(),
  listAccessibleProjects: vi.fn(),
}));

import { POST } from '@/server/api/routes/projects/active/route';
import { ensureDefaultProject, listAccessibleProjects } from '@/lib/services/projects/projectService';

const mockEnsureDefaultProject = vi.mocked(ensureDefaultProject);
const mockListAccessibleProjects = vi.mocked(listAccessibleProjects);

const mockUser = { _id: 'user-1', role: 'owner', tenantId: 'tenant-id-1', projectIds: ['proj-1', 'proj-2'] };
const mockProjects = [
  { _id: 'proj-1', name: 'Project 1', tenantId: 'tenant-id-1' },
  { _id: 'proj-2', name: 'Project 2', tenantId: 'tenant-id-1' },
];

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/projects/active', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValue(mockUser as any);
    mockDb.switchToTenant.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockEnsureDefaultProject.mockResolvedValue({} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListAccessibleProjects.mockResolvedValue(mockProjects as any);
  });

  it('sets active_project_id cookie and returns success', async () => {
    const res = await POST(makeRequest({ projectId: 'proj-1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Check cookie is set
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('active_project_id');
    expect(setCookie).toContain('proj-1');
  });

  it('returns 400 when projectId is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 when projectId is not a string', async () => {
    const res = await POST(makeRequest({ projectId: 123 }));
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await POST(makeRequest({ projectId: 'proj-1' }, { 'x-tenant-db-name': '' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const res = await POST(makeRequest({ projectId: 'proj-1' }, { 'x-user-id': '' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when user not found in DB', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValueOnce(null as any);
    const res = await POST(makeRequest({ projectId: 'proj-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 when projectId not in accessible projects', async () => {
    const res = await POST(makeRequest({ projectId: 'proj-999' }));
    expect(res.status).toBe(403);
  });

  it('switches to tenant before looking up user', async () => {
    await POST(makeRequest({ projectId: 'proj-1' }));
    expect(mockDb.switchToTenant).toHaveBeenCalledWith('tenant_test');
  });

  it('calls ensureDefaultProject to bootstrap if needed', async () => {
    await POST(makeRequest({ projectId: 'proj-1' }));
    expect(mockEnsureDefaultProject).toHaveBeenCalledWith('tenant_test', 'tenant-id-1', 'user-1');
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.findUserById.mockRejectedValueOnce(new Error('DB crash'));
    const res = await POST(makeRequest({ projectId: 'proj-1' }));
    expect(res.status).toBe(500);
  });
});
