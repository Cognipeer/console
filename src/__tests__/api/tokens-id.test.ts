import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  listApiTokens: vi.fn(),
  deleteApiToken: vi.fn(),
  deleteProjectApiToken: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
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

import { DELETE } from '@/server/api/routes/tokens/[id]/route';
import { requireProjectContext } from '@/lib/services/projects/projectContext';

const mockRequireProjectContext = vi.mocked(requireProjectContext);

const mockProjectContext = {
  tenantDbName: 'tenant_test',
  tenantId: 'tenant-id-1',
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'owner',
};

const mockToken = {
  _id: 'token-1',
  tenantId: 'tenant-id-1',
  projectId: 'proj-1',
  userId: 'user-1',
  name: 'My Token',
};

const mockParams = { params: Promise.resolve({ id: 'token-1' }) };

function makeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/tokens/token-1', {
    method: 'DELETE',
    headers: {
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
      ...headers,
    },
  });
}

describe('DELETE /api/tokens/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireProjectContext.mockResolvedValue(mockProjectContext as any);
    mockDb.deleteProjectApiToken.mockResolvedValue(true);
    mockDb.deleteApiToken.mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.listApiTokens.mockResolvedValue([mockToken] as any);
  });

  it('deletes token and returns success message for owner', async () => {
    const res = await DELETE(makeRequest(), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('message');
  });

  it('calls deleteProjectApiToken for owner role', async () => {
    await DELETE(makeRequest(), mockParams);
    expect(mockDb.deleteProjectApiToken).toHaveBeenCalledWith(
      'token-1',
      'tenant-id-1',
      'proj-1',
    );
  });

  it('user role uses deleteApiToken with ownership check', async () => {
    await DELETE(makeRequest({ 'x-user-role': 'user' }), mockParams);
    expect(mockDb.listApiTokens).toHaveBeenCalledWith('user-1');
    expect(mockDb.deleteApiToken).toHaveBeenCalledWith('token-1', 'user-1');
  });

  it('returns 404 when user does not own the token', async () => {
    // Token with different userId
    mockDb.listApiTokens.mockResolvedValueOnce([{ ...mockToken, _id: 'other-token' }] as ReturnType<typeof mockDb.listApiTokens> extends Promise<infer T> ? T : never);
    const res = await DELETE(makeRequest({ 'x-user-role': 'user' }), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 404 when deleteProjectApiToken returns false', async () => {
    mockDb.deleteProjectApiToken.mockResolvedValueOnce(false);
    const res = await DELETE(makeRequest(), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await DELETE(makeRequest({ 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-role is missing', async () => {
    const res = await DELETE(makeRequest({ 'x-user-role': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('admin role uses deleteProjectApiToken', async () => {
    await DELETE(makeRequest({ 'x-user-role': 'admin' }), mockParams);
    expect(mockDb.deleteProjectApiToken).toHaveBeenCalled();
    expect(mockDb.deleteApiToken).not.toHaveBeenCalled();
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.deleteProjectApiToken.mockRejectedValueOnce(new Error('DB error'));
    const res = await DELETE(makeRequest(), mockParams);
    expect(res.status).toBe(500);
  });
});
