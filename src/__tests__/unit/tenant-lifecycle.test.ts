/**
 * Tenant-created seam: listeners run in order, a failing listener never reaches the caller, and the bootstrap
 * organization announces the new tenant once its default project exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  ensureDefaultProject: vi.fn(),
}));

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // Same contract as the real wrapper: bind through the provider's runWithTenant, else switch.
    runWithTenantScope: vi.fn(async (name: string, fn: (db: unknown) => unknown) => {
      const db = (await getDatabase()) as {
        runWithTenant?: (n: string, f: () => unknown) => unknown;
        switchToTenant: (n: string) => unknown;
      };
      if (typeof db.runWithTenant === 'function') return db.runWithTenant(name, () => fn(db));
      await db.switchToTenant(name);
      return fn(db);
    }),
  };
});
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
  seedDefaultAlertRules: vi.fn().mockResolvedValue(0),
  defaultAlertRulesOnCreate: vi.fn().mockReturnValue(false),
}));

import { reloadConfig } from '@/lib/core/config';
import { getDatabase } from '@/lib/database';
import { ensureBootstrapOrganization } from '@/lib/services/auth/bootstrapOrganization';
import {
  notifyTenantCreated,
  registerTenantCreatedListener,
  resetTenantCreatedListenersForTests,
} from '@/enterprise/tenant-lifecycle';

const event = { tenantId: 't1', tenantSlug: 'acme', tenantDbName: 'tenant_acme' };

afterEach(() => resetTenantCreatedListenersForTests());

describe('notifyTenantCreated', () => {
  it('does nothing without a listener', async () => {
    await expect(notifyTenantCreated(event)).resolves.toBeUndefined();
  });

  it('runs listeners one after the other, in registration order', async () => {
    const order: string[] = [];
    registerTenantCreatedListener(async () => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('a:end');
    });
    registerTenantCreatedListener(() => { order.push('b'); });
    await notifyTenantCreated(event);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('logs a throw or a rejection, keeps going, and never rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    registerTenantCreatedListener(() => { throw new Error('boom'); });
    registerTenantCreatedListener(async () => { throw new Error('later'); });
    registerTenantCreatedListener(after);
    await expect(notifyTenantCreated(event)).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledWith(event);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe('bootstrap organization call site', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BOOTSTRAP_ORG_NAME = 'Acme Corp';
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@acme.test';
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'Securepassword123!';
    reloadConfig();
    h.ensureDefaultProject.mockResolvedValue({ _id: 'proj-1', key: '__default__' });
    const db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listTenants.mockResolvedValue([]);
    db.createTenant.mockResolvedValue({ _id: 'tenant-1', companyName: 'Acme Corp', slug: 'acme-corp', dbName: 'tenant_acme-corp' } as never);
    db.createUser.mockResolvedValue({ _id: 'user-1', email: 'admin@acme.test', role: 'owner' } as never);
  });

  afterEach(() => {
    delete process.env.BOOTSTRAP_ORG_NAME;
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
    reloadConfig();
  });

  it('announces the tenant after the default project, and a failing listener does not stop the bootstrap', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const listener = vi.fn(() => { throw new Error('boom'); });
    registerTenantCreatedListener(listener);
    await expect(ensureBootstrapOrganization()).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith({ tenantId: 'tenant-1', tenantSlug: 'acme-corp', tenantDbName: 'tenant_acme-corp' });
    error.mockRestore();
  });

  it('announces nothing when no organization is created', async () => {
    const listener = vi.fn();
    registerTenantCreatedListener(listener);
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    reloadConfig();
    await ensureBootstrapOrganization();
    expect(listener).not.toHaveBeenCalled();
  });
});
