import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  listUsers: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

import { GET } from '@/server/api/routes/users/route';

const ADMIN_HEADERS = {
  'x-tenant-db-name': 'tenant_acme',
  'x-user-role': 'owner',
};

function makeReq(headers: Record<string, string> = ADMIN_HEADERS) {
  return new NextRequest('http://localhost/api/users', { headers });
}

const MOCK_USERS = [
  { _id: 'u-1', email: 'alice@acme.com', role: 'owner' },
  { _id: 'u-2', email: 'bob@acme.com', role: 'admin' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.switchToTenant.mockResolvedValue(undefined);
  mockDb.listUsers.mockResolvedValue(MOCK_USERS);
});

describe('GET /api/users', () => {
  it('returns users list 200', async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(2);
  });

  it('returns 400 when tenantDbName missing', async () => {
    const res = await GET(makeReq({ 'x-user-role': 'owner' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when role missing', async () => {
    const res = await GET(makeReq({ 'x-tenant-db-name': 'tenant_acme' }));
    expect(res.status).toBe(400);
  });

  it('returns 403 for non-owner non-admin role', async () => {
    const res = await GET(makeReq({ 'x-tenant-db-name': 'tenant_acme', 'x-user-role': 'user' }));
    expect(res.status).toBe(403);
  });

  it('allows admin role', async () => {
    const res = await GET(makeReq({ 'x-tenant-db-name': 'tenant_acme', 'x-user-role': 'admin' }));
    expect(res.status).toBe(200);
  });

  it('switches to tenant database', async () => {
    await GET(makeReq());
    expect(mockDb.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.listUsers.mockRejectedValue(new Error('db failure'));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });

  it('returns empty users list', async () => {
    mockDb.listUsers.mockResolvedValue([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.users).toHaveLength(0);
  });
});
