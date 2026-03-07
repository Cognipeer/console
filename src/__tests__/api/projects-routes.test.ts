import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findUserById: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn(),
  generateUniqueProjectKey: vi.fn(),
  listAccessibleProjects: vi.fn(),
  DEFAULT_PROJECT_KEY: 'default',
}));

import { GET, POST } from '@/server/api/routes/projects/route';
import { ensureDefaultProject, generateUniqueProjectKey, listAccessibleProjects } from '@/lib/services/projects/projectService';

const OWNER_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
  'x-tenant-slug': 'acme',
};

function makeReq(path: string, method = 'GET', body?: object, headers: Record<string, string> = OWNER_HEADERS) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MOCK_USER = { _id: 'user-1', email: 'user@acme.com', role: 'owner', projectIds: [] };
const MOCK_PROJECT = { _id: 'proj-1', key: 'default', name: 'Default', tenantId: 'tenant-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.switchToTenant.mockResolvedValue(undefined);
  mockDb.findUserById.mockResolvedValue(MOCK_USER);
  mockDb.createProject.mockResolvedValue(MOCK_PROJECT);
  (ensureDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (generateUniqueProjectKey as ReturnType<typeof vi.fn>).mockResolvedValue('my-project');
  (listAccessibleProjects as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PROJECT]);
});

describe('GET /api/projects', () => {
  it('returns projects and activeProjectId 200', async () => {
    const req = makeReq('/api/projects');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(body.activeProjectId).toBe('proj-1');
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/projects', 'GET', undefined, {});
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 401 when user not found', async () => {
    mockDb.findUserById.mockResolvedValue(null);
    const req = makeReq('/api/projects');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('calls ensureDefaultProject', async () => {
    const req = makeReq('/api/projects');
    await GET(req);
    expect(ensureDefaultProject).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'user-1');
  });

  it('returns empty array when no projects', async () => {
    (listAccessibleProjects as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const req = makeReq('/api/projects');
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.projects).toHaveLength(0);
    expect(body.activeProjectId).toBeUndefined();
  });

  it('returns 500 on unexpected error', async () => {
    (listAccessibleProjects as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db failure'));
    const req = makeReq('/api/projects');
    const res = await GET(req);
    expect(res.status).toBe(500);
  });

  it('switches to tenant database', async () => {
    const req = makeReq('/api/projects');
    await GET(req);
    expect(mockDb.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });
});

describe('POST /api/projects', () => {
  it('creates project and returns 201', async () => {
    const req = makeReq('/api/projects', 'POST', { name: 'My Project', description: 'Test' });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.project).toBeDefined();
  });

  it('returns 401 when headers missing', async () => {
    const req = makeReq('/api/projects', 'POST', { name: 'Test' }, {});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when role is not owner or admin', async () => {
    const req = makeReq('/api/projects', 'POST', { name: 'Test' }, {
      ...OWNER_HEADERS,
      'x-user-role': 'user',
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 for member role', async () => {
    const req = makeReq('/api/projects', 'POST', { name: 'Test' }, {
      ...OWNER_HEADERS,
      'x-user-role': 'member',
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is too short', async () => {
    const req = makeReq('/api/projects', 'POST', { name: 'A' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is missing', async () => {
    const req = makeReq('/api/projects', 'POST', {});
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('allows admin role to create project', async () => {
    const req = makeReq('/api/projects', 'POST', { name: 'My Project' }, {
      ...OWNER_HEADERS,
      'x-user-role': 'admin',
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
  });

  it('passes correct args to createProject', async () => {
    const req = makeReq('/api/projects', 'POST', { name: 'My Project', description: 'A desc' });
    await POST(req);
    expect(mockDb.createProject).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      name: 'My Project',
      description: 'A desc',
      createdBy: 'user-1',
    }));
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.createProject.mockRejectedValue(new Error('db failure'));
    const req = makeReq('/api/projects', 'POST', { name: 'My Project' });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
