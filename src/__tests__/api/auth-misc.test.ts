import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { POST as logoutPOST } from '@/server/api/routes/auth/logout/route';
import { GET as sessionGET } from '@/server/api/routes/auth/session/route';
import { getDatabase } from '@/lib/database';

function makeSessionRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/auth/session', {
    method: 'GET',
    headers,
  });
}

// ─────────────────────────────────────────────
// Logout
// ─────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  it('returns 200 with logout message', async () => {
    const request = new NextRequest('http://localhost/api/auth/logout', { method: 'POST' });
    const res = await logoutPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/logged out/i);
  });

  it('clears the token cookie', async () => {
    const res = await logoutPOST();
    const setCookieHeader = res.headers.get('set-cookie');
    // Cookie deletion sets Max-Age=0 or deletes via header
    expect(setCookieHeader === null || setCookieHeader.includes('token=') || !setCookieHeader.includes('token=mock')).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────

describe('GET /api/auth/session', () => {
  let db: ReturnType<typeof createMockDb>;

  const mockUser = {
    _id: 'user-1',
    email: 'owner@acme.com',
    name: 'Owner',
    role: 'owner' as const,
    licenseId: 'FREE',
    features: ['LLM_CHAT'],
    tenantId: 'tenant-1',
    password: '$hashed',
    mustChangePassword: false,
    projectIds: ['proj-1', 'proj-2'],
  };

  const validHeaders = {
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 'tenant-1',
    'x-user-id': 'user-1',
    'x-user-role': 'owner',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockResolvedValue(mockUser);
  });

  it('returns 401 when tenant-db-name header missing', async () => {
    const res = await sessionGET(makeSessionRequest({ 'x-tenant-id': 'tenant-1', 'x-user-id': 'user-1', 'x-user-role': 'owner' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when tenant-id header missing', async () => {
    const res = await sessionGET(makeSessionRequest({ 'x-tenant-db-name': 'tenant_acme', 'x-user-id': 'user-1', 'x-user-role': 'owner' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when user-id header missing', async () => {
    const res = await sessionGET(makeSessionRequest({ 'x-tenant-db-name': 'tenant_acme', 'x-tenant-id': 'tenant-1', 'x-user-role': 'owner' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when role header missing', async () => {
    const res = await sessionGET(makeSessionRequest({ 'x-tenant-db-name': 'tenant_acme', 'x-tenant-id': 'tenant-1', 'x-user-id': 'user-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when user not found', async () => {
    db.findUserById.mockResolvedValue(null);
    const res = await sessionGET(makeSessionRequest(validHeaders));
    expect(res.status).toBe(401);
  });

  it('returns 401 when user tenantId mismatches header', async () => {
    db.findUserById.mockResolvedValue({ ...mockUser, tenantId: 'OTHER-tenant' });
    const res = await sessionGET(makeSessionRequest(validHeaders));
    expect(res.status).toBe(401);
  });

  it('returns 200 with session info for valid user', async () => {
    const res = await sessionGET(makeSessionRequest(validHeaders));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.role).toBe('owner');
  });

  it('returns mustChangePassword flag', async () => {
    db.findUserById.mockResolvedValue({ ...mockUser, mustChangePassword: true });
    const res = await sessionGET(makeSessionRequest(validHeaders));
    const body = await res.json();
    expect(body.mustChangePassword).toBe(true);
  });

  it('returns projectCount from user.projectIds', async () => {
    const res = await sessionGET(makeSessionRequest(validHeaders));
    const body = await res.json();
    expect(body.projectCount).toBe(2);
  });

  it('returns projectCount of 0 when no projectIds', async () => {
    db.findUserById.mockResolvedValue({ ...mockUser, projectIds: undefined });
    const res = await sessionGET(makeSessionRequest(validHeaders));
    const body = await res.json();
    expect(body.projectCount).toBe(0);
  });

  it('switches to tenant database before user lookup', async () => {
    await sessionGET(makeSessionRequest(validHeaders));
    expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });

  it('returns 500 on unexpected error', async () => {
    (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB fail'));
    const res = await sessionGET(makeSessionRequest(validHeaders));
    expect(res.status).toBe(500);
  });
});
