/**
 * Minting an API token in the name of a disabled user is refused (400) on both
 * mint-for-user surfaces, while enabled and status-less users still work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
    invalidateApiTokenAuthCache: vi.fn(),
    apiAuthCacheKey: vi.fn(),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn().mockResolvedValue({ projectId: 'proj-1' }),
  };
});
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientUsersApiPlugin } from '@/server/api/plugins/client-users';
import { tokensApiPlugin } from '@/server/api/plugins/tokens';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
const OWNER = { _id: 'owner-1', role: 'owner', tenantId: TENANT, email: 'o@x.com' };
const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': OWNER,
  'svc-off': { _id: 'svc-off', role: 'user', tenantId: TENANT, canLogin: false, status: 'disabled' },
  'svc-on': { _id: 'svc-on', role: 'user', tenantId: TENANT, canLogin: false, status: 'active' },
  'svc-legacy': { _id: 'svc-legacy', role: 'user', tenantId: TENANT, canLogin: false },
};

describe('POST /api/tokens for another user', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] as never) ?? null);
    db.listProjectApiTokens.mockResolvedValue([]);
    db.createApiToken.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'tok-new', ...input }) as never);
    app = await createFastifyApiTestApp(tokensApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const mint = (userId: string) => app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: {
      'content-type': 'application/json',
      'x-license-type': 'STARTER',
      'x-tenant-db-name': 'tenant_acme',
      'x-tenant-id': TENANT,
      'x-tenant-slug': 'acme',
      'x-user-id': 'owner-1',
      'x-user-role': 'owner',
    },
    payload: JSON.stringify({ label: 'ci token', userId }),
  });

  it('refuses a disabled target with 400 "User is disabled" and creates nothing', async () => {
    const res = await mint('svc-off');
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('User is disabled');
    expect(db.createApiToken).not.toHaveBeenCalled();
  });

  it('still mints for active and status-less targets', async () => {
    expect((await mint('svc-on')).statusCode).toBe(201);
    expect((await mint('svc-legacy')).statusCode).toBe(201);
    expect(db.createApiToken).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/client/v1/users/:id/tokens', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] as never) ?? null);
    db.listProjectApiTokens.mockResolvedValue([]);
    db.createApiToken.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'tok-new', ...input }) as never);
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: 'proj-1',
      tenant: { _id: TENANT, dbName: 'tenant_acme', licenseType: 'STARTER', slug: 'acme' },
      tenantDbName: 'tenant_acme',
      tenantId: TENANT,
      tenantSlug: 'acme',
      token: 'tok_test',
      tokenRecord: { _id: 'token-1', servicePermissions: null, userId: OWNER._id },
      user: OWNER,
    });
    app = await createFastifyApiTestApp(clientUsersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const mint = (userId: string) => app.inject({
    method: 'POST',
    url: `/api/client/v1/users/${userId}/tokens`,
    headers: { authorization: 'Bearer tok_test', 'content-type': 'application/json' },
    payload: JSON.stringify({ label: 'ci token' }),
  });

  it('refuses a disabled target with 400 "User is disabled"', async () => {
    const res = await mint('svc-off');
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('User is disabled');
    expect(db.createApiToken).not.toHaveBeenCalled();
  });

  it('still mints for an active target', async () => {
    expect((await mint('svc-on')).statusCode).toBe(201);
  });
});
