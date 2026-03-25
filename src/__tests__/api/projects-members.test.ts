import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findProjectById: vi.fn(),
  findUserById: vi.fn(),
  findUserByEmail: vi.fn(),
  listUsers: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

import { GET, POST, DELETE, PATCH } from '@/server/api/routes/projects/[projectId]/members/route';

const mockProject = { _id: 'proj-1', tenantId: 'tenant-id-1', name: 'Test Project' };
const mockOwner = { _id: 'user-1', role: 'owner', tenantId: 'tenant-id-1', projectIds: ['proj-1'] };
const mockMember = { _id: 'user-2', role: 'user', tenantId: 'tenant-id-1', projectIds: ['proj-1'] };
const mockAdmin = { _id: 'user-3', role: 'admin', tenantId: 'tenant-id-1', projectIds: [] };

const mockParams = { params: Promise.resolve({ projectId: 'proj-1' }) };

function makeRequest(
  method: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const hasBody = method !== 'GET';
  return new NextRequest('http://localhost/api/projects/proj-1/members', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
      ...headers,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/projects/[projectId]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.listUsers.mockResolvedValue([mockOwner, mockMember, mockAdmin] as any);
  });

  it('returns members list on success', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('users');
    expect(Array.isArray(body.users)).toBe(true);
  });

  it('includes owner and admin in members regardless of projectIds', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    const body = await res.json();
    const roles = body.users.map((u: { role: string }) => u.role);
    expect(roles).toContain('owner');
    expect(roles).toContain('admin');
  });

  it('returns 401 when x-user-role is missing', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-1/members', {
      headers: {
        'x-tenant-db-name': 'tenant_test',
        'x-tenant-id': 'tenant-id-1',
        'x-user-id': 'user-1',
      },
    });
    const res = await GET(req, mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when project not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValueOnce(null as any);
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/[projectId]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValue(mockMember as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.updateUser.mockResolvedValue({ ...mockMember, projectIds: ['proj-1'] } as any);
  });

  it('adds a member by userId and returns updated user', async () => {
    const res = await POST(makeRequest('POST', { userId: 'user-2' }), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
  });

  it('adds a member by email using findUserByEmail', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserByEmail.mockResolvedValueOnce(mockMember as any);
    const res = await POST(makeRequest('POST', { email: 'member@test.com' }), mockParams);
    expect(res.status).toBe(200);
    expect(mockDb.findUserByEmail).toHaveBeenCalledWith('member@test.com');
  });

  it('returns 400 when neither userId nor email is provided', async () => {
    const res = await POST(makeRequest('POST', {}), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 403 when role is user', async () => {
    const res = await POST(makeRequest('POST', { userId: 'user-2' }, { 'x-user-role': 'user' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 404 when target user not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValueOnce(null as any);
    const res = await POST(makeRequest('POST', { userId: 'nonexistent' }), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 400 when trying to add owner or admin (implicit members)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValueOnce(mockOwner as any);
    const res = await POST(makeRequest('POST', { userId: 'user-1' }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('implicitly');
  });

  it('returns 401 when context headers missing', async () => {
    const req = new NextRequest('http://localhost/api/projects/proj-1/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-2' }),
    });
    const res = await POST(req, mockParams);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/projects/[projectId]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValue(mockMember as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.updateUser.mockResolvedValue({ ...mockMember, projectIds: [] } as any);
  });

  it('removes member from project and returns updated user', async () => {
    const res = await DELETE(makeRequest('DELETE', { userId: 'user-2' }), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
  });

  it('returns 400 when trying to remove owner or admin', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValueOnce(mockOwner as any);
    const res = await DELETE(makeRequest('DELETE', { userId: 'user-1' }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Cannot remove');
  });

  it('returns 400 when neither userId nor email provided', async () => {
    const res = await DELETE(makeRequest('DELETE', {}), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 403 when role is user', async () => {
    const res = await DELETE(makeRequest('DELETE', { userId: 'user-2' }, { 'x-user-role': 'user' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 404 when target user not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValueOnce(null as any);
    const res = await DELETE(makeRequest('DELETE', { userId: 'ghost' }), mockParams);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/projects/[projectId]/members', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValue(mockMember as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.updateUser.mockResolvedValue({ ...mockMember, role: 'project_admin' } as any);
  });

  it('updates user role and returns updated user', async () => {
    const res = await PATCH(makeRequest('PATCH', { userId: 'user-2', role: 'project_admin' }), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
  });

  it('returns 400 when userId is missing', async () => {
    const res = await PATCH(makeRequest('PATCH', { role: 'project_admin' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when role is missing', async () => {
    const res = await PATCH(makeRequest('PATCH', { userId: 'user-2' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when role is invalid', async () => {
    const res = await PATCH(makeRequest('PATCH', { userId: 'user-2', role: 'superadmin' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 400 when trying to change role of owner or admin', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findUserById.mockResolvedValueOnce(mockOwner as any);
    const res = await PATCH(makeRequest('PATCH', { userId: 'user-1', role: 'user' }), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('owner/admin');
  });

  it('returns 403 when role is project_admin (only owner/admin can change roles)', async () => {
    const res = await PATCH(
      makeRequest('PATCH', { userId: 'user-2', role: 'user' }, { 'x-user-role': 'project_admin' }),
      mockParams,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when project not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValueOnce(null as any);
    const res = await PATCH(makeRequest('PATCH', { userId: 'user-2', role: 'user' }), mockParams);
    expect(res.status).toBe(404);
  });
});
