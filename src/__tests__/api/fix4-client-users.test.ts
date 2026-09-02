/**
 * Programmatic-user provisioning over the token API.
 *
 * The profile written by POST /client/v1/users is the ceiling every later
 * unscoped mint for that user resolves against, so it must not exceed what the
 * creating token was ever allowed itself; and the mint route next to it must
 * never issue a token that authorises as someone more privileged than the
 * caller (the owner, for an admin-owned token).
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
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$hash'),
  compare: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientUsersApiPlugin } from '@/server/api/plugins/client-users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';

const OWNER = { _id: 'owner-1', role: 'owner', tenantId: TENANT };
const ADMIN = { _id: 'admin-1', role: 'admin', tenantId: TENANT };
const REGULAR = { _id: 'user-1', role: 'user', tenantId: TENANT, canLogin: true };

function authContext(user: Record<string, unknown>, tokenScope: Record<string, string> | null) {
  return {
    token: 'tok_abc',
    tokenRecord: { _id: 'tok-1', userId: String(user._id), servicePermissions: tokenScope },
    tenant: { licenseType: 'STARTER' },
    tenantId: TENANT,
    tenantSlug: 'acme',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user,
  };
}

describe('client users API', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listUsers.mockResolvedValue([]);
    db.findUserByEmail.mockResolvedValue(null);
    db.listProjectApiTokens.mockResolvedValue([]);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'new-user', ...input }) as never);
    db.createApiToken.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'tok-new', ...input }) as never);
    db.findUserById.mockImplementation(async (id: string) => (
      ({ 'owner-1': OWNER, 'admin-1': ADMIN, 'user-1': REGULAR } as Record<string, unknown>)[id] as never
    ) ?? null);
    app = await createFastifyApiTestApp(clientUsersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const as = (ctx: ReturnType<typeof authContext>) =>
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(ctx);

  const createUser = (body: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/client/v1/users',
    headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Svc Bot', ...body }),
  });

  const mint = (targetId: string, body: Record<string, unknown> = {}) => app.inject({
    method: 'POST',
    url: `/api/client/v1/users/${targetId}/tokens`,
    headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
    payload: JSON.stringify({ label: 'svc-token', ...body }),
  });

  describe('POST /client/v1/users', () => {
    it('clamps requested servicePermissions to the calling token\'s scope', async () => {
      as(authContext(ADMIN, { members: 'admin', models: 'read' }));
      const res = await createUser({ servicePermissions: { audit: 'admin', models: 'admin', members: 'admin' } });
      expect(res.statusCode).toBe(201);
      const stored = (db.createUser.mock.calls[0][0] as { servicePermissions: Record<string, string> }).servicePermissions;
      expect(stored).toEqual({ audit: 'none', models: 'read', members: 'admin' });
      const body = parseJsonBody<{ user: { canLogin: boolean; servicePermissions: Record<string, string> } }>(res.body);
      expect(body.user.canLogin).toBe(false);
      expect(body.user.servicePermissions.audit).toBe('none');
    });

    it('rejects role admin from a scoped token, accepts it from an unscoped admin token', async () => {
      as(authContext(ADMIN, { members: 'admin' }));
      expect((await createUser({ role: 'admin' })).statusCode).toBe(403);
      expect(db.createUser).not.toHaveBeenCalled();

      as(authContext(ADMIN, null));
      expect((await createUser({ role: 'admin' })).statusCode).toBe(201);
    });
  });

  describe('POST /client/v1/users/:id/tokens', () => {
    it('refuses an admin-owned token minting in the owner\'s name', async () => {
      as(authContext(ADMIN, null));
      expect((await mint('owner-1')).statusCode).toBe(403);
      as(authContext(ADMIN, { members: 'admin' }));
      expect((await mint('owner-1')).statusCode).toBe(403);
      expect(db.createApiToken).not.toHaveBeenCalled();
    });

    it('pins the scope to min(target, caller) when an unscoped admin token mints for a user', async () => {
      as(authContext(ADMIN, null));
      const res = await mint('user-1');
      expect(res.statusCode).toBe(201);
      const scope = parseJsonBody<{ servicePermissions: Record<string, string> | null }>(res.body).servicePermissions;
      expect(scope).not.toBeNull();
      expect(scope?.models).toBe('write');   // a `user` is write, not admin
      expect(scope?.members).toBe('none');   // admin-only service
    });

    it('carries the caller token\'s own scope onto the minted token', async () => {
      as(authContext(ADMIN, { members: 'admin', models: 'read' }));
      const res = await mint('user-1');
      expect(res.statusCode).toBe(201);
      const scope = parseJsonBody<{ servicePermissions: Record<string, string> | null }>(res.body).servicePermissions;
      expect(scope?.models).toBe('read');    // caller cap below the target's write
      expect(scope?.audit).toBe('none');     // absent from the caller scope
    });

    it('leaves an unscoped owner token\'s minting unchanged', async () => {
      as(authContext(OWNER, null));
      const res = await mint('user-1');
      expect(res.statusCode).toBe(201);
      expect(parseJsonBody<{ servicePermissions: unknown }>(res.body).servicePermissions).toBeNull();
    });
  });
});
