import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn(), hash: vi.fn().mockResolvedValue('$2a$10$newHash') },
  compare: vi.fn(),
  hash: vi.fn().mockResolvedValue('$2a$10$newHash'),
}));

import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import { BCRYPT_ROUNDS } from '@/lib/services/auth/passwordPolicy';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { authApiPlugin } from '@/server/api/plugins/auth';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

describe('POST /api/auth/change-password', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  const mockUser = {
    _id: 'user-1',
    email: 'user@acme.com',
    name: 'User',
    role: 'owner' as const,
    licenseId: 'FREE',
    features: [] as string[],
    tenantId: 'tenant-1',
    password: '$2a$10$currentHash',
  };

  const defaultHeaders = {
    'content-type': 'application/json',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 'tenant-1',
    'x-tenant-slug': 'acme',
    'x-user-id': 'user-1',
    'x-user-role': 'owner',
    'x-license-type': 'FREE',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRateLimitStore();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockResolvedValue(mockUser);
    db.updateUser.mockResolvedValue(mockUser);
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  async function changePassword(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
    url = '/api/auth/change-password',
  ) {
    return app.inject({
      method: 'POST',
      url,
      headers: {
        ...defaultHeaders,
        ...headers,
      },
      payload: JSON.stringify(body),
    });
  }

  it('returns 401 when session headers missing', async () => {
    const res = await changePassword(
      { currentPassword: 'old', newPassword: 'Newpassword123!' },
      {
        'x-tenant-db-name': '',
        'x-tenant-id': '',
        'x-user-id': '',
      },
    );
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when newPassword is too short', async () => {
    const res = await changePassword({
      currentPassword: 'oldpass123',
      newPassword: 'short',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 when user not found', async () => {
    db.findUserById.mockResolvedValue(null);
    const res = await changePassword({
      currentPassword: 'old',
      newPassword: 'Newpassword123!',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when current password is wrong', async () => {
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await changePassword({
      currentPassword: 'wrongpass',
      newPassword: 'Newpassword123!',
    });
    expect(res.statusCode).toBe(401);
    const body = parseJsonBody<{ error: string }>(res.body);
    expect(body.error).toMatch(/invalid current password/i);
  });

  it('returns 200 on success', async () => {
    const res = await changePassword({
      currentPassword: 'oldpass',
      newPassword: 'Newpassword123!',
    });
    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ success: boolean }>(res.body);
    expect(body.success).toBe(true);
  });

  it('hashes the new password and updates the user', async () => {
    await changePassword({
      currentPassword: 'oldpass',
      newPassword: 'Newpassword123!',
    });
    expect(bcrypt.hash).toHaveBeenCalledWith('Newpassword123!', BCRYPT_ROUNDS);
    expect(db.updateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        password: '$2a$10$newHash',
        mustChangePassword: false,
      }),
    );
  });

  it('returns 500 when updateUser fails', async () => {
    db.updateUser.mockResolvedValue(null);
    const res = await changePassword({
      currentPassword: 'oldpass',
      newPassword: 'Newpassword123!',
    });
    expect(res.statusCode).toBe(500);
  });

  it('names what is wrong with a stable code', async () => {
    const missing = await changePassword({ currentPassword: 'oldpass' });
    expect([missing.statusCode, parseJsonBody<{ code: string }>(missing.body).code]).toEqual([400, 'invalid_body']);
    const weak = await changePassword({ currentPassword: 'oldpass', newPassword: 'short' });
    expect([weak.statusCode, parseJsonBody<{ code: string }>(weak.body).code]).toEqual([400, 'invalid_password']);
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const wrong = await changePassword({ currentPassword: 'wrongpass', newPassword: 'Newpassword123!' });
    expect([wrong.statusCode, parseJsonBody<{ code: string }>(wrong.body).code]).toEqual([401, 'invalid_current_password']);
  });

  describe('an account whose password lives in a directory', () => {
    it.each(['ldap', 'oidc', 'saml'])('%s: has no password to change here (409) and nothing is checked or written', async (authProvider) => {
      db.findUserById.mockResolvedValue({ ...mockUser, authProvider } as never);
      const res = await changePassword({ currentPassword: 'oldpass', newPassword: 'Newpassword123!' });
      expect(res.statusCode).toBe(409);
      expect(parseJsonBody<{ code: string }>(res.body).code).toBe('password_managed_externally');
      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('a local account, with or without the provider field, changes it as before', async () => {
      for (const authProvider of [undefined, 'local']) {
        db.findUserById.mockResolvedValue({ ...mockUser, authProvider } as never);
        expect((await changePassword({ currentPassword: 'oldpass', newPassword: 'Newpassword123!' })).statusCode).toBe(200);
      }
    });
  });

  describe('POST /api/auth/me/password (the same operation under the account\'s own path)', () => {
    const viaMe = (body: Record<string, unknown>) => changePassword(body, {}, '/api/auth/me/password');

    it('changes the password of a local account and clears the forced change', async () => {
      const res = await viaMe({ currentPassword: 'oldpass', newPassword: 'Newpassword123!' });
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<{ success: boolean }>(res.body).success).toBe(true);
      expect(db.updateUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ password: '$2a$10$newHash', mustChangePassword: false }));
    });

    it('needs the current password, and refuses a wrong one', async () => {
      expect((await viaMe({ newPassword: 'Newpassword123!' })).statusCode).toBe(400);
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const wrong = await viaMe({ currentPassword: 'wrongpass', newPassword: 'Newpassword123!' });
      expect(wrong.statusCode).toBe(401);
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('is not for a directory account, or for a request without a session', async () => {
      db.findUserById.mockResolvedValue({ ...mockUser, authProvider: 'oidc' } as never);
      expect((await viaMe({ currentPassword: 'oldpass', newPassword: 'Newpassword123!' })).statusCode).toBe(409);
      const anonymous = await changePassword({ currentPassword: 'a', newPassword: 'Newpassword123!' }, { 'x-tenant-db-name': '', 'x-tenant-id': '', 'x-user-id': '' }, '/api/auth/me/password');
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe('rate limit', () => {
    it('stops a session that keeps guessing the current password, on either path, and says when to retry', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      for (let i = 0; i < 10; i += 1) {
        const url = i % 2 === 0 ? '/api/auth/change-password' : '/api/auth/me/password';
        expect((await changePassword({ currentPassword: `guess${i}`, newPassword: 'Newpassword123!' }, {}, url)).statusCode).toBe(401);
      }
      const limited = await changePassword({ currentPassword: 'guess10', newPassword: 'Newpassword123!' });
      expect(limited.statusCode).toBe(429);
      expect(parseJsonBody<{ code: string }>(limited.body).code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // even the right password waits
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      expect((await changePassword({ currentPassword: 'oldpass', newPassword: 'Newpassword123!' }, {}, '/api/auth/me/password')).statusCode).toBe(429);
      // another person is not affected
      expect((await changePassword({ currentPassword: 'oldpass', newPassword: 'Newpassword123!' }, { 'x-user-id': 'user-2' })).statusCode).not.toBe(429);
    });
  });
});
