import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  switchToTenant: vi.fn(),
  findTenantById: vi.fn(),
  findUserByEmail: vi.fn(),
  listUsers: vi.fn(),
  createUser: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue(mockDb),
}));

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('hashed-password') },
  hash: vi.fn().mockResolvedValue('hashed-password'),
}));

vi.mock('@/lib/email/mailer', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-default' }),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true } as any),
}));

import { POST } from '@/server/api/routes/users/invite/route';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';

const mockCheckResourceQuota = vi.mocked(checkResourceQuota);

const mockTenant = {
  _id: 'tenant-id-1',
  companyName: 'Acme',
  slug: 'acme',
  licenseType: 'PRO',
};

function makeRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/users/invite', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-db-name': 'tenant_test',
      'x-tenant-id': 'tenant-id-1',
      'x-user-id': 'inviter-1',
      'x-user-role': 'owner',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  name: 'New User',
  email: 'newuser@example.com',
  role: 'user',
};

describe('POST /api/users/invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.switchToTenant.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockDb.findTenantById.mockResolvedValue(mockTenant as any);
    mockDb.findUserByEmail.mockResolvedValue(null);
    mockDb.listUsers.mockResolvedValue([]);
    mockDb.createUser.mockResolvedValue({
      _id: 'new-user-1',
      name: 'New User',
      email: 'newuser@example.com',
      role: 'user',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckResourceQuota.mockResolvedValue({ allowed: true } as any);
  });

  it('creates an invited user and returns 201', async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message).toContain('invited');
    expect(body.user.email).toBe('newuser@example.com');
  });

  it('returns 400 when tenant headers are missing', async () => {
    const res = await POST(makeRequest(validBody, { 'x-tenant-db-name': '' }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when inviter is a regular user', async () => {
    const res = await POST(makeRequest(validBody, { 'x-user-role': 'user' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const { name: _, ...withoutName } = validBody;
    const res = await POST(makeRequest(withoutName));
    expect(res.status).toBe(400);
  });

  it('returns 400 when email format is invalid', async () => {
    const res = await POST(makeRequest({ ...validBody, email: 'not-an-email' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('email');
  });

  it('returns 400 when role is invalid', async () => {
    const res = await POST(makeRequest({ ...validBody, role: 'superadmin' }));
    expect(res.status).toBe(400);
  });

  it('returns 409 when user with that email already exists', async () => {
    mockDb.findUserByEmail.mockResolvedValueOnce({ _id: 'existing-1', email: 'newuser@example.com' });
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(409);
  });

  it('returns 404 when tenant not found', async () => {
    mockDb.findTenantById.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(404);
  });

  it('returns 429 when user quota exceeded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCheckResourceQuota.mockResolvedValueOnce({ allowed: false, reason: 'User limit reached' } as any);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(429);
  });

  it('allows admin role as inviter', async () => {
    const res = await POST(makeRequest(validBody, { 'x-user-role': 'admin' }));
    expect(res.status).toBe(201);
  });

  it('returns 500 on unexpected error', async () => {
    mockDb.createUser.mockRejectedValueOnce(new Error('DB failure'));
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(500);
  });
});
