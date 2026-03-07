import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/config')>('@/lib/core/config');
  return {
    ...actual,
    getConfig: vi.fn(() => {
      const config = actual.getConfig();
      return {
        ...config,
        app: {
          ...config.app,
          demoEmail: 'demo@cognipeer.ai',
        },
        nodeEnv: 'test',
      };
    }),
  };
});
vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn(), hash: vi.fn().mockResolvedValue('$2a$10$hashed') },
  compare: vi.fn(),
  hash: vi.fn().mockResolvedValue('$2a$10$hashed'),
}));
vi.mock('@/lib/license/token-manager', () => ({
  TokenManager: {
    generateToken: vi.fn().mockResolvedValue('mock-jwt-token'),
  },
}));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: {
    getFeaturesForLicense: vi.fn().mockReturnValue(['LLM_CHAT']),
  },
  LicenseType: {},
}));
vi.mock('@/lib/email/mailer', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
}));

import bcrypt from 'bcryptjs';
import { getConfig } from '@/lib/core/config';
import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { LicenseManager } from '@/lib/license/license-manager';
import { TokenManager } from '@/lib/license/token-manager';
import { BCRYPT_ROUNDS } from '@/lib/services/auth/passwordPolicy';
import { authApiPlugin } from '@/server/api/plugins/auth';
import {
  createFastifyApiTestApp,
  hasSetCookie,
  parseJsonBody,
} from '../helpers/fastify-api';

describe('POST /api/auth/register', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  const validPayload = {
    email: 'owner@newco.com',
    password: 'Securepassword123!',
    name: 'New Owner',
    companyName: 'New Co',
  };

  const mockTenant = {
    _id: 'tenant-new',
    companyName: 'New Co',
    slug: 'new-co',
    dbName: 'tenant_new-co',
    licenseType: 'FREE',
    ownerId: '',
  };

  const mockUser = {
    _id: 'user-new',
    email: 'owner@newco.com',
    password: '$2a$10$hashed',
    name: 'New Owner',
    role: 'owner' as const,
    licenseId: 'FREE',
    features: ['LLM_CHAT'],
    tenantId: 'tenant-new',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(null);
    db.createTenant.mockResolvedValue(mockTenant);
    db.createUser.mockResolvedValue(mockUser);
    db.updateTenant.mockResolvedValue(mockTenant);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  async function register(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  }

  describe('validation', () => {
    it('returns 400 when email is missing', async () => {
      const res = await register({ password: 'securepass', name: 'Test', companyName: 'Test Co' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when password is too short', async () => {
      const res = await register({ ...validPayload, password: 'short' });
      expect(res.statusCode).toBe(400);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/8 characters/i);
    });
  });

  describe('reserved identifiers', () => {
    it('blocks demo email', async () => {
      const res = await register({
        ...validPayload,
        email: getConfig().app.demoEmail,
      });
      expect(res.statusCode).toBe(409);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toMatch(/reserved/i);
    });

    it('blocks demo slug', async () => {
      const res = await register({ ...validPayload, companyName: 'Demo' });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('duplicate tenant', () => {
    it('returns 409 when slug already exists', async () => {
      db.findTenantBySlug.mockResolvedValue(mockTenant);
      const res = await register(validPayload);
      expect(res.statusCode).toBe(409);
    });
  });

  describe('successful registration', () => {
    it('returns 201 on successful registration', async () => {
      const res = await register(validPayload);
      expect(res.statusCode).toBe(201);
      const body = parseJsonBody<{ message: string }>(res.body);
      expect(body.message).toMatch(/registered successfully/i);
    });

    it('creates tenant with correct slug', async () => {
      await register(validPayload);
      expect(db.createTenant).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'new-co',
          companyName: 'New Co',
          dbName: 'tenant_new-co',
        }),
      );
    });

    it('hashes password before creating user', async () => {
      await register(validPayload);
      expect(bcrypt.hash).toHaveBeenCalledWith('Securepassword123!', BCRYPT_ROUNDS);
      expect(db.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ password: '$2a$10$hashed' }),
      );
    });

    it('updates tenant with ownerId after user creation', async () => {
      await register(validPayload);
      expect(db.updateTenant).toHaveBeenCalledWith('tenant-new', { ownerId: 'user-new' });
    });

    it('generates JWT token with tenant info', async () => {
      await register(validPayload);
      expect(TokenManager.generateToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-new',
          email: 'owner@newco.com',
          tenantId: 'tenant-new',
          tenantSlug: 'new-co',
        }),
      );
    });

    it('sets token cookie in response', async () => {
      const res = await register(validPayload);
      expect(hasSetCookie(res.headers['set-cookie'], 'token')).toBe(true);
    });

    it('sends welcome email', async () => {
      await register(validPayload);
      expect(sendEmail).toHaveBeenCalledWith(
        'owner@newco.com',
        'welcome',
        expect.objectContaining({ name: 'New Owner', slug: 'new-co' }),
      );
    });

    it('uses FREE license by default', async () => {
      await register(validPayload);
      expect(LicenseManager.getFeaturesForLicense).toHaveBeenCalledWith('FREE');
    });

    it('accepts custom licenseType', async () => {
      await register({ ...validPayload, licenseType: 'PRO' });
      expect(LicenseManager.getFeaturesForLicense).toHaveBeenCalledWith('PRO');
    });
  });

  describe('error handling', () => {
    it('returns 500 on database failure', async () => {
      (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
      const res = await register(validPayload);
      expect(res.statusCode).toBe(500);
      const body = parseJsonBody<{ error: string }>(res.body);
      expect(body.error).toBe('Internal server error');
    });
  });
});
