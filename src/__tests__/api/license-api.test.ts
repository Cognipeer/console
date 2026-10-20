import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: {
    getEffectiveLicenseForTenant: vi.fn(),
  },
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  ServiceDisabledError: class ServiceDisabledError extends Error {},
  clearServiceAvailabilityMemo: vi.fn(),
  getDisabledServices: vi.fn(async () => new Map()),
  serviceOffReason: vi.fn(async () => null),
  unknownLicenseServiceIds: vi.fn(() => []),
}));

import { getDatabase } from '@/lib/database';
import { LicenseManager } from '@/lib/license/license-manager';
import { getDisabledServices } from '@/lib/services/availability/serviceAvailability';
import { licenseApiPlugin } from '@/server/api/plugins/license';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const HEADERS = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'stale-session-slug',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
};

describe('GET /api/license', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const db = createMockDb();
    db.findTenantById.mockResolvedValue({
      _id: 'tenant-1',
      companyName: 'Acme Corp',
      slug: 'acme-canonical',
      dbName: 'tenant_acme',
      licenseType: 'FREE',
    } as never);
    db.findUserById.mockResolvedValue({
      _id: 'user-1',
      tenantId: 'tenant-1',
      role: 'owner',
    } as never);
    db.listProjects.mockResolvedValue([{ _id: 'project-1' }] as never);
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    (LicenseManager.getEffectiveLicenseForTenant as ReturnType<typeof vi.fn>).mockReturnValue({
      licenseId: 'FREE',
      licenseType: 'FREE',
      status: 'free',
      source: 'free',
      features: [],
      limits: { maxProjects: 2 },
    });
    app = await createFastifyApiTestApp(licenseApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the canonical tenant slug for the active license', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/license',
      headers: HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(parseJsonBody(response.body)).toMatchObject({
      canManage: true,
      projectCount: 1,
      tenantSlug: 'acme-canonical',
    });
  });

  it('lists every switchable service with its state and what switched it off', async () => {
    (getDisabledServices as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Map([
      ['browser', { service: 'browser', source: 'env' }],
      ['vector', { service: 'vector', source: 'license' }],
      ['rag', { service: 'rag', source: 'license', via: 'vector' }],
    ]));
    const response = await app.inject({ method: 'GET', url: '/api/license', headers: HEADERS });

    expect(response.statusCode).toBe(200);
    const services = (parseJsonBody(response.body) as { services: Array<Record<string, unknown>> }).services;
    const byId = new Map(services.map((item) => [item.service, item]));
    expect(byId.get('browser')).toEqual({ service: 'browser', label: 'Browsers', enabled: false, source: 'env' });
    expect(byId.get('rag')).toEqual({ service: 'rag', label: 'Knowledge Engine', enabled: false, source: 'license', via: 'vector' });
    expect(byId.get('models')).toEqual({ service: 'models', label: 'Model Hub', enabled: true });
    expect(byId.get('mcp-hub')).toMatchObject({ label: 'MCP Hub catalogs', enabled: true });
    // The administration services cannot be switched off, so they are not listed.
    expect(byId.has('license')).toBe(false);
  });
});