/**
 * POST /api/auth/register and the default alert rules: a new workspace starts with the five default alert rules on its
 * Default Project (unless the installation default is off), and adding them never decides whether the sign-up works.
 * The seeding itself is covered in unit/alert-templates.test.ts; here it is a hoisted plain mock, so the arguments
 * and the order of the calls can be asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  seedDefaultAlertRules: vi.fn(),
  defaultAlertRulesOnCreate: vi.fn(),
}));

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
vi.mock('@/lib/services/alerts/alertTemplates', () => ({
  seedDefaultAlertRules: h.seedDefaultAlertRules,
  defaultAlertRulesOnCreate: h.defaultAlertRulesOnCreate,
}));

import { getDatabase } from '@/lib/database';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp, hasSetCookie, parseJsonBody } from '../helpers/fastify-api';

describe('POST /api/auth/register: default alert rules', () => {
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
    h.seedDefaultAlertRules.mockResolvedValue(5);
    h.defaultAlertRulesOnCreate.mockReturnValue(true);
    (ensureDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 'proj-1', key: '__default__' });
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

  const register = (body: Record<string, unknown> = validPayload) => app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

  it('adds the default alert rules to the Default Project of the new workspace, as its owner', async () => {
    const res = await register();

    expect(res.statusCode).toBe(201);
    expect(h.seedDefaultAlertRules).toHaveBeenCalledTimes(1);
    // tenant database, tenant, the default project, the new owner
    expect(h.seedDefaultAlertRules).toHaveBeenCalledWith('tenant_new-co', 'tenant-new', 'proj-1', 'user-new');
    expect((ensureDefaultProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan(h.seedDefaultAlertRules.mock.invocationCallOrder[0]);
  });

  it('answers the sign-up as before: the default alert rules are not part of its answer', async () => {
    const res = await register();
    const body = parseJsonBody<Record<string, unknown>>(res.body);
    expect(body.message).toMatch(/registered successfully/i);
    expect(Object.keys(body).sort()).toEqual(['message', 'tenant', 'user']);
    expect(hasSetCookie(res.headers['set-cookie'], 'token')).toBe(true);
  });

  it('adds nothing when the installation default is off', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(false);
    const res = await register();
    expect(res.statusCode).toBe(201);
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });

  it('still signs the person up when the rules could not be added', async () => {
    h.seedDefaultAlertRules.mockResolvedValue(null);
    const res = await register();

    expect(res.statusCode).toBe(201);
    expect(hasSetCookie(res.headers['set-cookie'], 'token')).toBe(true);
    expect(db.updateTenant).toHaveBeenCalledWith('tenant-new', { ownerId: 'user-new' });
  });

  it('adds nothing when there is no default project id to add them to', async () => {
    (ensureDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({ key: '__default__' });
    const res = await register();
    expect(res.statusCode).toBe(201);
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });

  it('adds nothing to a sign-up that is refused', async () => {
    expect((await register({ ...validPayload, password: 'short' })).statusCode).toBe(400);
    expect((await register({ password: 'Securepassword123!', name: 'x', companyName: 'No Email Co' })).statusCode).toBe(400);

    db.findTenantBySlug.mockResolvedValue(mockTenant);
    expect((await register()).statusCode).toBe(409);

    expect(db.createTenant).not.toHaveBeenCalled();
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });
});
