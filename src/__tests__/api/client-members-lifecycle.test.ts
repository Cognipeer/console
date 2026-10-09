/**
 * Token-authenticated mirror of the user lifecycle:
 * POST /client/v1/members/:id/disable|enable, serializer fields, and delete cleanup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({ db: null as unknown, cacheDel: vi.fn(), recordAuditLog: vi.fn() }));

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
    invalidateApiTokenAuthCache: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), del: h.cacheDel })),
}));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: h.recordAuditLog }));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));

import { invalidateApiTokenAuthCache, requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientMembersApiPlugin } from '@/server/api/plugins/client-members';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = { _id: 'tenant-1', companyName: 'Acme', dbName: 'tenant_acme', licenseType: 'STARTER', slug: 'acme' };
const ADMIN = { _id: 'admin-1', email: 'admin@acme.com', role: 'admin', tenantId: 'tenant-1' };
const MEMBER = { _id: 'member-1', email: 'm@acme.com', role: 'user', tenantId: 'tenant-1' };

const USERS: Record<string, Record<string, unknown>> = {
  'admin-1': ADMIN,
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: 'tenant-1', email: 'o@acme.com' },
  'member-1': MEMBER,
  'off-1': { _id: 'off-1', role: 'user', tenantId: 'tenant-1', status: 'disabled', disabledBy: 'admin-1', disabledReason: 'left' },
  'foreign-1': { _id: 'foreign-1', role: 'user', tenantId: 'other' },
};

function authAs(user: Record<string, unknown>) {
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue({
    projectId: 'proj-1',
    tenant: TENANT,
    tenantDbName: TENANT.dbName,
    tenantId: TENANT._id,
    tenantSlug: TENANT.slug,
    token: 'tok_test',
    tokenRecord: { _id: 'token-7', servicePermissions: null, userId: user._id },
    user,
  });
}

describe('client members lifecycle', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    h.db = db;
    h.recordAuditLog.mockResolvedValue(undefined);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] ? { ...USERS[id] } : null) as never);
    db.updateUser.mockImplementation(async (id: string, patch: object) => ({ ...USERS[id], ...patch }) as never);
    authAs(ADMIN);
    app = await createFastifyApiTestApp(clientMembersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/client/v1/members${path}`,
      headers: { authorization: 'Bearer tok_test', 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  it('403s a non-admin token owner', async () => {
    authAs(MEMBER);
    expect((await post('/off-1/enable')).statusCode).toBe(403);
    expect((await post('/member-1/disable')).statusCode).toBe(403);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('400s a token disabling its own owner account', async () => {
    const res = await post('/admin-1/disable');
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('You cannot change the status of your own account');
  });

  it('403s an owner target and 404s unknown / cross-tenant targets', async () => {
    expect((await post('/owner-1/disable')).statusCode).toBe(403);
    expect((await post('/nobody/disable')).statusCode).toBe(404);
    expect((await post('/foreign-1/disable')).statusCode).toBe(404);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('disables with a reason, returns the new serializer fields, audits as an api_token actor', async () => {
    const res = await post('/member-1/disable', { reason: 'rotated out' });
    expect(res.statusCode).toBe(200);
    const { user } = parseJsonBody<{ user: Record<string, unknown> }>(res.body);
    expect(user).toMatchObject({ _id: 'member-1', status: 'disabled', disabledBy: 'admin-1', disabledReason: 'rotated out' });
    expect(user.disabledAt).toBeTruthy();
    await vi.waitFor(() => expect(h.recordAuditLog).toHaveBeenCalledTimes(1));
    expect(h.recordAuditLog.mock.calls[0][1]).toMatchObject({
      event: 'user.disable',
      actorType: 'api_token',
      actorUserId: 'admin-1',
      apiTokenId: 'token-7',
      resourceId: 'member-1',
    });
  });

  it('enables a disabled user and clears the fields', async () => {
    const res = await post('/off-1/enable');
    expect(res.statusCode).toBe(200);
    expect(db.updateUser).toHaveBeenCalledWith('off-1', {
      status: 'active', disabledAt: null, disabledBy: null, disabledReason: null,
    });
    expect(parseJsonBody<{ user: Record<string, unknown> }>(res.body).user).toMatchObject({ status: 'active', disabledReason: null });
  });

  it('lists legacy rows as active', async () => {
    db.listUsers.mockResolvedValue([MEMBER, USERS['off-1']] as never);
    const res = await app.inject({
      method: 'GET', url: '/api/client/v1/members', headers: { authorization: 'Bearer tok_test' },
    });
    const { users } = parseJsonBody<{ users: Array<Record<string, unknown>> }>(res.body);
    expect(users.find((u) => u._id === 'member-1')).toMatchObject({ status: 'active', disabledAt: null });
    expect(users.find((u) => u._id === 'off-1')).toMatchObject({ status: 'disabled', disabledReason: 'left' });
  });

  it('DELETE revokes the user\'s tokens and evicts their caches', async () => {
    db.deleteUser.mockResolvedValue(true);
    db.listApiTokens.mockResolvedValue([{ _id: 'tok-1', userId: 'member-1', tokenHash: 'c'.repeat(64) }] as never);
    db.deleteApiToken.mockResolvedValue(true);
    const res = await app.inject({
      method: 'DELETE', url: '/api/client/v1/members/member-1', headers: { authorization: 'Bearer tok_test' },
    });
    expect(res.statusCode).toBe(200);
    expect(db.deleteApiToken).toHaveBeenCalledWith('tok-1', 'member-1');
    expect(invalidateApiTokenAuthCache).toHaveBeenCalledWith('c'.repeat(64));
    expect(h.cacheDel).toHaveBeenCalledWith('user-auth-state:tenant_acme:member-1');
  });
});
