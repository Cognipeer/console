/**
 * A disabled account (status: 'disabled') must be refused by EVERY door to a
 * session, with exactly the generic failure canLogin=false already produces —
 * never a distinguishable "disabled" answer, which would let anyone probe for
 * valid accounts. Legacy rows (no status field) must keep working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn(), hash: vi.fn().mockResolvedValue('$new-hash') },
  compare: vi.fn(),
  hash: vi.fn().mockResolvedValue('$new-hash'),
}));
vi.mock('@/lib/license/token-manager', () => ({
  TokenManager: { generateToken: vi.fn().mockResolvedValue('mock-jwt-token') },
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));
vi.mock('@/lib/services/auth/rateLimiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth/rateLimiter')>();
  return { ...actual, checkRateLimit: vi.fn().mockReturnValue({ allowed: true }) };
});

import bcrypt from 'bcryptjs';
import { getConfig } from '@/lib/core/config';
import { getDatabase, type ITenant, type IUser } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { registerExternalAuthenticator } from '@/enterprise/external-auth';
import { createInvitationUrl } from '@/lib/services/auth/invitation';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import { TokenManager } from '@/lib/license/token-manager';
import { authApiPlugin, issueSessionForAuthenticatedUser } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp, hasSetCookie, parseJsonBody } from '../helpers/fastify-api';

const tenant = {
  _id: 'tenant-1',
  companyName: 'Acme',
  slug: 'acme-corp',
  dbName: 'tenant_acme-corp',
  licenseType: 'FREE',
  ownerId: 'owner-1',
};

const activeUser = {
  _id: 'user-1',
  email: 'jane@acme.com',
  name: 'Jane',
  password: '$2a$12$hash',
  role: 'user' as const,
  tenantId: 'tenant-1',
  licenseId: 'FREE',
  features: [],
  projectIds: [],
};
const disabledUser = { ...activeUser, status: 'disabled' as const, disabledAt: new Date() };

describe('disabled users and the auth routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    registerExternalAuthenticator(null);
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(tenant as never);
    db.listProjects.mockResolvedValue([]);
    db.updateUser.mockResolvedValue(activeUser as never);
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    registerExternalAuthenticator(null);
    await app.close();
  });

  const login = (body: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  function expectGenericFailure(res: Awaited<ReturnType<typeof login>>) {
    expect(res.statusCode).toBe(401);
    expect(parseJsonBody<{ error: string }>(res.body)).toEqual({ error: 'Invalid email or password' });
    expect(hasSetCookie(res.headers['set-cookie'], 'token')).toBe(false);
    expect(TokenManager.generateToken).not.toHaveBeenCalled();
  }

  describe('POST /api/auth/login', () => {
    it('slug + local password: generic 401, password never checked', async () => {
      db.findUserByEmail.mockResolvedValue(disabledUser as never);
      const res = await login({ email: activeUser.email, password: 'pw-123456', slug: tenant.slug });
      expectGenericFailure(res);
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('slug + external authenticator vouching for the user: generic 401', async () => {
      registerExternalAuthenticator(async () => ({ outcome: 'pass', user: disabledUser as unknown as IUser }));
      const res = await login({ email: activeUser.email, password: 'pw-123456', slug: tenant.slug });
      expectGenericFailure(res);
    });

    it('directory (known-tenant) lookup: generic 401, password never checked', async () => {
      db.listTenantsForUser.mockResolvedValue([
        { tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantDbName: tenant.dbName, tenantCompanyName: 'Acme', email: activeUser.email },
      ] as never);
      db.findTenantById.mockResolvedValue(tenant as never);
      db.listTenants.mockResolvedValue([]);
      db.findUserByEmail.mockResolvedValue(disabledUser as never);
      const res = await login({ email: activeUser.email, password: 'pw-123456' });
      expectGenericFailure(res);
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('all-tenants fallback lookup: generic 401, password never checked, directory not populated', async () => {
      db.listTenantsForUser.mockResolvedValue([]);
      db.listTenants.mockResolvedValue([tenant as never]);
      db.findUserByEmail.mockResolvedValue(disabledUser as never);
      const res = await login({ email: activeUser.email, password: 'pw-123456' });
      expectGenericFailure(res);
      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(db.registerUserInDirectory).not.toHaveBeenCalled();
    });

    it('a legacy row with no status field and an explicitly active row still sign in', async () => {
      for (const user of [activeUser, { ...activeUser, status: 'active' as const }]) {
        db.findUserByEmail.mockResolvedValue(user as never);
        const res = await login({ email: activeUser.email, password: 'pw-123456', slug: tenant.slug });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('issueSessionForAuthenticatedUser', () => {
    const reply = () => {
      const r = {
        header: vi.fn().mockReturnThis(),
        setCookie: vi.fn().mockReturnThis(),
        clearCookie: vi.fn().mockReturnThis(),
        code: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };
      return r as unknown as FastifyReply & typeof r;
    };
    const request = { ip: '203.0.113.9', cookies: {}, headers: {} } as unknown as FastifyRequest;

    it('refuses to mint a session for a disabled user, whichever authenticator called it', async () => {
      const r = reply();
      await issueSessionForAuthenticatedUser(
        db as never, tenant as unknown as ITenant, disabledUser as unknown as IUser, request, r,
      );
      expect(r.code).toHaveBeenCalledWith(401);
      expect(r.send).toHaveBeenCalledWith({ error: 'Invalid email or password' });
      expect(r.setCookie).not.toHaveBeenCalled();
      expect(TokenManager.generateToken).not.toHaveBeenCalled();
      expect(ensureDefaultProject).not.toHaveBeenCalled();
    });

    it('still issues one for an active user', async () => {
      const r = reply();
      await issueSessionForAuthenticatedUser(
        db as never, tenant as unknown as ITenant, activeUser as unknown as IUser, request, r,
      );
      expect(r.code).toHaveBeenCalledWith(200);
      expect(r.setCookie).toHaveBeenCalled();
    });
  });

  describe('POST /api/auth/forgot-password', () => {
    const forgot = () => app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: activeUser.email, slug: tenant.slug }),
    });

    it('answers like an unknown email and sends nothing', async () => {
      db.findUserByEmail.mockResolvedValue(disabledUser as never);
      const disabledRes = await forgot();
      db.findUserByEmail.mockResolvedValue(null);
      const unknownRes = await forgot();

      expect(disabledRes.statusCode).toBe(200);
      expect(disabledRes.body).toBe(unknownRes.body);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('still mails a legacy (status-less) account', async () => {
      db.findUserByEmail.mockResolvedValue(activeUser as never);
      const res = await forgot();
      expect(res.statusCode).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/auth/reset-password', () => {
    async function resetToken(sub: string) {
      const secret = new TextEncoder().encode(getConfig().auth.jwtSecret);
      return new SignJWT({ email: activeUser.email, purpose: 'password-reset', slug: tenant.slug, sub })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(secret);
    }
    const reset = async (token: string) => app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token, newPassword: 'Str0ng!Passw0rd#2026' }),
    });

    it('rejects a valid token for a disabled account with the generic invalid-token 400', async () => {
      db.findUserById.mockResolvedValue(disabledUser as never);
      const res = await reset(await resetToken(activeUser._id));
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Invalid reset token');
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('rejects an invitation link for a disabled invitee', async () => {
      const invitee = { ...disabledUser, invitedBy: 'owner-1', invitedAt: new Date(), canLogin: true };
      db.findUserById.mockResolvedValue(invitee as never);
      const url = await createInvitationUrl({ ...invitee } as unknown as IUser, tenant.slug);
      const token = new URL(url).searchParams.get('token')!;
      const res = await reset(token);
      expect(res.statusCode).toBe(400);
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('a successful reset never touches the lifecycle fields', async () => {
      db.findUserById.mockResolvedValue(activeUser as never);
      const res = await reset(await resetToken(activeUser._id));
      expect(res.statusCode).toBe(200);
      const patch = db.updateUser.mock.calls[0][1] as Record<string, unknown>;
      for (const key of ['status', 'disabledAt', 'disabledBy', 'disabledReason']) {
        expect(patch).not.toHaveProperty(key);
      }
    });
  });

  describe('POST /api/auth/change-password', () => {
    it('never touches the lifecycle fields', async () => {
      db.findUserById.mockResolvedValue(activeUser as never);
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: {
          'content-type': 'application/json',
          'x-tenant-db-name': tenant.dbName,
          'x-tenant-id': 'tenant-1',
          'x-tenant-slug': tenant.slug,
          'x-license-type': 'FREE',
          'x-user-id': activeUser._id,
          'x-user-email': activeUser.email,
          'x-user-role': 'user',
        },
        payload: JSON.stringify({ currentPassword: 'old-password', newPassword: 'Str0ng!Passw0rd#2026' }),
      });
      expect(res.statusCode).toBe(200);
      const patch = db.updateUser.mock.calls[0][1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('status');
      expect(patch).not.toHaveProperty('disabledAt');
    });
  });
});
