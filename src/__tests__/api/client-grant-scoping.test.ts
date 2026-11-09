/**
 * Client admin surface: what a call may hand out stays within its own credential,
 * tenant-wide provider scope follows the caller's role, and the project list
 * shows only projects the caller can open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    constructor(message: string, readonly status = 401) { super(message); }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/services/users/peopleAudit', () => ({ recordPeopleAudit: vi.fn() }));
vi.mock('@/lib/services/users/userAuthState', () => ({
  invalidateUserAuthState: vi.fn().mockResolvedValue(undefined),
  isUserDisabled: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: vi.fn().mockResolvedValue({ _id: 'prov-new' }),
  deleteProviderConfig: vi.fn().mockResolvedValue(true),
  getProviderConfigById: vi.fn(),
  listProviderConfigs: vi.fn().mockResolvedValue([]),
  updateProviderConfig: vi.fn().mockResolvedValue({ _id: 'prov-1' }),
}));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$hash'),
  compare: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { listProviderConfigs, getProviderConfigById, updateProviderConfig } from '@/lib/services/providers/providerService';
import { clientMembersApiPlugin } from '@/server/api/plugins/client-members';
import { clientProjectsApiPlugin } from '@/server/api/plugins/client-projects';
import { clientProvidersApiPlugin } from '@/server/api/plugins/client-providers';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = { _id: 'tenant-1', companyName: 'Acme', dbName: 'tenant_acme', licenseType: 'STARTER', slug: 'acme' };
const OWNER = { _id: 'owner-1', email: 'o@acme.com', role: 'owner', tenantId: 'tenant-1' };
const ADMIN = { _id: 'admin-1', email: 'a@acme.com', role: 'admin', tenantId: 'tenant-1' };
const MEMBER = { _id: 'member-1', email: 'm@acme.com', role: 'user', tenantId: 'tenant-1', projectIds: ['p1'], servicePermissions: { providers: 'admin' } };

function authFor(user: Record<string, unknown>, servicePermissions: unknown = null) {
  return {
    projectId: 'p1',
    tenant: TENANT,
    tenantDbName: TENANT.dbName,
    tenantId: TENANT._id,
    tenantSlug: TENANT.slug,
    token: 'tok_test',
    tokenRecord: { _id: 'token-1', servicePermissions, userId: user._id },
    user,
  };
}
const headers = { authorization: 'Bearer tok_test', 'content-type': 'application/json' };

describe('client admin surface grant scoping', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  async function boot(plugin: Parameters<typeof createFastifyApiTestApp>[0], auth: unknown) {
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(auth);
    app = await createFastifyApiTestApp(plugin);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantById.mockResolvedValue(TENANT as never);
    db.findUserByEmail.mockResolvedValue(null);
    db.listProjects.mockResolvedValue([
      { _id: 'p1', tenantId: 'tenant-1', name: 'One' },
      { _id: 'p2', tenantId: 'tenant-1', name: 'Two' },
    ] as never);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'new-user', ...input }) as never);
  });
  afterEach(async () => { await app.close(); });

  describe('providers', () => {
    it('refuses tenant-wide scope for a non-admin caller', async () => {
      await boot(clientProvidersApiPlugin, authFor(MEMBER));
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/providers?scope=tenant', headers });
      expect(res.statusCode).toBe(403);
      expect(listProviderConfigs).not.toHaveBeenCalled();
    });

    it('refuses tenant-wide update and keeps project-scoped reads for a non-admin caller', async () => {
      await boot(clientProvidersApiPlugin, authFor(MEMBER));
      const patch = await app.inject({
        method: 'PATCH', url: '/api/client/v1/providers/prov-1?scope=tenant', headers,
        payload: JSON.stringify({ label: 'x' }),
      });
      expect(patch.statusCode).toBe(403);
      expect(updateProviderConfig).not.toHaveBeenCalled();
      const list = await app.inject({ method: 'GET', url: '/api/client/v1/providers', headers });
      expect(list.statusCode).toBe(200);
    });

    it('does not let a non-admin caller reassign projects', async () => {
      await boot(clientProvidersApiPlugin, authFor(MEMBER));
      (getProviderConfigById as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: 'prov-1', tenantId: 'tenant-1', projectId: 'p1' });
      await app.inject({
        method: 'PATCH', url: '/api/client/v1/providers/prov-1', headers,
        payload: JSON.stringify({ label: 'x', projectIds: ['p2'] }),
      });
      const payload = (updateProviderConfig as ReturnType<typeof vi.fn>).mock.calls[0][2] as Record<string, unknown>;
      expect(payload.projectIds).toBeUndefined();
    });

    it('allows tenant-wide scope for an admin caller', async () => {
      await boot(clientProvidersApiPlugin, authFor(ADMIN));
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/providers?scope=tenant', headers });
      expect(res.statusCode).toBe(200);
      expect(listProviderConfigs).toHaveBeenCalled();
    });
  });

  describe('members', () => {
    const invite = (role: string, extra: Record<string, unknown> = {}) => ({
      method: 'POST' as const,
      url: '/api/client/v1/members/invite',
      headers,
      payload: JSON.stringify({ email: 'new@acme.com', name: 'New', role, ...extra }),
    });

    it('refuses the admin role for a scoped token', async () => {
      await boot(clientMembersApiPlugin, authFor(ADMIN, { members: 'admin' }));
      const res = await app.inject(invite('admin'));
      expect(res.statusCode).toBe(403);
      expect(db.createUser).not.toHaveBeenCalled();
    });

    it('returns the sign-in link only to an unscoped credential', async () => {
      await boot(clientMembersApiPlugin, authFor(ADMIN, { members: 'admin' }));
      const scoped = await app.inject(invite('user'));
      expect(scoped.statusCode).toBe(201);
      expect(parseJsonBody<Record<string, unknown>>(scoped.body).invitationUrl).toBeUndefined();
      await app.close();

      await boot(clientMembersApiPlugin, authFor(ADMIN));
      const unscoped = await app.inject(invite('user'));
      expect(parseJsonBody<Record<string, unknown>>(unscoped.body).invitationUrl).toContain('/reset-password');
    });

    it('caps invited permissions at the caller scope and validates the project', async () => {
      await boot(clientMembersApiPlugin, authFor(ADMIN, { members: 'admin' }));
      const res = await app.inject(invite('user', { servicePermissions: { members: 'admin', iam: 'admin' } }));
      expect(res.statusCode).toBe(201);
      const created = db.createUser.mock.calls[0][0] as { servicePermissions: Record<string, string> };
      expect(created.servicePermissions.members).toBe('admin');
      expect(created.servicePermissions.iam).toBe('none');
      const bad = await app.inject(invite('user', { projectId: 'other-tenant-project' }));
      expect(bad.statusCode).toBe(400);
    });

    it('refuses changing own permissions and an admin peer', async () => {
      await boot(clientMembersApiPlugin, authFor(ADMIN));
      db.findUserById.mockImplementation(async (id: string) => (id === 'admin-1' ? ADMIN : { ...ADMIN, _id: 'admin-2' }) as never);
      for (const id of ['admin-1', 'admin-2']) {
        const res = await app.inject({
          method: 'PATCH', url: `/api/client/v1/members/${id}/permissions`, headers,
          payload: JSON.stringify({ servicePermissions: { iam: 'admin' } }),
        });
        expect(res.statusCode).toBe(403);
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('refuses an admin-role group for a scoped token and caps group permissions', async () => {
      await boot(clientMembersApiPlugin, authFor(ADMIN, { members: 'admin' }));
      const denied = await app.inject({
        method: 'POST', url: '/api/client/v1/members/groups', headers,
        payload: JSON.stringify({ name: 'ops', tenantRole: 'admin' }),
      });
      expect(denied.statusCode).toBe(403);
      db.createGroup.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'g1', ...input }) as never);
      const ok = await app.inject({
        method: 'POST', url: '/api/client/v1/members/groups', headers,
        payload: JSON.stringify({ name: 'ops', servicePermissions: { iam: 'admin' } }),
      });
      expect(ok.statusCode).toBe(201);
      expect((db.createGroup.mock.calls[0][0] as { servicePermissions: Record<string, string> }).servicePermissions.iam).toBe('none');
    });
  });

  describe('projects', () => {
    it('lists only accessible projects for a non-admin caller', async () => {
      db.listUserProjectsByUser.mockResolvedValue([] as never);
      db.listGroupMembersByUser.mockResolvedValue([] as never);
      await boot(clientProjectsApiPlugin, authFor(MEMBER));
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/projects', headers });
      const ids = parseJsonBody<{ projects: Array<{ _id: string }> }>(res.body).projects.map((p) => p._id);
      expect(ids).toEqual(['p1']);
    });

    it('lists every project for an owner', async () => {
      await boot(clientProjectsApiPlugin, authFor(OWNER));
      const res = await app.inject({ method: 'GET', url: '/api/client/v1/projects', headers });
      expect(parseJsonBody<{ projects: unknown[] }>(res.body).projects).toHaveLength(2);
    });
  });
});
