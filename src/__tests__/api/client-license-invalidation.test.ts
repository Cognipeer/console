/**
 * Applying or resetting a license through the client (token) API drops the tenant's license-derived state
 * (plan, service availability, enterprise access), exactly as the dashboard /license routes do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  invalidate: vi.fn(async () => undefined),
  db: {
    findTenantById: vi.fn(),
    updateTenant: vi.fn(),
    switchToTenant: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => []),
  },
}));

vi.mock('@/lib/limits/invalidate', () => ({ invalidateTenantLicenseState: h.invalidate }));
vi.mock('@/lib/database', () => ({
  getDatabase: async () => h.db,
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: {
    verifyOfflineLicenseKey: vi.fn(async () => ({ licenseId: 'L1', licenseType: 'PRO', payload: {}, expiresAt: new Date() })),
    getEffectiveLicenseForTenant: vi.fn(() => ({ licenseId: 'L1', licenseType: 'PRO' })),
    getDefaultFreeLicense: vi.fn(() => ({ licenseId: 'FREE', licenseType: 'FREE' })),
  },
}));
// The token gate is not under test: the handler gets the token's tenant directly.
vi.mock('@/server/api/fastify-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/api/fastify-utils')>()),
  withClientApiRequestContext: (handler: (req: unknown, reply: unknown, auth: unknown) => unknown) =>
    (req: unknown, reply: unknown) => handler(req, reply, { tenantId: 'tenant-1' }),
}));

import Fastify from 'fastify';
import { clientLicenseApiPlugin } from '@/server/api/plugins/client-license';

beforeEach(() => {
  vi.clearAllMocks();
  h.db.findTenantById.mockResolvedValue({ _id: 'tenant-1', dbName: 'tenant_acme' });
  h.db.updateTenant.mockResolvedValue({ _id: 'tenant-1', dbName: 'tenant_acme' });
});

describe('client license API invalidates the license-derived state', () => {
  it.each([
    ['POST', { licenseKey: 'x'.repeat(40) }],
    ['DELETE', undefined],
  ] as const)('%s /client/v1/license', async (method, payload) => {
    const app = Fastify();
    await app.register(clientLicenseApiPlugin);
    const res = await app.inject({ method, url: '/client/v1/license', ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(200);
    expect(h.invalidate).toHaveBeenCalledWith('tenant-1');
    await app.close();
  });

  it('does not invalidate when the license could not be stored', async () => {
    h.db.updateTenant.mockResolvedValue(null);
    const app = Fastify();
    await app.register(clientLicenseApiPlugin);
    const res = await app.inject({ method: 'DELETE', url: '/client/v1/license' });
    expect(res.statusCode).toBe(500);
    expect(h.invalidate).not.toHaveBeenCalled();
    await app.close();
  });
});
