import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findProjectById: vi.fn(),
  findUserById: vi.fn(),
  listUsers: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

import { GET } from '@/server/api/routes/projects/[projectId]/member-candidates/route';

const mockProject = { _id: 'proj-1', tenantId: 'tenant-id-1' };
const mockUsers = [
  { _id: 'u-1', email: 'alice@example.com', name: 'Alice', role: 'user', projectIds: [] },
  { _id: 'u-2', email: 'bob@example.com', name: 'Bob', role: 'user', projectIds: ['proj-1'] }, // already a member
  { _id: 'u-3', email: 'carol@example.com', name: 'Carol', role: 'admin', projectIds: [] }, // admin - excluded
];

const mockParams = { params: Promise.resolve({ projectId: 'proj-1' }) };

function makeRequest(headers: Record<string, string> = {}, search = '') {
  const req = new NextRequest(`http://localhost/api/projects/proj-1/member-candidates${search}`, {
    method: 'GET',
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
      ...headers,
    },
  });
  return req;
}

describe('GET /api/projects/[projectId]/member-candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.switchToTenant.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.listUsers.mockResolvedValue(mockUsers as any);
    mockDb.findUserById.mockResolvedValue({ _id: 'user-1', projectIds: [] });
  });

  it('returns empty list when query is missing', async () => {
    const res = await GET(makeRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toEqual([]);
  });

  it('returns empty list when query is too short', async () => {
    const res = await GET(makeRequest({}, '?q=a'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toEqual([]);
  });

  it('returns matching candidate users', async () => {
    const res = await GET(makeRequest({}, '?q=alice'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.length).toBe(1);
    expect(body.users[0].email).toBe('alice@example.com');
  });

  it('excludes users already in the project', async () => {
    const res = await GET(makeRequest({}, '?q=bob'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    // bob is already in proj-1, so should be excluded
    expect(body.users.length).toBe(0);
  });

  it('excludes admin/owner from candidates', async () => {
    const res = await GET(makeRequest({}, '?q=carol'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.length).toBe(0);
  });

  it('returns 401 when x-user-role is missing', async () => {
    const res = await GET(makeRequest({ 'x-user-role': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when project not found', async () => {
    mockDb.findProjectById.mockResolvedValueOnce(null);
    const res = await GET(makeRequest({}, '?q=alice'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.listUsers.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeRequest({}, '?q=alice'), mockParams);
    expect(res.status).toBe(500);
  });
});
