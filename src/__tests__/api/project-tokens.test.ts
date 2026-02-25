import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findProjectById: vi.fn(),
  listProjectApiTokens: vi.fn(),
  createApiToken: vi.fn(),
  deleteProjectApiToken: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true } as any),
}));

import { GET, POST } from '@/app/api/projects/[projectId]/tokens/route';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';

const mockCheckResourceQuota = vi.mocked(checkResourceQuota);

const mockProject = { _id: 'proj-1', tenantId: 'tenant-id-1' };
const mockTokens = [{ _id: 'tok-1', label: 'Token 1', userId: 'user-1', createdAt: new Date() }];

const mockParams = { params: Promise.resolve({ projectId: 'proj-1' }) };

function makeRequest(method: 'GET' | 'POST', body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/projects/proj-1/tokens', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
      'x-license-type': 'PRO',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/projects/[projectId]/tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.switchToTenant.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.listProjectApiTokens.mockResolvedValue(mockTokens as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckResourceQuota.mockResolvedValue({ allowed: true } as any);
  });

  it('returns list of tokens', async () => {
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
  });

  it('returns 401 when x-license-type is missing', async () => {
    const res = await GET(makeRequest('GET', undefined, { 'x-license-type': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user role is member', async () => {
    const res = await GET(makeRequest('GET', undefined, { 'x-user-role': 'member' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 404 when project is not in tenant', async () => {
    mockDb.findProjectById.mockResolvedValueOnce({ _id: 'proj-1', tenantId: 'different-tenant' });
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.findProjectById.mockRejectedValueOnce(new Error('DB failure'));
    const res = await GET(makeRequest('GET'), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/projects/[projectId]/tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.switchToTenant.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findProjectById.mockResolvedValue(mockProject as any);
    mockDb.createApiToken.mockResolvedValue({
      _id: 'new-tok-1',
      label: 'My Token',
      userId: 'user-1',
      tenantId: 'tenant-id-1',
      projectId: 'proj-1',
      token: 'cpeer_abc123',
    });
  });

  it('creates a new API token', async () => {
    const res = await POST(makeRequest('POST', { label: 'My Token' }), mockParams);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message).toContain('created');
    expect(body.token).toBeDefined();
  });

  it('calls createApiToken with correct args', async () => {
    await POST(makeRequest('POST', { label: 'My Token' }), mockParams);
    expect(mockDb.createApiToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tenantId: 'tenant-id-1',
        projectId: 'proj-1',
        label: 'My Token',
      }),
    );
  });

  it('returns 400 when label is missing', async () => {
    const res = await POST(makeRequest('POST', {}), mockParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Label');
  });

  it('returns 400 when label is too short', async () => {
    const res = await POST(makeRequest('POST', { label: 'ab' }), mockParams);
    expect(res.status).toBe(400);
  });

  it('returns 401 when x-license-type is missing', async () => {
    const res = await POST(makeRequest('POST', { label: 'My Token' }, { 'x-license-type': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is a regular member', async () => {
    const res = await POST(makeRequest('POST', { label: 'My Token' }, { 'x-user-role': 'member' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 404 when project not in tenant', async () => {
    mockDb.findProjectById.mockResolvedValueOnce({ _id: 'proj-1', tenantId: 'other-tenant' });
    const res = await POST(makeRequest('POST', { label: 'My Token' }), mockParams);
    expect(res.status).toBe(404);
  });

  it('allows admin role to create tokens', async () => {
    const res = await POST(makeRequest('POST', { label: 'My Token' }, { 'x-user-role': 'admin' }), mockParams);
    expect(res.status).toBe(201);
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.createApiToken.mockRejectedValueOnce(new Error('DB error'));
    const res = await POST(makeRequest('POST', { label: 'My Token' }), mockParams);
    expect(res.status).toBe(500);
  });
});
