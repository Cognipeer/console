import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockDb } from '../helpers/db.mock';

// Mocks
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
  compare: vi.fn(),
  hash: vi.fn(),
}));
vi.mock('@/lib/license/token-manager', () => ({
  TokenManager: {
    generateToken: vi.fn().mockResolvedValue('mock-jwt-token'),
  },
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));

import { POST } from '@/server/api/routes/auth/login/route';
import { getDatabase } from '@/lib/database';
import bcrypt from 'bcryptjs';
import { TokenManager } from '@/lib/license/token-manager';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';

function makeRequest(body: Record<string, unknown>, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  // patch cookies
  Object.entries(cookies).forEach(([k, v]) => {
    Object.defineProperty(req.cookies, 'get', {
      value: (name: string) => (name === k ? { name, value: v } : undefined),
      configurable: true,
    });
  });
  return req;
}

describe('POST /api/auth/login', () => {
  let db: ReturnType<typeof createMockDb>;

  const mockTenant = {
    _id: 'tenant-1',
    companyName: 'Acme Corp',
    slug: 'acme-corp',
    dbName: 'tenant_acme-corp',
    licenseType: 'FREE',
    ownerId: 'user-1',
    isDemo: false,
  };

  const mockUser = {
    _id: 'user-1',
    email: 'admin@acme.com',
    password: '$2a$10$hashedpassword',
    name: 'Admin User',
    role: 'owner' as const,
    licenseId: 'FREE',
    features: ['LLM_CHAT'],
    tenantId: 'tenant-1',
    invitedBy: undefined,
    inviteAcceptedAt: undefined,
    mustChangePassword: false,
    projectIds: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(mockTenant);
    db.findUserByEmail.mockResolvedValue(mockUser);
    db.listProjects.mockResolvedValue([]);
    db.updateUser.mockResolvedValue(mockUser);
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ensureDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 'proj-1', key: '__default__' });
  });

  describe('validation', () => {
    it('returns 400 when email is missing', async () => {
      const res = await POST(makeRequest({ password: 'secret', slug: 'acme-corp' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/required/i);
    });

    it('returns 400 when password is missing', async () => {
      const res = await POST(makeRequest({ email: 'admin@acme.com', slug: 'acme-corp' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/required/i);
    });

    it('returns 400 when both email and password are missing', async () => {
      const res = await POST(makeRequest({ slug: 'acme-corp' }));
      expect(res.status).toBe(400);
    });
  });

  describe('login with slug', () => {
    it('returns 200 on successful login', async () => {
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Login successful');
      expect(body.user.email).toBe('admin@acme.com');
      expect(body.tenant.slug).toBe('acme-corp');
    });

    it('returns 401 when slug does not exist', async () => {
      db.findTenantBySlug.mockResolvedValue(null);
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'unknown' }));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/invalid company/i);
    });

    it('returns 401 when user not found in tenant', async () => {
      db.findUserByEmail.mockResolvedValue(null);
      const res = await POST(makeRequest({ email: 'noone@acme.com', password: 'password123', slug: 'acme-corp' }));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/invalid email or password/i);
    });

    it('returns 401 when password is wrong', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'wrongpass', slug: 'acme-corp' }));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/invalid email or password/i);
    });

    it('switches to tenant database before user lookup', async () => {
      await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme-corp');
    });

    it('generates JWT token on successful login', async () => {
      await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      expect(TokenManager.generateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          email: 'admin@acme.com',
          tenantId: 'tenant-1',
          tenantSlug: 'acme-corp',
        }),
      );
    });

    it('sets token cookie on successful login', async () => {
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      const setCookieHeader = res.headers.get('set-cookie');
      expect(setCookieHeader).toBeTruthy();
      expect(setCookieHeader).toContain('token=');
    });

    it('returns user info in response body', async () => {
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      const body = await res.json();
      expect(body.user).toMatchObject({
        email: 'admin@acme.com',
        name: 'Admin User',
        role: 'owner',
        licenseType: 'FREE',
      });
    });

    it('returns tenant info in response body', async () => {
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      const body = await res.json();
      expect(body.tenant).toMatchObject({
        companyName: 'Acme Corp',
        slug: 'acme-corp',
      });
    });

    it('returns mustChangePassword flag', async () => {
      db.findUserByEmail.mockResolvedValue({ ...mockUser, mustChangePassword: true });
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      const body = await res.json();
      expect(body.mustChangePassword).toBe(true);
    });

    it('normalizes email before lookup', async () => {
      await POST(makeRequest({ email: '  Admin@ACME.com  ', password: 'password123', slug: 'acme-corp' }));
      expect(db.findUserByEmail).toHaveBeenCalledWith('admin@acme.com');
    });

    it('marks invite as accepted on first login', async () => {
      db.findUserByEmail.mockResolvedValue({ ...mockUser, invitedBy: 'owner-user', inviteAcceptedAt: undefined });
      await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      expect(db.updateUser).toHaveBeenCalledWith('user-1', { inviteAcceptedAt: expect.any(Date) });
    });

    it('does not mark invite for non-invited users', async () => {
      await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      expect(db.updateUser).not.toHaveBeenCalledWith('user-1', { inviteAcceptedAt: expect.any(Date) });
    });

    it('demo tenant does not force password change', async () => {
      db.findTenantBySlug.mockResolvedValue({ ...mockTenant, isDemo: true });
      db.findUserByEmail.mockResolvedValue({ ...mockUser, mustChangePassword: true });
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      const body = await res.json();
      expect(body.mustChangePassword).toBe(false);
    });
  });

  describe('login without slug (directory search)', () => {
    beforeEach(() => {
      db.listTenantsForUser.mockResolvedValue([{ tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantDbName: 'tenant_acme-corp', tenantCompanyName: 'Acme Corp', email: 'admin@acme.com' }]);
      db.findTenantById.mockResolvedValue(mockTenant);
    });

    it('returns 200 when user found via directory', async () => {
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Login successful');
    });

    it('returns 401 when user not found in any tenant', async () => {
      db.listTenantsForUser.mockResolvedValue([]);
      db.listTenants.mockResolvedValue([]);
      const res = await POST(makeRequest({ email: 'nobody@nowhere.com', password: 'password123' }));
      expect(res.status).toBe(401);
    });

    it('continues to next tenant when password is invalid', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      db.listTenantsForUser.mockResolvedValue([{ tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantDbName: 'tenant_acme-corp', tenantCompanyName: 'Acme Corp', email: 'admin@acme.com' }]);
      db.listTenants.mockResolvedValue([]);
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'wrongpass' }));
      expect(res.status).toBe(401);
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected database error', async () => {
      (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB crash'));
      const res = await POST(makeRequest({ email: 'admin@acme.com', password: 'password123', slug: 'acme-corp' }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error');
    });
  });
});
