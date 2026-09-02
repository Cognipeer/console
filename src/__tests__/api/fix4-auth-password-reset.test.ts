/**
 * Password reset for login-disabled ("Programmatic User") accounts.
 *
 * Login already refuses them on every path; the reset flow used to be the one
 * door left open — it minted a token, sent the mail, and let a user-chosen
 * password be planted on a record that must never log in. Both routes now
 * answer exactly as they do for an unknown account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$new-hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$new-hash'),
  compare: vi.fn(),
}));
vi.mock('@/lib/services/auth/rateLimiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth/rateLimiter')>();
  return { ...actual, checkRateLimit: vi.fn().mockReturnValue({ allowed: true }) };
});

import { getConfig } from '@/lib/core/config';
import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const tenant = {
  _id: 'tenant-1',
  companyName: 'Acme',
  slug: 'acme-corp',
  dbName: 'tenant_acme-corp',
  licenseType: 'FREE',
};

const baseUser = {
  _id: 'user-1',
  email: 'svc@acme.com',
  name: 'Service Bot',
  role: 'user' as const,
  tenantId: 'tenant-1',
  password: '$2a$12$hash',
  licenseId: 'FREE',
  features: [],
};

async function resetTokenFor(sub: string) {
  const secret = new TextEncoder().encode(getConfig().auth.jwtSecret);
  return new SignJWT({ email: baseUser.email, purpose: 'password-reset', slug: tenant.slug, sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secret);
}

describe('password reset and canLogin=false', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(tenant as never);
    db.updateUser.mockResolvedValue(baseUser as never);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/auth/forgot-password', () => {
    const forgot = () => app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: baseUser.email, slug: tenant.slug }),
    });

    it('answers the generic 200 and sends nothing for a login-disabled account', async () => {
      db.findUserByEmail.mockResolvedValue({ ...baseUser, canLogin: false } as never);
      const res = await forgot();
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<{ message: string }>(res.body).message).toMatch(/if that email exists/i);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('still mails a reset link to a login-capable account', async () => {
      db.findUserByEmail.mockResolvedValue({ ...baseUser, canLogin: true } as never);
      const res = await forgot();
      expect(res.statusCode).toBe(200);
      expect(sendEmail).toHaveBeenCalledWith(baseUser.email, 'password-reset', expect.objectContaining({ name: baseUser.name }));
    });
  });

  describe('POST /api/auth/reset-password', () => {
    const reset = async () => app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token: await resetTokenFor(baseUser._id), newPassword: 'Str0ng!Passw0rd#2026' }),
    });

    it('rejects a valid token for a login-disabled account with the same generic 400 as an invalid one', async () => {
      db.findUserById.mockResolvedValue({ ...baseUser, canLogin: false } as never);
      const res = await reset();
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Invalid reset token');
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('still resets a login-capable account', async () => {
      db.findUserById.mockResolvedValue({ ...baseUser, canLogin: true } as never);
      const res = await reset();
      expect(res.statusCode).toBe(200);
      expect(db.updateUser).toHaveBeenCalledWith(baseUser._id, expect.objectContaining({ password: '$new-hash' }));
    });
  });
});
