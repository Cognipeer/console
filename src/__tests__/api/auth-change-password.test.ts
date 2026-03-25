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
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
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
});
