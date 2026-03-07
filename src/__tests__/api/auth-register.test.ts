import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
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

import { POST } from '@/server/api/routes/auth/register/route';
import { getDatabase } from '@/lib/database';
import bcrypt from 'bcryptjs';
import { TokenManager } from '@/lib/license/token-manager';
import { LicenseManager } from '@/lib/license/license-manager';
import { sendEmail } from '@/lib/email/mailer';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/auth/register', () => {
  let db: ReturnType<typeof createMockDb>;

  const validPayload = {
    email: 'owner@newco.com',
    password: 'securepassword123',
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

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(null); // no existing tenant
    db.createTenant.mockResolvedValue(mockTenant);
    db.createUser.mockResolvedValue(mockUser);
    db.updateTenant.mockResolvedValue(mockTenant);
  });

  describe('validation', () => {
    it('returns 400 when email is missing', async () => {
      const res = await POST(makeRequest({ password: 'securepass', name: 'Test', companyName: 'Test Co' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/required/i);
    });

    it('returns 400 when password is missing', async () => {
      const res = await POST(makeRequest({ email: 'a@b.com', name: 'Test', companyName: 'Test Co' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when name is missing', async () => {
      const res = await POST(makeRequest({ email: 'a@b.com', password: 'securepass', companyName: 'Test Co' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when companyName is missing', async () => {
      const res = await POST(makeRequest({ email: 'a@b.com', password: 'securepass', name: 'Test' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when password is too short', async () => {
      const res = await POST(makeRequest({ ...validPayload, password: 'short' }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/8 characters/i);
    });
  });

  describe('reserved identifiers', () => {
    it('blocks demo email', async () => {
      const res = await POST(makeRequest({ ...validPayload, email: 'demo@cognipeer.ai' }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/reserved/i);
    });

    it('blocks demo slug (company name "demo")', async () => {
      const res = await POST(makeRequest({ ...validPayload, companyName: 'Demo' }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/reserved/i);
    });
  });

  describe('duplicate tenant', () => {
    it('returns 409 when slug already exists', async () => {
      db.findTenantBySlug.mockResolvedValue(mockTenant);
      const res = await POST(makeRequest(validPayload));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already exists/i);
    });
  });

  describe('successful registration', () => {
    it('returns 201 on successful registration', async () => {
      const res = await POST(makeRequest(validPayload));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.message).toMatch(/registered successfully/i);
    });

    it('creates tenant with correct slug', async () => {
      await POST(makeRequest(validPayload));
      expect(db.createTenant).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'new-co',
          companyName: 'New Co',
          dbName: 'tenant_new-co',
        }),
      );
    });

    it('switches to tenant database after creation', async () => {
      await POST(makeRequest(validPayload));
      expect(db.switchToTenant).toHaveBeenCalledWith('tenant_new-co');
    });

    it('hashes password before creating user', async () => {
      await POST(makeRequest(validPayload));
      expect(bcrypt.hash).toHaveBeenCalledWith('securepassword123', 10);
      expect(db.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ password: '$2a$10$hashed' }),
      );
    });

    it('creates user with owner role', async () => {
      await POST(makeRequest(validPayload));
      expect(db.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'owner' }),
      );
    });

    it('updates tenant with ownerId after user creation', async () => {
      await POST(makeRequest(validPayload));
      expect(db.updateTenant).toHaveBeenCalledWith('tenant-new', { ownerId: 'user-new' });
    });

    it('generates JWT token with tenant info', async () => {
      await POST(makeRequest(validPayload));
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
      const res = await POST(makeRequest(validPayload));
      const setCookieHeader = res.headers.get('set-cookie');
      expect(setCookieHeader).toBeTruthy();
      expect(setCookieHeader).toContain('token=');
    });

    it('returns user info in response', async () => {
      const res = await POST(makeRequest(validPayload));
      const body = await res.json();
      expect(body.user).toMatchObject({
        email: 'owner@newco.com',
        name: 'New Owner',
        role: 'owner',
      });
    });

    it('returns tenant info in response', async () => {
      const res = await POST(makeRequest(validPayload));
      const body = await res.json();
      expect(body.tenant).toMatchObject({
        companyName: 'New Co',
        slug: 'new-co',
      });
    });

    it('sends welcome email (fire and forget)', async () => {
      await POST(makeRequest(validPayload));
      expect(sendEmail).toHaveBeenCalledWith(
        'owner@newco.com',
        'welcome',
        expect.objectContaining({ name: 'New Owner', slug: 'new-co' }),
      );
    });

    it('uses FREE license by default', async () => {
      await POST(makeRequest(validPayload));
      expect(LicenseManager.getFeaturesForLicense).toHaveBeenCalledWith('FREE');
    });

    it('accepts custom licenseType', async () => {
      await POST(makeRequest({ ...validPayload, licenseType: 'PRO' }));
      expect(LicenseManager.getFeaturesForLicense).toHaveBeenCalledWith('PRO');
    });

    it('generates slug correctly from company name with spaces/special chars', async () => {
      await POST(makeRequest({ ...validPayload, companyName: 'My Awesome Company!!' }));
      expect(db.createTenant).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'my-awesome-company' }),
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on database failure', async () => {
      (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
      const res = await POST(makeRequest(validPayload));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Internal server error');
    });
  });
});
