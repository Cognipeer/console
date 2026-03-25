import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

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

import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { TokenManager } from '@/lib/license/token-manager';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import { authApiPlugin } from '@/server/api/plugins/auth';
import {
  createFastifyApiTestApp,
  hasSetCookie,
  parseJsonBody,
} from '../helpers/fastify-api';

function buildCookieHeader(cookies: Record<string, string>) {
  const entries = Object.entries(cookies);
  if (entries.length === 0) {
    return undefined;
  }
  return entries.map(([key, value]) => `${key}=${value}`).join('; ');
}

describe('POST /api/auth/login', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  const mockTenant = {
    _id: 'tenant-1',
    companyName: 'Acme Corp',
    slug: 'acme-corp',
    dbName: 'tenant_acme-corp',
    licenseType: 'FREE',
    ownerId: 'user-1',
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

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(mockTenant);
    db.findUserByEmail.mockResolvedValue(mockUser);
    db.listProjects.mockResolvedValue([]);
    db.updateUser.mockResolvedValue(mockUser);
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (ensureDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 'proj-1', key: '__default__' });
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  async function login(
    body: Record<string, unknown>,
    cookies: Record<string, string> = {},
  ) {
    const cookieHeader = buildCookieHeader(cookies);
    return app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'content-type': 'application/json',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      payload: JSON.stringify(body),
    });
  }

  describe('validation', () => {
    it('returns 400 when email is missing', async () => {
      const res = await login({ password: 'secret', slug: 'acme-corp' });
      expect(res.statusCode).toBe(400);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/required/i);
    });

    it('returns 400 when password is missing', async () => {
      const res = await login({ email: 'admin@acme.com', slug: 'acme-corp' });
      expect(res.statusCode).toBe(400);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/required/i);
    });
  });

  describe('login with slug', () => {
    it('returns 200 on successful login', async () => {
      const res = await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{
        message: string;
        tenant: { slug: string };
        user: { email: string };
      }>(res.body);
      expect(body.message).toBe('Login successful');
      expect(body.user.email).toBe('admin@acme.com');
      expect(body.tenant.slug).toBe('acme-corp');
    });

    it('returns 401 when slug does not exist', async () => {
      db.findTenantBySlug.mockResolvedValue(null);
      const res = await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'unknown',
      });
      expect(res.statusCode).toBe(401);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/invalid company/i);
    });

    it('returns 401 when user not found in tenant', async () => {
      db.findUserByEmail.mockResolvedValue(null);
      const res = await login({
        email: 'noone@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(res.statusCode).toBe(401);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/invalid email or password/i);
    });

    it('returns 401 when password is wrong', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = await login({
        email: 'admin@acme.com',
        password: 'wrongpass',
        slug: 'acme-corp',
      });
      expect(res.statusCode).toBe(401);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/invalid email or password/i);
    });

    it('switches to tenant database before user lookup', async () => {
      await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme-corp');
    });

    it('generates JWT token on successful login', async () => {
      await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
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
      const res = await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(hasSetCookie(res.headers['set-cookie'], 'token')).toBe(true);
    });

    it('returns mustChangePassword flag', async () => {
      db.findUserByEmail.mockResolvedValue({ ...mockUser, mustChangePassword: true });
      const res = await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      const body = parseJsonBody<{ mustChangePassword: boolean }>(res.body);
      expect(body.mustChangePassword).toBe(true);
    });

    it('normalizes email before lookup', async () => {
      await login({
        email: '  Admin@ACME.com  ',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(db.findUserByEmail).toHaveBeenCalledWith('admin@acme.com');
    });

    it('marks invite as accepted on first login', async () => {
      db.findUserByEmail.mockResolvedValue({
        ...mockUser,
        invitedBy: 'owner-user',
        inviteAcceptedAt: undefined,
      });
      await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(db.updateUser).toHaveBeenCalledWith(
        'user-1',
        { inviteAcceptedAt: expect.any(Date) },
      );
    });
  });

  describe('login without slug (directory search)', () => {
    beforeEach(() => {
      db.listTenantsForUser.mockResolvedValue([
        {
          tenantId: 'tenant-1',
          tenantSlug: 'acme-corp',
          tenantDbName: 'tenant_acme-corp',
          tenantCompanyName: 'Acme Corp',
          email: 'admin@acme.com',
        },
      ]);
      db.findTenantById.mockResolvedValue(mockTenant);
    });

    it('returns 200 when user found via directory', async () => {
      const res = await login({ email: 'admin@acme.com', password: 'password123' });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ message: string }>(res.body);
      expect(body.message).toBe('Login successful');
    });

    it('returns 401 when user not found in any tenant', async () => {
      db.listTenantsForUser.mockResolvedValue([]);
      db.listTenants.mockResolvedValue([]);
      const res = await login({ email: 'nobody@nowhere.com', password: 'password123' });
      expect(res.statusCode).toBe(401);
    });

    it('continues to next tenant when password is invalid', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      db.listTenants.mockResolvedValue([]);
      const res = await login({ email: 'admin@acme.com', password: 'wrongpass' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected database error', async () => {
      (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB crash'));
      const res = await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(res.statusCode).toBe(500);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toBe('Internal server error');
    });
  });
});
