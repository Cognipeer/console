import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findUserById: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

import { DELETE } from '@/server/api/routes/users/[id]/route';

const mockParams = { params: Promise.resolve({ id: 'user-99' }) };

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/users/user-99', {
    method: 'DELETE',
    headers: {
      'x-tenant-db-name': 'tenant_acme',
      'x-user-id': 'user-1',
      'x-user-role': 'admin',
      ...headers,
    },
  });
}

const mockUser = { _id: 'user-99', email: 'other@example.com', role: 'user' };
const ownerUser = { _id: 'user-99', email: 'owner@example.com', role: 'owner' };

describe('DELETE /api/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.switchToTenant.mockResolvedValue(undefined);
  });

  it('deletes user and returns success message', async () => {
    mockDb.findUserById.mockResolvedValue(mockUser);
    mockDb.deleteUser.mockResolvedValue(true);
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.message).toBe('User deleted successfully');
  });

  it('returns 400 when tenantDbName missing', async () => {
    const req = makeRequest({ 'x-tenant-db-name': '' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 403 when user role is not owner or admin', async () => {
    const req = makeRequest({ 'x-user-role': 'user' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 400 when deleting own account', async () => {
    const selfParams = { params: Promise.resolve({ id: 'user-1' }) };
    const req = makeRequest();
    const res = await DELETE(req, selfParams);
    expect(res.status).toBe(400);
  });

  it('returns 404 when user not found', async () => {
    mockDb.findUserById.mockResolvedValue(null);
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 403 when trying to delete owner', async () => {
    mockDb.findUserById.mockResolvedValue(ownerUser);
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/owner/i);
  });

  it('returns 500 when deleteUser returns false', async () => {
    mockDb.findUserById.mockResolvedValue(mockUser);
    mockDb.deleteUser.mockResolvedValue(false);
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(500);
  });

  it('owner role can also delete users', async () => {
    mockDb.findUserById.mockResolvedValue(mockUser);
    mockDb.deleteUser.mockResolvedValue(true);
    const req = makeRequest({ 'x-user-role': 'owner' });
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(200);
  });

  it('switches to correct tenant DB', async () => {
    mockDb.findUserById.mockResolvedValue(mockUser);
    mockDb.deleteUser.mockResolvedValue(true);
    const req = makeRequest();
    await DELETE(req, mockParams);
    expect(mockDb.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.switchToTenant.mockRejectedValue(new Error('conn error'));
    const req = makeRequest();
    const res = await DELETE(req, mockParams);
    expect(res.status).toBe(500);
  });
});
