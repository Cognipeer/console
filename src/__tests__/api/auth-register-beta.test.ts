/**
 * Registration gating: REGISTRATION_MODE=beta (access codes) and =disabled
 * (on-prem). The default 'open' path is covered by auth-register.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
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

import { reloadConfig } from '@/lib/core/config';
import { getDatabase } from '@/lib/database';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

describe('registration gating (REGISTRATION_MODE)', () => {
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

  function setMode(mode: string | undefined): void {
    if (mode === undefined) {
      delete process.env.REGISTRATION_MODE;
    } else {
      process.env.REGISTRATION_MODE = mode;
    }
    reloadConfig();
  }

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
    setMode(undefined);
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

  describe('GET /api/auth/register/options', () => {
    it('reports the active registration mode', async () => {
      setMode('beta');
      const res = await app.inject({ method: 'GET', url: '/api/auth/register/options' });
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<{ mode: string }>(res.body).mode).toBe('beta');
    });

    it('defaults to open', async () => {
      setMode(undefined);
      const res = await app.inject({ method: 'GET', url: '/api/auth/register/options' });
      expect(parseJsonBody<{ mode: string }>(res.body).mode).toBe('open');
    });
  });

  describe('beta mode', () => {
    beforeEach(() => {
      setMode('beta');
      db.consumeBetaAccessCode.mockResolvedValue(true);
    });

    it('returns 400 when access code is missing', async () => {
      const res = await register(validPayload);
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toMatch(/access code/i);
      expect(db.createTenant).not.toHaveBeenCalled();
    });

    it('returns 400 when the code is invalid or already used', async () => {
      db.consumeBetaAccessCode.mockResolvedValue(false);
      const res = await register({ ...validPayload, accessCode: 'BETA-DEAD-BEEF' });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toMatch(/invalid or already used/i);
      expect(db.createTenant).not.toHaveBeenCalled();
    });

    it('registers successfully with a valid code and consumes it', async () => {
      const res = await register({ ...validPayload, accessCode: '  beta-code-1  ' });
      expect(res.statusCode).toBe(201);
      expect(db.consumeBetaAccessCode).toHaveBeenCalledWith('beta-code-1', {
        email: validPayload.email,
      });
      expect(db.createTenant).toHaveBeenCalled();
    });

    it('releases the claimed code when registration fails afterwards', async () => {
      db.createTenant.mockRejectedValue(new Error('boom'));
      const res = await register({ ...validPayload, accessCode: 'BETA-CODE-2' });
      expect(res.statusCode).toBe(500);
      expect(db.releaseBetaAccessCode).toHaveBeenCalledWith('BETA-CODE-2');
    });
  });

  describe('disabled mode', () => {
    it('returns 403 and never touches the database', async () => {
      setMode('disabled');
      const res = await register(validPayload);
      expect(res.statusCode).toBe(403);
      expect(db.createTenant).not.toHaveBeenCalled();
      expect(db.consumeBetaAccessCode).not.toHaveBeenCalled();
    });
  });

  describe('open mode', () => {
    it('ignores access codes entirely', async () => {
      setMode('open');
      const res = await register(validPayload);
      expect(res.statusCode).toBe(201);
      expect(db.consumeBetaAccessCode).not.toHaveBeenCalled();
    });
  });
});
