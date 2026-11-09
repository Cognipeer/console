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
import { getConfig, reloadConfig } from '@/lib/core/config';
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
    remoteAddress?: string,
  ) {
    const cookieHeader = buildCookieHeader(cookies);
    return app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        'content-type': 'application/json',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      ...(remoteAddress ? { remoteAddress } : {}),
      payload: JSON.stringify(body),
    });
  }

  /** Runs `fn` with AUTH_LOGIN_TENANT_SCAN turned on. */
  async function withTenantScan(fn: () => Promise<void>) {
    process.env.AUTH_LOGIN_TENANT_SCAN = 'true';
    reloadConfig();
    try {
      await fn();
    } finally {
      delete process.env.AUTH_LOGIN_TENANT_SCAN;
      reloadConfig();
    }
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

    it('accepts only string values for the slug and workspace, and looks nothing up otherwise', async () => {
      for (const field of ['slug', 'workspace'] as const) {
        for (const value of [{ $ne: null }, { $regex: '^a' }, ['acme-corp'], 42, true]) {
          const res = await login({ email: 'admin@acme.com', password: 'password123', [field]: value });
          expect(res.statusCode).toBe(400);
          expect(parseJsonBody<{ code: string }>(res.body).code).toBe('invalid_body');
        }
      }
      expect(db.findTenantBySlug).not.toHaveBeenCalled();
      expect(db.listTenantsForUser).not.toHaveBeenCalled();
    });

    it('accepts only string values for the email and password', async () => {
      for (const body of [
        { email: { $ne: null }, password: 'password123', slug: 'acme-corp' },
        { email: 'admin@acme.com', password: { $gt: '' }, slug: 'acme-corp' },
        { email: ['admin@acme.com'], password: 'password123' },
        { email: 'admin@acme.com', password: 'x'.repeat(5000), slug: 'acme-corp' },
      ]) {
        const res = await login(body);
        expect(res.statusCode).toBe(400);
        expect(parseJsonBody<{ code: string }>(res.body).code).toBe('invalid_body');
      }
      expect(db.findUserByEmail).not.toHaveBeenCalled();
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('limits sign-in attempts per account across client addresses', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const maxAttempts = getConfig().auth.loginAccountMaxAttempts;
      expect(maxAttempts).toBe(20);
      for (let i = 0; i < maxAttempts; i++) {
        const res = await login(
          { email: 'admin@acme.com', password: `guess-${i}`, slug: 'acme-corp' },
          {},
          `198.51.100.${i + 1}`,
        );
        expect(res.statusCode, `attempt ${i + 1}`).toBe(401);
      }
      const refused = await login(
        { email: ' ADMIN@acme.com ', password: 'guess-last', slug: 'acme-corp' },
        {},
        '198.51.100.250',
      );
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

      // Another account is not affected.
      const other = await login(
        { email: 'someone@acme.com', password: 'guess', slug: 'acme-corp' },
        {},
        '198.51.100.251',
      );
      expect(other.statusCode).toBe(401);
    });

    it('does not limit per account when AUTH_LOGIN_ACCOUNT_MAX_ATTEMPTS is 0', async () => {
      process.env.AUTH_LOGIN_ACCOUNT_MAX_ATTEMPTS = '0';
      reloadConfig();
      try {
        (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        for (let i = 0; i < 25; i++) {
          const res = await login(
            { email: 'admin@acme.com', password: `guess-${i}`, slug: 'acme-corp' },
            {},
            `198.51.100.${i + 1}`,
          );
          expect(res.statusCode, `attempt ${i + 1}`).toBe(401);
        }
      } finally {
        delete process.env.AUTH_LOGIN_ACCOUNT_MAX_ATTEMPTS;
        reloadConfig();
      }
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

    it('binds the tenant database via runWithTenant before user lookup', async () => {
      await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      // Must be bound via a real AsyncLocalStorage scope (runWithTenant), not
      // the process-global switchToTenant fallback, so a concurrent request
      // for another tenant can't clobber this request's tenant binding.
      expect(db.runWithTenant).toHaveBeenCalledWith(
        'tenant_acme-corp',
        expect.any(Function),
      );
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

    it('returns 401 without checking the password when the account has canLogin=false', async () => {
      db.findUserByEmail.mockResolvedValue({ ...mockUser, canLogin: false });
      const res = await login({
        email: 'admin@acme.com',
        password: 'password123',
        slug: 'acme-corp',
      });
      expect(res.statusCode).toBe(401);
      const body = parseJsonBody<{ error: string }>(res.body);
      // Same generic message as "not found" / "wrong password" — never leak
      // that a login-disabled ("Programmatic User") account exists.
      expect(body.error).toMatch(/invalid email or password/i);
      expect(bcrypt.compare).not.toHaveBeenCalled();
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

    it('tries the workspace a portal address names first, with the password and nothing else', async () => {
      const beta = { ...mockTenant, _id: 'tenant-2', slug: 'beta', dbName: 'tenant_beta', companyName: 'Beta' };
      db.listTenantsForUser.mockResolvedValue([
        { tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantDbName: 'tenant_acme-corp', tenantCompanyName: 'Acme Corp', email: 'admin@acme.com' },
        { tenantId: 'tenant-2', tenantSlug: 'beta', tenantDbName: 'tenant_beta', tenantCompanyName: 'Beta', email: 'admin@acme.com' },
      ]);
      db.findTenantBySlug.mockResolvedValue(beta);
      db.findTenantById.mockImplementation(async (id: string) => (id === 'tenant-2' ? beta : mockTenant));
      db.findUserByEmail.mockResolvedValue({ ...mockUser, tenantId: 'tenant-2' });

      const res = await login({ email: 'admin@acme.com', password: 'password123', workspace: 'beta' });
      expect(res.statusCode).toBe(200);
      // The directory search ran (no slug sign-in, so no external authenticator), the hinted workspace first.
      expect(db.findTenantById.mock.calls[0]?.[0]).toBe('tenant-2');
      expect(TokenManager.generateToken).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-2', tenantSlug: 'beta' }));
    });

    it('keeps the usual order for a hint that names no workspace of the person', async () => {
      db.findTenantBySlug.mockResolvedValue(null);
      const res = await login({ email: 'admin@acme.com', password: 'password123', workspace: 'nowhere' });
      expect(res.statusCode).toBe(200);
      expect(TokenManager.generateToken).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
    });

    it('returns 401 when user not found in any tenant', async () => {
      db.listTenantsForUser.mockResolvedValue([]);
      db.listTenants.mockResolvedValue([]);
      const res = await login({ email: 'nobody@nowhere.com', password: 'password123' });
      expect(res.statusCode).toBe(401);
    });

    it('answers an address the directory does not know without reading other tenants, after one password comparison', async () => {
      db.listTenantsForUser.mockResolvedValue([]);
      db.listTenants.mockResolvedValue([mockTenant]);
      const res = await login({ email: 'nobody@nowhere.com', password: 'password123' });
      expect(res.statusCode).toBe(401);
      expect(parseJsonBody<{ error: string }>(res.body).error).toMatch(/invalid email or password/i);
      expect(db.listTenants).not.toHaveBeenCalled();
      expect(db.findUserByEmail).not.toHaveBeenCalled();
      expect(db.registerUserInDirectory).not.toHaveBeenCalled();
      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
      expect(TokenManager.generateToken).not.toHaveBeenCalled();
    });

    it('with AUTH_LOGIN_TENANT_SCAN on, finds the account in another tenant and registers it in the directory', async () => {
      await withTenantScan(async () => {
        db.listTenantsForUser.mockResolvedValue([]);
        db.listTenants.mockResolvedValue([mockTenant]);
        const res = await login({ email: 'admin@acme.com', password: 'password123' });
        expect(res.statusCode).toBe(200);
        expect(db.listTenants).toHaveBeenCalled();
        expect(db.registerUserInDirectory).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
      });
    });

    it('continues to next tenant when password is invalid', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      db.listTenants.mockResolvedValue([]);
      const res = await login({ email: 'admin@acme.com', password: 'wrongpass' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 without checking the password when the known-tenant candidate has canLogin=false', async () => {
      db.findUserByEmail.mockResolvedValue({ ...mockUser, canLogin: false });
      db.listTenants.mockResolvedValue([]);
      const res = await login({ email: 'admin@acme.com', password: 'password123' });
      expect(res.statusCode).toBe(401);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/invalid email or password/i);
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('returns 401 without checking the password when a fallback (all-tenants) candidate has canLogin=false', async () => {
      // No directory entry for this email at all, so the first (known-tenant)
      // loop finds nothing and control falls through to the all-tenants
      // fallback loop (AUTH_LOGIN_TENANT_SCAN), which is the branch under test here.
      await withTenantScan(async () => {
        db.listTenantsForUser.mockResolvedValue([]);
        db.listTenants.mockResolvedValue([mockTenant]);
        db.findUserByEmail.mockResolvedValue({ ...mockUser, canLogin: false });
        const res = await login({ email: 'admin@acme.com', password: 'password123' });
        expect(res.statusCode).toBe(401);
        const body = parseJsonBody<{ error: string }>(res.body);
        expect(body.error).toMatch(/invalid email or password/i);
        expect(bcrypt.compare).not.toHaveBeenCalled();
        expect(db.registerUserInDirectory).not.toHaveBeenCalled();
      });
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
