/**
 * Session surface of the user lifecycle: POST /users/:id/disable|enable,
 * the new serializer fields, delete-time token revocation, the invitation-link
 * refusal for disabled users, and member-candidate filtering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({ db: null as unknown, cacheDel: vi.fn(), recordAuditLog: vi.fn() }));

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

import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';

function headers(userId: string, role: string) {
  return {
    'content-type': 'application/json',
    'x-license-type': 'STARTER',
    'x-tenant-db-name': 'tenant_acme',
    'x-tenant-id': TENANT,
    'x-tenant-slug': 'acme',
    'x-user-email': `${userId}@acme.test`,
    'x-user-id': userId,
    'x-user-role': role,
  };
}
const ADMIN = headers('admin-1', 'admin');
const OWNER_H = headers('owner-1', 'owner');
// Fastify rejects a JSON content-type with an empty body, so bodiless requests drop it.
const bare = (h: Record<string, string>) => {
  const { 'content-type': _ct, ...rest } = h;
  void _ct;
  return rest;
};

const USERS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, email: 'owner@acme.test', name: 'Owner' },
  'owner-2': { _id: 'owner-2', role: 'owner', tenantId: TENANT, email: 'o2@acme.test', name: 'Owner 2' },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT, email: 'admin@acme.test', name: 'Admin' },
  'member-1': { _id: 'member-1', role: 'user', tenantId: TENANT, email: 'm@acme.test', name: 'Member' },
  'legacy-1': { _id: 'legacy-1', role: 'user', tenantId: TENANT, email: 'l@acme.test', name: 'Legacy' },
  'off-1': {
    _id: 'off-1', role: 'user', tenantId: TENANT, email: 'off@acme.test', name: 'Off',
    status: 'disabled', disabledAt: new Date('2026-10-01T00:00:00Z'), disabledBy: 'admin-1', disabledReason: 'left',
    invitedBy: 'owner-1',
  },
  'foreign-1': { _id: 'foreign-1', role: 'user', tenantId: 'other', email: 'f@x.test', name: 'Foreign' },
};

type UserReply = { user: Record<string, unknown> };

describe('user lifecycle routes (/api/users)', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    h.db = db;
    h.recordAuditLog.mockResolvedValue(undefined);
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] ? { ...USERS[id] } : null) as never);
    db.updateUser.mockImplementation(async (id: string, patch: object) => ({ ...USERS[id], ...patch }) as never);
    app = await createFastifyApiTestApp(usersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string, hdrs: Record<string, string>, body: unknown = {}) =>
    app.inject({ method: 'POST', url: `/api${path}`, headers: hdrs, payload: JSON.stringify(body) });

  describe('POST /users/:id/disable', () => {
    it('403s a non-admin', async () => {
      const res = await post('/users/member-1/disable', headers('member-1', 'user'));
      expect(res.statusCode).toBe(403);
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('400s disabling yourself', async () => {
      const res = await post('/users/admin-1/disable', ADMIN);
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe('You cannot change the status of your own account');
    });

    it('403s targeting an owner, even for an admin or another owner', async () => {
      const res = await post('/users/owner-1/disable', ADMIN);
      expect(res.statusCode).toBe(403);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Owner accounts cannot be disabled');
      const res2 = await post('/users/owner-1/enable', headers('owner-2', 'owner'));
      expect(res2.statusCode).toBe(403);
    });

    it('404s an unknown user and a user of another tenant', async () => {
      expect((await post('/users/nobody/disable', ADMIN)).statusCode).toBe(404);
      expect((await post('/users/foreign-1/disable', ADMIN)).statusCode).toBe(404);
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('disables, returns the serialized user with lifecycle fields, and audits', async () => {
      const res = await post('/users/member-1/disable', ADMIN, { reason: ' offboarded ' });
      expect(res.statusCode).toBe(200);
      const { user } = parseJsonBody<UserReply>(res.body);
      expect(user).toMatchObject({
        _id: 'member-1',
        status: 'disabled',
        disabledBy: 'admin-1',
        disabledReason: 'offboarded',
      });
      expect(user.disabledAt).toBeTruthy();
      expect(user).not.toHaveProperty('password');

      expect(db.updateUser).toHaveBeenCalledWith('member-1', expect.objectContaining({
        status: 'disabled',
        disabledBy: 'admin-1',
        disabledReason: 'offboarded',
      }));
      expect(h.cacheDel).toHaveBeenCalledWith('user-auth-state:tenant_acme:member-1');
      await vi.waitFor(() => expect(h.recordAuditLog).toHaveBeenCalledTimes(1));
      expect(h.recordAuditLog.mock.calls[0][1]).toMatchObject({
        event: 'user.disable',
        actorUserId: 'admin-1',
        actorType: 'user',
        resourceId: 'member-1',
        metadata: { reason: 'offboarded' },
      });
    });

    it('works without a body', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/users/member-1/disable',
        headers: bare(ADMIN),
      });
      expect(res.statusCode).toBe(200);
      expect(db.updateUser.mock.calls[0][1]).toMatchObject({ status: 'disabled', disabledReason: null });
    });

    it('is idempotent on an already disabled user', async () => {
      const res = await post('/users/off-1/disable', ADMIN, { reason: 'again' });
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<UserReply>(res.body).user.status).toBe('disabled');
      expect(db.updateUser).not.toHaveBeenCalled();
      expect(h.recordAuditLog).not.toHaveBeenCalled();
    });
  });

  describe('POST /users/:id/enable', () => {
    it('403s a non-admin', async () => {
      expect((await post('/users/off-1/enable', headers('member-1', 'user'))).statusCode).toBe(403);
    });

    it('re-enables and clears the lifecycle fields', async () => {
      const res = await post('/users/off-1/enable', OWNER_H);
      expect(res.statusCode).toBe(200);
      expect(db.updateUser).toHaveBeenCalledWith('off-1', {
        status: 'active', disabledAt: null, disabledBy: null, disabledReason: null,
      });
      expect(parseJsonBody<UserReply>(res.body).user).toMatchObject({
        status: 'active', disabledAt: null, disabledBy: null, disabledReason: null,
      });
      await vi.waitFor(() => expect(h.recordAuditLog).toHaveBeenCalledTimes(1));
      expect(h.recordAuditLog.mock.calls[0][1].event).toBe('user.enable');
    });

    it('is idempotent on an already active (legacy, status-less) user', async () => {
      const res = await post('/users/legacy-1/enable', OWNER_H);
      expect(res.statusCode).toBe(200);
      expect(db.updateUser).not.toHaveBeenCalled();
    });
  });

  describe('serializer', () => {
    it('reports status "active" for a legacy row with no status field', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/users/legacy-1', headers: bare(ADMIN) });
      expect(res.statusCode).toBe(200);
      expect(parseJsonBody<UserReply>(res.body).user).toMatchObject({
        status: 'active', disabledAt: null, disabledBy: null, disabledReason: null,
      });
    });

    it('includes the lifecycle fields in the list response', async () => {
      db.listUsers.mockResolvedValue([USERS['off-1'], USERS['legacy-1']] as never);
      const res = await app.inject({ method: 'GET', url: '/api/users', headers: bare(ADMIN) });
      const { users } = parseJsonBody<{ users: Array<Record<string, unknown>> }>(res.body);
      expect(users.find((u) => u._id === 'off-1')).toMatchObject({ status: 'disabled', disabledReason: 'left' });
      expect(users.find((u) => u._id === 'legacy-1')).toMatchObject({ status: 'active' });
    });
  });

  describe('DELETE /users/:id', () => {
    it('revokes the deleted user\'s tokens and evicts their caches', async () => {
      db.deleteUser.mockResolvedValue(true);
      db.listApiTokens.mockResolvedValue([
        { _id: 'tok-1', userId: 'member-1', tokenHash: 'a'.repeat(64) },
        { _id: 'tok-2', userId: 'member-1', tokenHash: 'b'.repeat(64) },
      ] as never);
      db.deleteApiToken.mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/users/member-1', headers: bare(ADMIN) });
      expect(res.statusCode).toBe(200);
      expect(db.listApiTokens).toHaveBeenCalledWith('member-1');
      expect(db.deleteApiToken).toHaveBeenCalledWith('tok-1', 'member-1');
      expect(db.deleteApiToken).toHaveBeenCalledWith('tok-2', 'member-1');
      expect(h.cacheDel).toHaveBeenCalledWith(`api-auth:${'a'.repeat(16)}`);
      expect(h.cacheDel).toHaveBeenCalledWith(`api-auth:${'b'.repeat(16)}`);
      expect(h.cacheDel).toHaveBeenCalledWith('user-auth-state:tenant_acme:member-1');
    });

    it('still succeeds when token cleanup fails', async () => {
      db.deleteUser.mockResolvedValue(true);
      db.listApiTokens.mockRejectedValue(new Error('db down'));
      const res = await app.inject({ method: 'DELETE', url: '/api/users/member-1', headers: bare(ADMIN) });
      expect(res.statusCode).toBe(200);
    });

    it('does not touch tokens when the delete itself fails', async () => {
      db.deleteUser.mockResolvedValue(false);
      const res = await app.inject({ method: 'DELETE', url: '/api/users/member-1', headers: bare(ADMIN) });
      expect(res.statusCode).toBe(500);
      expect(db.listApiTokens).not.toHaveBeenCalled();
    });
  });

  describe('POST /users/:id/invitation-link', () => {
    it('refuses a disabled user like a canLogin=false one', async () => {
      db.findTenantById.mockResolvedValue({ _id: TENANT, slug: 'acme' } as never);
      const res = await app.inject({ method: 'POST', url: '/api/users/off-1/invitation-link', headers: bare(ADMIN) });
      expect(res.statusCode).toBe(404);
      expect(parseJsonBody<{ error: string }>(res.body).error).toBe('Pending invitation not found');
    });
  });
});

describe('GET /projects/:projectId/member-candidates', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    h.db = db;
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] ? { ...USERS[id] } : null) as never);
    db.findProjectById.mockResolvedValue({ _id: 'proj-1', tenantId: TENANT } as never);
    db.listUserProjectsByProject.mockResolvedValue([]);
    db.listUsers.mockResolvedValue([
      { _id: 'u-a', role: 'user', email: 'alice@acme.test', name: 'Alice', projectIds: [] },
      { _id: 'u-b', role: 'user', email: 'alina@acme.test', name: 'Alina', projectIds: [], status: 'disabled' },
      { _id: 'u-c', role: 'user', email: 'alan@acme.test', name: 'Alan', projectIds: [], status: 'active' },
    ] as never);
    app = await createFastifyApiTestApp(projectsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('never offers a disabled user, keeps active and status-less ones', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/projects/proj-1/member-candidates?q=al', headers: bare(OWNER_H),
    });
    expect(res.statusCode).toBe(200);
    const ids = parseJsonBody<{ users: Array<{ _id: string }> }>(res.body).users.map((u) => u._id);
    expect(ids.sort()).toEqual(['u-a', 'u-c']);
  });
});
