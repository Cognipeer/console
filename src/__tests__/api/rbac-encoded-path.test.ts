import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

// The real policy engine decides on a real SQLite tenant (as in iam-enforce-gate.test.ts).
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { getEnterpriseModuleForPath } from '@/lib/license/enterprise-access';
import { getPermissionServiceForPath } from '@/lib/security/rbac';
import { canonicalizeRequestPathname } from '@/lib/security/requestPath';
import { withApiRequestContext } from '@/server/api/fastify-utils';
import { createFastifyApiTestApp } from '../helpers/fastify-api';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

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
  let env: IamTestDb;
  let headers: Record<string, string>;

  beforeAll(async () => {
    env = await createIamTestDb('tenant_rbac_encoded');
    hoisted.getDatabase.mockImplementation(async () => env.db);
    const user = await env.db.createUser({
      tenantId: env.tenantId, email: 'user@acme.com', name: 'User', password: '$2b$10$x', role: 'user',
      licenseId: 'FREE', features: [], servicePermissions: { tools: 'none' },
    });
    headers = {
      'x-license-type': 'FREE',
      'x-tenant-db-name': env.tenantDbName,
      'x-tenant-id': env.tenantId,
      'x-tenant-slug': 'acme',
      'x-user-id': String(user._id),
      'x-user-role': 'user',
      'x-user-email': 'user@acme.com',
    };
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    app = await createFastifyApiTestApp(toolsLikePlugin);
    await app.ready();
    // rows must be older than the workspace's first decision
    await new Promise((resolve) => setTimeout(resolve, 15));
  });

  afterAll(async () => {
    await app.close();
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    await env.cleanup();
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
