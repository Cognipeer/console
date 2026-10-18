/**
 * Status mapping of DELETE project member on the two live surfaces (dashboard
 * plugin and client API). What removal clears is covered against real
 * databases in integration/token-project-access.test.ts; this pins the
 * answers: 200 when something was removed, 404 when the user was never a
 * member, 500 when the membership could not be fully cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  // The request gate reads the caller through a tenant-scoped handle.
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientProjectsApiPlugin } from '@/server/api/plugins/client-projects';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
const PROJECT = 'proj-1';

const OWNER = { _id: 'owner-1', role: 'owner', tenantId: TENANT };
const MEMBER = { _id: 'user-1', role: 'user', tenantId: TENANT, canLogin: true, projectIds: [PROJECT] };

const sessionHeaders = {
  'content-type': 'application/json',
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': TENANT,
  'x-tenant-slug': 'acme',
  'x-user-id': 'owner-1',
  'x-user-role': 'owner',
};

const surfaces = [
  {
    label: 'dashboard',
    plugin: projectsApiPlugin,
    removeWithoutBody: (app: Awaited<ReturnType<typeof createFastifyApiTestApp>>) => app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT}/members`,
      headers: { ...sessionHeaders, 'content-type': 'application/json' },
    }),
    remove: (app: Awaited<ReturnType<typeof createFastifyApiTestApp>>, userId: string) => app.inject({
      method: 'DELETE',
      url: `/api/projects/${PROJECT}/members`,
      headers: sessionHeaders,
      payload: JSON.stringify({ userId }),
    }),
  },
  {
    label: 'client API',
    plugin: clientProjectsApiPlugin,
    removeWithoutBody: (app: Awaited<ReturnType<typeof createFastifyApiTestApp>>) => app.inject({
      method: 'DELETE',
      url: `/api/client/v1/projects/${PROJECT}/members`,
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
    }),
    remove: (app: Awaited<ReturnType<typeof createFastifyApiTestApp>>, userId: string) => app.inject({
      method: 'DELETE',
      url: `/api/client/v1/projects/${PROJECT}/members`,
      headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
      payload: JSON.stringify({ userId }),
    }),
  },
];

describe.each(surfaces)('DELETE project member: $label', ({ plugin, remove, removeWithoutBody }) => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findProjectById.mockResolvedValue({ _id: PROJECT, tenantId: TENANT, key: 'alpha' } as never);
    db.findUserById.mockImplementation(async (id: string) => (
      ({ 'owner-1': OWNER, 'user-1': MEMBER } as Record<string, unknown>)[id] as never
    ) ?? null);
    db.deleteUserProject.mockResolvedValue(false);
    db.updateUser.mockImplementation(async (id: string, patch: object) => ({ _id: id, ...patch }) as never);
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: 'tok_abc',
      tokenRecord: { _id: 'tok-1', userId: 'owner-1', servicePermissions: null },
      tenant: { licenseType: 'ENTERPRISE' },
      tenantId: TENANT,
      tenantSlug: 'acme',
      tenantDbName: 'tenant_acme',
      projectId: PROJECT,
      user: OWNER,
    });
    app = await createFastifyApiTestApp(plugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('clears the membership row and the legacy entry in one request', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    const res = await remove(app, 'user-1');
    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<{ success: boolean }>(res.body).success).toBe(true);
    expect(db.deleteUserProject).toHaveBeenCalledWith('user-1', PROJECT);
    expect(db.updateUser).toHaveBeenCalledWith('user-1', { projectIds: [] });
  });

  it('answers 404 when the user was never a member', async () => {
    db.findUserById.mockImplementation(async (id: string) => (
      id === 'user-1' ? ({ ...MEMBER, projectIds: [] } as never) : (OWNER as never)
    ));
    const res = await remove(app, 'user-1');
    expect(res.statusCode).toBe(404);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Membership not found');
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('answers 500 when the legacy entry could not be cleared', async () => {
    db.deleteUserProject.mockResolvedValue(true);
    db.updateUser.mockResolvedValue(null);
    const res = await remove(app, 'user-1');
    expect(res.statusCode).toBe(500);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Failed to update membership');
  });

  it('answers 400 (not a 500 with an error log) when the JSON content type comes with no body', async () => {
    // The production JSON parser hands an empty body to the handler as ''; the default test parser would refuse it first.
    const rawApp = await createFastifyApiTestApp(plugin, { rawJsonBody: true });
    try {
      const res = await removeWithoutBody(rawApp);
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Request body must be valid JSON');
    } finally {
      await rawApp.close();
    }
  });
});
