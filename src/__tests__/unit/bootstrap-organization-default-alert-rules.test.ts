/**
 * The on-prem bootstrap organization and the default alert rules: the one workspace created from BOOTSTRAP_* starts
 * with the default alert rules on its Default Project (unless the installation default is off), and adding them never stops
 * the rest of the bootstrap. The seeding itself is covered in unit/alert-templates.test.ts; here it is a hoisted
 * plain mock, so the arguments and the order of the calls can be asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  seedDefaultAlertRules: vi.fn(),
  defaultAlertRulesOnCreate: vi.fn(),
  ensureDefaultProject: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$2a$10$hashed') },
  hash: vi.fn().mockResolvedValue('$2a$10$hashed'),
}));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: { getFeaturesForLicense: vi.fn().mockReturnValue(['LLM_CHAT']) },
  LicenseType: {},
}));
vi.mock('@/lib/services/projects/projectService', () => ({ ensureDefaultProject: h.ensureDefaultProject }));
vi.mock('@/lib/services/alerts/alertTemplates', () => ({
  seedDefaultAlertRules: h.seedDefaultAlertRules,
  defaultAlertRulesOnCreate: h.defaultAlertRulesOnCreate,
}));

import { reloadConfig } from '@/lib/core/config';
import { getDatabase } from '@/lib/database';
import { ensureBootstrapOrganization } from '@/lib/services/auth/bootstrapOrganization';

const ENV_KEYS = ['BOOTSTRAP_ORG_NAME', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD', 'BOOTSTRAP_ADMIN_NAME'] as const;

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BOOTSTRAP_ORG_NAME = 'Acme Corp';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'Admin@Acme.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Securepassword123!';
  reloadConfig();

  h.seedDefaultAlertRules.mockResolvedValue(5);
  h.defaultAlertRulesOnCreate.mockReturnValue(true);
  h.ensureDefaultProject.mockResolvedValue({ _id: 'proj-1', key: '__default__' });

  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.listTenants.mockResolvedValue([]);
  db.createTenant.mockResolvedValue({
    _id: 'tenant-1', companyName: 'Acme Corp', slug: 'acme-corp', dbName: 'tenant_acme-corp', licenseType: 'FREE', ownerId: '',
  });
  db.createUser.mockResolvedValue({
    _id: 'user-1',
    email: 'admin@acme.test',
    password: '$2a$10$hashed',
    name: 'Administrator',
    role: 'owner',
    licenseId: 'FREE',
    features: ['LLM_CHAT'],
    tenantId: 'tenant-1',
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  reloadConfig();
});

describe('ensureBootstrapOrganization: default alert rules', () => {
  it('adds the default alert rules to the Default Project of the new organization, as its owner', async () => {
    await ensureBootstrapOrganization();

    expect(h.ensureDefaultProject).toHaveBeenCalledWith('tenant_acme-corp', 'tenant-1', 'user-1');
    expect(h.seedDefaultAlertRules).toHaveBeenCalledTimes(1);
    // tenant database, tenant, the default project, the owner
    expect(h.seedDefaultAlertRules).toHaveBeenCalledWith('tenant_acme-corp', 'tenant-1', 'proj-1', 'user-1');
    expect(h.ensureDefaultProject.mock.invocationCallOrder[0]).toBeLessThan(h.seedDefaultAlertRules.mock.invocationCallOrder[0]);
  });

  it('adds nothing when the installation default is off, and still finishes the bootstrap', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(false);
    await ensureBootstrapOrganization();

    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
    expect(db.updateTenant).toHaveBeenCalledWith('tenant-1', { ownerId: 'user-1' });
    expect(db.registerUserInDirectory).toHaveBeenCalledTimes(1);
  });

  it('finishes the bootstrap when the rules could not be added', async () => {
    h.seedDefaultAlertRules.mockResolvedValue(null);
    await ensureBootstrapOrganization();

    expect(db.updateTenant).toHaveBeenCalledWith('tenant-1', { ownerId: 'user-1' });
    expect(db.registerUserInDirectory).toHaveBeenCalledWith(expect.objectContaining({ email: 'admin@acme.test', tenantId: 'tenant-1' }));
  });

  it('adds nothing when the default project has no id', async () => {
    h.ensureDefaultProject.mockResolvedValue({ key: '__default__' });
    await ensureBootstrapOrganization();
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
    expect(db.updateTenant).toHaveBeenCalledTimes(1);
  });

  it('adds nothing when no organization is created: a tenant exists, or the settings are missing', async () => {
    db.listTenants.mockResolvedValue([
      { _id: 'tenant-existing', companyName: 'Existing', slug: 'existing', dbName: 'tenant_existing', licenseType: 'FREE' },
    ]);
    await ensureBootstrapOrganization();
    expect(db.createTenant).not.toHaveBeenCalled();

    db.listTenants.mockResolvedValue([]);
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    reloadConfig();
    await ensureBootstrapOrganization();
    expect(db.createTenant).not.toHaveBeenCalled();

    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });

  it('adds nothing when the password is refused and no organization is created', async () => {
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'short';
    reloadConfig();
    await ensureBootstrapOrganization();
    expect(db.createTenant).not.toHaveBeenCalled();
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });
});
