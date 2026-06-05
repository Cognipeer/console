import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findProjectById: vi.fn(),
  deleteProjectApiToken: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

import { DELETE } from '@/server/api/routes/projects/[projectId]/tokens/[id]/route';

const mockProject = { _id: 'proj-1', tenantId: 'tenant-id-1' };
const mockParams = { params: Promise.resolve({ projectId: 'proj-1', id: 'tok-1' }) };

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/projects/proj-1/tokens/tok-1', {
    method: 'DELETE',
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-role': 'owner',
      ...headers,
    },
  });
}

describe('DELETE /api/projects/[projectId]/tokens/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.switchToTenant.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    mockDb.deleteProjectApiToken.mockResolvedValue(true);
  });

  it('deletes a token and returns success', async () => {
    const res = await DELETE(makeRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain('deleted');
  });

  it('calls deleteProjectApiToken with correct args', async () => {
    await DELETE(makeRequest(), mockParams);
    expect(mockDb.deleteProjectApiToken).toHaveBeenCalledWith('tok-1', 'tenant-id-1', 'proj-1');
  });

  it('returns 401 when x-user-role is missing', async () => {
    const res = await DELETE(makeRequest({ 'x-user-role': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-tenant-id is missing', async () => {
    const res = await DELETE(makeRequest({ 'x-tenant-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is member', async () => {
    const res = await DELETE(makeRequest({ 'x-user-role': 'member' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user is viewer', async () => {
    const res = await DELETE(makeRequest({ 'x-user-role': 'viewer' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('allows admin to delete token', async () => {
    const res = await DELETE(makeRequest({ 'x-user-role': 'admin' }), mockParams);
    expect(res.status).toBe(200);
  });

  it('returns 404 when project not in tenant', async () => {
    mockDb.findProjectById.mockResolvedValueOnce({ _id: 'proj-1', tenantId: 'other-tenant' });
    const res = await DELETE(makeRequest(), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 404 when token not found', async () => {
    mockDb.deleteProjectApiToken.mockResolvedValueOnce(false);
    const res = await DELETE(makeRequest(), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.findProjectById.mockRejectedValueOnce(new Error('DB crash'));
    const res = await DELETE(makeRequest(), mockParams);
    expect(res.status).toBe(500);
  });
});
