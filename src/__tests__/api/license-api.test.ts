import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/license/license-manager', () => ({
  LicenseManager: {
    getEffectiveLicenseForTenant: vi.fn(),
  },
}));

import { getDatabase } from '@/lib/database';
import { LicenseManager } from '@/lib/license/license-manager';
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
});