import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/quota/quotaService', () => ({
  updateQuotaPolicy: vi.fn(),
  deleteQuotaPolicy: vi.fn(),
}));

import { PATCH, DELETE } from '@/app/api/quota/policies/[id]/route';
import { updateQuotaPolicy, deleteQuotaPolicy } from '@/lib/services/quota/quotaService';

const mockUpdateQuotaPolicy = vi.mocked(updateQuotaPolicy);
const mockDeleteQuotaPolicy = vi.mocked(deleteQuotaPolicy);

const mockPolicy = {
  _id: 'policy-1',
  tenantId: 'tenant-id-1',
  scope: 'tenant',
  domain: 'model',
  limits: { requestsPerMinute: 100 },
};

const mockParams = { params: Promise.resolve({ id: 'policy-1' }) };

function makeRequest(
  method: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  search = '',
) {
  return new NextRequest(`http://localhost/api/quota/policies/policy-1${search}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/quota/policies/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateQuotaPolicy.mockResolvedValue(mockPolicy as any);
  });

  it('updates the policy and returns it', async () => {
    const res = await PATCH(makeRequest('PATCH', { limits: { requestsPerMinute: 50 } }), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('policy');
  });

  it('calls updateQuotaPolicy with correct args', async () => {
    await PATCH(makeRequest('PATCH', { limits: { requestsPerMinute: 50 } }), mockParams);
    expect(mockUpdateQuotaPolicy).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'policy-1',
      expect.objectContaining({ updatedBy: 'user-1' }),
      undefined,
    );
  });

  it('reads projectId from query param if provided', async () => {
    await PATCH(makeRequest('PATCH', {}, {}, '?projectId=proj-abc'), mockParams);
    expect(mockUpdateQuotaPolicy).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'policy-1',
      expect.any(Object),
      'proj-abc',
    );
  });

  it('returns 404 when policy not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockUpdateQuotaPolicy.mockResolvedValueOnce(null as any);
    const res = await PATCH(makeRequest('PATCH', {}), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 403 when role is user', async () => {
    const res = await PATCH(makeRequest('PATCH', {}, { 'x-user-role': 'user' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('allows admin role', async () => {
    const res = await PATCH(makeRequest('PATCH', {}, { 'x-user-role': 'admin' }), mockParams);
    expect(res.status).toBe(200);
  });

  it('returns 401 when x-tenant-db-name is missing', async () => {
    const res = await PATCH(makeRequest('PATCH', {}, { 'x-tenant-db-name': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockUpdateQuotaPolicy.mockRejectedValueOnce(new Error('DB error'));
    const res = await PATCH(makeRequest('PATCH', {}), mockParams);
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/quota/policies/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteQuotaPolicy.mockResolvedValue(true);
  });

  it('deletes the policy and returns success', async () => {
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('calls deleteQuotaPolicy with correct args', async () => {
    await DELETE(makeRequest('DELETE'), mockParams);
    expect(mockDeleteQuotaPolicy).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'policy-1',
      undefined,
    );
  });

  it('passes projectId from query string', async () => {
    await DELETE(makeRequest('DELETE', {}, {}, '?projectId=proj-xyz'), mockParams);
    expect(mockDeleteQuotaPolicy).toHaveBeenCalledWith(
      'tenant_test',
      'tenant-id-1',
      'policy-1',
      'proj-xyz',
    );
  });

  it('returns 404 when policy not found', async () => {
    mockDeleteQuotaPolicy.mockResolvedValueOnce(false);
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(404);
  });

  it('returns 403 when role is project_admin', async () => {
    const res = await DELETE(makeRequest('DELETE', {}, { 'x-user-role': 'project_admin' }), mockParams);
    expect(res.status).toBe(403);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const res = await DELETE(makeRequest('DELETE', {}, { 'x-user-id': '' }), mockParams);
    expect(res.status).toBe(401);
  });

  it('returns 500 on service error', async () => {
    mockDeleteQuotaPolicy.mockRejectedValueOnce(new Error('fail'));
    const res = await DELETE(makeRequest('DELETE'), mockParams);
    expect(res.status).toBe(500);
  });
});
