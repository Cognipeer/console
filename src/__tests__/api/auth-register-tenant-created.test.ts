/**
 * POST /api/auth/register announces the new tenant to a registered listener once its default project exists, and a
 * failing listener never decides whether the sign-up works.
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
  TokenManager: { generateToken: vi.fn().mockResolvedValue('mock-jwt-token') },
}));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: { getFeaturesForLicense: vi.fn().mockReturnValue(['LLM_CHAT']) },
  LicenseType: {},
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
}));
vi.mock('@/lib/services/alerts/alertTemplates', () => ({
  seedDefaultAlertRules: vi.fn().mockResolvedValue(0),
  defaultAlertRulesOnCreate: vi.fn().mockReturnValue(false),
}));

import { getDatabase } from '@/lib/database';
import { ensureDefaultProject } from '@/lib/services/projects/projectService';
import { registerTenantCreatedListener, resetTenantCreatedListenersForTests } from '@/enterprise/tenant-lifecycle';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

describe('POST /api/auth/register: tenant-created seam', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  const payload = { email: 'owner@newco.com', password: 'Securepassword123!', name: 'New Owner', companyName: 'New Co' };
  const tenant = { _id: 'tenant-new', companyName: 'New Co', slug: 'new-co', dbName: 'tenant_new-co', licenseType: 'FREE', ownerId: '' };
  const user = {
    _id: 'user-new', email: 'owner@newco.com', password: '$2a$10$hashed', name: 'New Owner', role: 'owner' as const,
    licenseId: 'FREE', features: ['LLM_CHAT'], tenantId: 'tenant-new',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    (ensureDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 'proj-1', key: '__default__' });
    const db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(null);
    db.createTenant.mockResolvedValue(tenant);
    db.createUser.mockResolvedValue(user);
    db.updateTenant.mockResolvedValue(tenant);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    resetTenantCreatedListenersForTests();
    await app.close();
  });

  const register = () => app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

  it('calls the listener with the new tenant after the default project', async () => {
    const listener = vi.fn();
    registerTenantCreatedListener(listener);
    const res = await register();
    expect(res.statusCode).toBe(201);
    expect(listener).toHaveBeenCalledWith({ tenantId: 'tenant-new', tenantSlug: 'new-co', tenantDbName: 'tenant_new-co' });
    expect((ensureDefaultProject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan(listener.mock.invocationCallOrder[0]);
  });

  it('answers 201 even when the listener fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    registerTenantCreatedListener(async () => { throw new Error('boom'); });
    const res = await register();
    expect(res.statusCode).toBe(201);
    error.mockRestore();
  });
});
