import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { getEnterpriseModuleForPath } from '@/lib/license/enterprise-access';
import { getPermissionServiceForPath } from '@/lib/security/rbac';
import { canonicalizeRequestPathname } from '@/lib/security/requestPath';
import { withApiRequestContext } from '@/server/api/fastify-utils';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

// A route behind the same session RBAC gate every dashboard plugin uses.
const toolsLikePlugin: FastifyPluginAsync = async (app) => {
  app.get('/tools', withApiRequestContext(async (_request, reply) => reply.send({ ok: true })));
};

describe('canonicalizeRequestPathname', () => {
  it('decodes unreserved escapes the router decodes, keeps reserved ones, collapses slashes', () => {
    expect(canonicalizeRequestPathname('/api/to%6Fls?x=1')).toBe('/api/tools');
    expect(canonicalizeRequestPathname('/api/%74ools/abc')).toBe('/api/tools/abc');
    expect(canonicalizeRequestPathname('/api/tools%2Fabc')).toBe('/api/tools%2Fabc');
    expect(canonicalizeRequestPathname('/api//tools')).toBe('/api/tools');
    expect(canonicalizeRequestPathname('/api/%E0%A4%A')).toBe('/api/%E0%A4%A');
    expect(canonicalizeRequestPathname(undefined)).toBe('/');
  });

  it('maps encoded spellings to the same service and licence module as the plain path', () => {
    expect(getPermissionServiceForPath('/api/to%6Fls')).toBeNull(); // the hole: raw form maps to nothing
    expect(getPermissionServiceForPath(canonicalizeRequestPathname('/api/to%6Fls'))).toBe('tools');
    expect(getEnterpriseModuleForPath(canonicalizeRequestPathname('/api/s%61ndbox/runners'))).toBe('sandbox');
  });
});

describe('session RBAC gate with percent-encoded paths', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  const headers = {
    'x-license-type': 'FREE',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': 'tenant-1',
    'x-tenant-slug': 'acme',
    'x-user-id': 'user-1',
    'x-user-role': 'user',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockResolvedValue({
      _id: 'user-1',
      email: 'user@acme.com',
      name: 'User',
      role: 'user',
      tenantId: 'tenant-1',
      licenseId: 'FREE',
      password: 'x',
      servicePermissions: { tools: 'none' },
    });
    db.listGroupMembersByUser.mockResolvedValue([]);
    app = await createFastifyApiTestApp(toolsLikePlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('denies the plain path for a user without the tools permission', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tools', headers });
    expect(res.statusCode).toBe(403);
  });

  it('denies the percent-encoded spelling too (it reaches the same handler)', async () => {
    for (const url of ['/api/to%6Fls', '/api/%74ools', '/api/tool%73']) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(403);
    }
  });
});
