import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn(), hash: vi.fn().mockResolvedValue('$2a$10$newHash') },
  compare: vi.fn(),
  hash: vi.fn().mockResolvedValue('$2a$10$newHash'),
}));

import { POST } from '@/app/api/auth/change-password/route';
import { getDatabase } from '@/lib/database';
import bcrypt from 'bcryptjs';

function makeRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  const defaultHeaders = {
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 'tenant-1',
    'x-user-id': 'user-1',
    'x-tenant-slug': 'acme',
    'Content-Type': 'application/json',
    ...headers,
  };
  return new NextRequest('http://localhost/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: defaultHeaders,
  });
}

describe('POST /api/auth/change-password', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockResolvedValue(mockUser);
    db.updateUser.mockResolvedValue(mockUser);
    (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  });

  describe('authorization', () => {
    it('returns 401 when tenant-db-name header missing', async () => {
      const req = makeRequest(
        { currentPassword: 'old', newPassword: 'newpassword123' },
        { 'x-tenant-db-name': '', 'x-tenant-id': 'tenant-1', 'x-user-id': 'user-1' },
      );
      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it('returns 403 for demo tenant', async () => {
      const res = await POST(makeRequest(
        { currentPassword: 'old', newPassword: 'newpassword123' },
        { 'x-tenant-slug': 'demo' },
      ));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/demo/i);
    });
  });

  describe('validation', () => {
    it('returns 400 when currentPassword is missing', async () => {
      const res = await POST(makeRequest({ newPassword: 'newpassword123' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when newPassword is missing', async () => {
      const res = await POST(makeRequest({ currentPassword: 'oldpass123' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when newPassword is too short', async () => {
      const res = await POST(makeRequest({ currentPassword: 'oldpass123', newPassword: 'short' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/8 characters/i);
    });
  });

  describe('password verification', () => {
    it('returns 401 when user not found', async () => {
      db.findUserById.mockResolvedValue(null);
      const res = await POST(makeRequest({ currentPassword: 'old', newPassword: 'newpassword123' }));
      expect(res.status).toBe(401);
    });

    it('returns 401 when user tenantId mismatches', async () => {
      db.findUserById.mockResolvedValue({ ...mockUser, tenantId: 'other-tenant' });
      const res = await POST(makeRequest({ currentPassword: 'old', newPassword: 'newpassword123' }));
      expect(res.status).toBe(401);
    });

    it('returns 401 when current password is wrong', async () => {
      (bcrypt.compare as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = await POST(makeRequest({ currentPassword: 'wrongpass', newPassword: 'newpassword123' }));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid current password/i);
    });
  });

  describe('successful change', () => {
    it('returns 200 on success', async () => {
      const res = await POST(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpassword123' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('hashes the new password', async () => {
      await POST(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpassword123' }));
      expect(bcrypt.hash).toHaveBeenCalledWith('newpassword123', 10);
    });

    it('updates user with hashed password and clears mustChangePassword', async () => {
      await POST(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpassword123' }));
      expect(db.updateUser).toHaveBeenCalledWith('user-1', expect.objectContaining({
        password: '$2a$10$newHash',
        mustChangePassword: false,
      }));
    });

    it('switches to tenant database', async () => {
      await POST(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpassword123' }));
      expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme');
    });

    it('verifies current password against stored hash', async () => {
      await POST(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpassword123' }));
      expect(bcrypt.compare).toHaveBeenCalledWith('oldpass', '$2a$10$currentHash');
    });
  });

  describe('error handling', () => {
    it('returns 500 when updateUser fails', async () => {
      db.updateUser.mockResolvedValue(null);
      const res = await POST(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpassword123' }));
      expect(res.status).toBe(500);
    });

    it('returns 500 on unexpected error', async () => {
      (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB crash'));
      const res = await POST(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpassword123' }));
      expect(res.status).toBe(500);
    });
  });
});
