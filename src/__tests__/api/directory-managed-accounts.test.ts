/**
 * Accounts and groups that come from a directory, through the REAL plugins, gate and
 * engine on BOTH backends:
 *
 *  - while a connection syncs roles, the role of its accounts is the directory's: the people
 *    directory reports it (`roleManaged`, `managed.roleFromDirectory`, `changeRole` denied with
 *    `directory_managed`) and `PATCH /api/users/:id` refuses a change with 409 `directory_managed`;
 *    nothing else about the account is locked, and the owner stays the owner;
 *  - the members of a group of a directory (LDAP or single sign-on) are the directory's: adding or
 *    removing one is refused with 409, the drawer flags say so with the source, while the group's
 *    grants, projects and policies stay editable.
 *
 * What decides "this connection syncs roles" lives in the enterprise overlay; here it is the
 * registered `@/enterprise/directory-role-sync` resolver, exactly as the overlay registers it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
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

import type { FastifyInstance } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { registerDirectoryRoleSyncResolver } from '@/enterprise/directory-role-sync';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { primeProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { enqueueAuditLog } from '@/server/api/plugin';
import { groupsApiPlugin } from '@/server/api/plugins/groups';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

describeForEachProvider('Directory-managed accounts and groups', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let ws: { dbName: string; id: string; users: Record<string, IUser>; groups: Record<string, string>; projectId: string };

  const call = async (method: string, url: string, who: string, body?: unknown) => {
    const actor = ws.users[who]!;
    const headers: Record<string, string> = {
      'x-tenant-db-name': ws.dbName,
      'x-tenant-id': ws.id,
      'x-tenant-slug': 'dirmanaged',
      'x-user-id': String(actor._id),
      'x-user-role': String(actor.role),
      'x-user-email': String(actor.email),
      'x-license-type': 'FREE',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.inject({ method: method as never, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: any = null;
    if (res.body) {
      try { parsed = parseJsonBody<any>(res.body); } catch { parsed = res.body; }
    }
    return { status: res.statusCode, body: parsed };
  };
  const id = (key: string) => String(ws.users[key]!._id);
  const roleInDb = async (key: string) => (await db.runWithTenant!(ws.dbName, () => db.findUserById(id(key))))?.role;
  const membersInDb = async (groupKey: string) =>
    (await db.runWithTenant!(ws.dbName, () => db.listGroupMembers(ws.groups[groupKey]!))).map((m) => String(m.userId)).sort();

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `dirmgd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const tenantRow = await db.createTenant({ companyName: 'Managed', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    ws = { dbName, id: String(tenantRow._id), users: {}, groups: {}, projectId: '' };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, name: string, role: 'owner' | 'admin' | 'project_admin' | 'user', extra: Record<string, unknown> = {}) => {
        ws.users[key] = await db.createUser({
          tenantId: ws.id, email: `${key}@managed.example`, name, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra,
        } as never);
      };
      await mk('owner', 'Olivia Owner', 'owner');
      await mk('admin', 'Adam Admin', 'admin');
      await mk('sso', 'Sam Sso', 'project_admin', { authProvider: 'oidc', externalId: 'sso-1' });
      await mk('ssoOwner', 'Sasha Sso Owner', 'owner', { authProvider: 'oidc', externalId: 'sso-2' });
      await mk('ldap', 'Lena Ldap', 'user', { authProvider: 'ldap', externalId: 'cn=lena' });
      await mk('local', 'Lou Local', 'user');
      await mk('other', 'Otto Other', 'user');

      const local = await db.createGroup({ tenantId: ws.id, name: 'Handmade', createdBy: 't', source: 'local' } as never);
      const sso = await db.createGroup({ tenantId: ws.id, name: 'SSO team', createdBy: 'directory:oidc', source: 'oidc', externalId: 'eng' } as never);
      const ldap = await db.createGroup({ tenantId: ws.id, name: 'LDAP team', createdBy: 'ldap-sync', source: 'ldap', externalId: 'cn=eng' } as never);
      ws.groups = { local: String(local._id), sso: String(sso._id), ldap: String(ldap._id) };
      await db.addGroupMember({ tenantId: ws.id, groupId: ws.groups.sso, userId: id('sso'), role: 'member', source: 'oidc' });
      await db.addGroupMember({ tenantId: ws.id, groupId: ws.groups.ldap, userId: id('ldap'), role: 'member', source: 'ldap' });
      await db.addGroupMember({ tenantId: ws.id, groupId: ws.groups.local, userId: id('sso'), role: 'member', source: 'local' });
      const project = await db.createProject({ tenantId: ws.id, key: 'pj1', name: 'Project One', createdBy: 'x' });
      ws.projectId = String(project._id);
    });

    app = await createFastifyApiTestApp(async (instance) => {
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      await instance.register(iamApiPlugin);
      await instance.register(usersApiPlugin);
      await instance.register(groupsApiPlugin);
    });
    await app.ready();
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    configureIamEngine({ validateRequests: false });
    primeProjectLevelsForTests(ws.dbName, 0);
  });
  afterAll(async () => {
    await drainPendingTasks();
    await app?.close();
  });
  beforeEach(() => {
    // the overlay answers from the live connection settings; here: the single sign-on syncs roles
    registerDirectoryRoleSyncResolver(async () => ['oidc']);
  });
  afterEach(() => {
    registerDirectoryRoleSyncResolver(null);
  });

  // ── the role of an account whose directory sets it ──────────────────────

  describe('a role that follows the directory', () => {
    it('refuses to change it by hand: 409 directory_managed, and the role stays', async () => {
      const res = await call('PATCH', `/api/users/${id('sso')}`, 'admin', { role: 'admin' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'directory_managed' });
      expect(await roleInDb('sso')).toBe('project_admin');
    });

    it('accepts the role the account already has (nothing is written)', async () => {
      const res = await call('PATCH', `/api/users/${id('sso')}`, 'admin', { role: 'project_admin' });
      expect(res.status).toBe(200);
      expect(res.body.changed).toEqual([]);
    });

    it('does not lock the other accounts: a local one, one of a connection that does not sync, nor the owner\'s own rule', async () => {
      expect((await call('PATCH', `/api/users/${id('local')}`, 'admin', { role: 'project_admin' })).status).toBe(200);
      expect(await roleInDb('local')).toBe('project_admin');
      // LDAP is not in the answer of the resolver: its role is editable
      expect((await call('PATCH', `/api/users/${id('ldap')}`, 'admin', { role: 'project_admin' })).status).toBe(200);
      expect(await roleInDb('ldap')).toBe('project_admin');
      // the owner is the owner whatever the directory is
      const owner = await call('PATCH', `/api/users/${id('ssoOwner')}`, 'admin', { role: 'user' });
      expect(owner.status).toBe(403);
      expect(owner.body).toMatchObject({ code: 'owner_immutable' });
    });

    it('is editable again as soon as the connection stops syncing, and in a build without directories', async () => {
      registerDirectoryRoleSyncResolver(async () => []);
      expect((await call('PATCH', `/api/users/${id('sso')}`, 'admin', { role: 'user' })).status).toBe(200);
      expect(await roleInDb('sso')).toBe('user');
      registerDirectoryRoleSyncResolver(null);
      expect((await call('PATCH', `/api/users/${id('sso')}`, 'admin', { role: 'project_admin' })).status).toBe(200);
      expect(await roleInDb('sso')).toBe('project_admin');
    });

    it('is never locked on a resolver that fails: the lock would be a guess', async () => {
      registerDirectoryRoleSyncResolver(async () => { throw new Error('settings unavailable'); });
      expect((await call('PATCH', `/api/users/${id('sso')}`, 'admin', { role: 'user' })).status).toBe(200);
      registerDirectoryRoleSyncResolver(async () => ['oidc']);
      expect((await call('PATCH', `/api/users/${id('sso')}`, 'admin', { role: 'project_admin' })).status).toBe(409);
    });

    it('is reported by the people directory, row and drawer, so a screen never offers what the server refuses', async () => {
      const list = await call('GET', '/api/iam/principals?type=user&limit=50', 'admin');
      expect(list.status).toBe(200);
      const row = (key: string) => list.body.items.find((item: any) => item.id === id(key));
      expect(row('sso')).toMatchObject({ authProvider: 'oidc', managed: true, roleManaged: true });
      expect(row('sso').allowedActions.changeRole).toEqual({ allowed: false, reason: 'directory_managed' });
      // the rest of the account stays editable by the rules it always had
      expect(row('sso').allowedActions.editPermissions.allowed).toBe(true);
      expect(row('sso').allowedActions.manageGroups.allowed).toBe(true);
      expect(row('ldap')).toMatchObject({ managed: true, roleManaged: false });
      expect(row('ldap').allowedActions.changeRole.allowed).toBe(true);
      expect(row('local')).toMatchObject({ managed: false, roleManaged: false });
      expect(row('ssoOwner')).toMatchObject({ roleManaged: false });
      expect(row('ssoOwner').allowedActions.changeRole).toEqual({ allowed: false, reason: 'owner_immutable' });

      const detail = await call('GET', `/api/iam/principals/user/${id('sso')}`, 'admin');
      expect(detail.status).toBe(200);
      expect(detail.body.principal.managed).toMatchObject({ directory: true, provider: 'oidc', roleFromDirectory: true });
      expect(detail.body.allowedActions.changeRole).toEqual({ allowed: false, reason: 'directory_managed' });
      expect(detail.body.assignableRoles).toEqual([]);

      const ldap = await call('GET', `/api/iam/principals/user/${id('ldap')}`, 'admin');
      expect(ldap.body.principal.managed).toMatchObject({ directory: true, provider: 'ldap', roleFromDirectory: false });
      expect(ldap.body.assignableRoles.length).toBeGreaterThan(0);
    });

    it('asks the connection only when a directory account is on the page', async () => {
      const resolver = vi.fn(async () => ['oidc']);
      registerDirectoryRoleSyncResolver(resolver);
      const local = await call('GET', `/api/iam/principals?type=user&ids=${id('local')},${id('other')}`, 'admin');
      expect(local.status).toBe(200);
      expect(resolver).not.toHaveBeenCalled();
      await call('GET', `/api/iam/principals?type=user&ids=${id('sso')},${id('local')}`, 'admin');
      expect(resolver).toHaveBeenCalledTimes(1);
    });
  });

  // ── the members of a group of a directory ───────────────────────────────

  describe.each([['sso', 'oidc'], ['ldap', 'ldap']] as const)('a group of the %s', (groupKey, source) => {
    it('keeps its members to the directory: adding or removing one is refused with 409, and nothing changes', async () => {
      const before = await membersInDb(groupKey);
      const add = await call('POST', `/api/groups/${ws.groups[groupKey]}/members`, 'admin', { userId: id('other') });
      expect(add.status).toBe(409);
      expect(add.body).toMatchObject({ code: 'group_directory_managed' });
      const member = before[0]!;
      const remove = await call('DELETE', `/api/groups/${ws.groups[groupKey]}/members/${member}`, 'admin');
      expect(remove.status).toBe(409);
      expect(remove.body).toMatchObject({ code: 'group_directory_managed' });
      expect(await membersInDb(groupKey)).toEqual(before);
    });

    it('cannot be renamed or deleted here', async () => {
      expect((await call('PATCH', `/api/groups/${ws.groups[groupKey]}`, 'admin', { name: 'Renamed' })).status).toBe(409);
      expect((await call('DELETE', `/api/groups/${ws.groups[groupKey]}`, 'admin')).status).toBe(409);
    });

    it('keeps its grants, projects and description editable', async () => {
      const patch = await call('PATCH', `/api/groups/${ws.groups[groupKey]}`, 'admin', { description: 'Reviewed', servicePermissions: { agents: 'read' } });
      expect(patch.status).toBe(200);
      expect(patch.body.group).toMatchObject({ source, description: 'Reviewed' });
      const assign = await call('POST', `/api/groups/${ws.groups[groupKey]}/projects`, 'admin', { projectId: ws.projectId, role: 'member' });
      expect([200, 201]).toContain(assign.status);
    });

    it('is flagged read-only with its source in the list, the drawer and the member list', async () => {
      const list = await call('GET', '/api/iam/principals?type=group', 'admin');
      const row = list.body.items.find((item: any) => item.id === ws.groups[groupKey]);
      expect(row).toMatchObject({ source, managed: true });
      expect(row.allowedActions.manageMembers).toEqual({ allowed: false, reason: 'directory_managed' });
      expect(row.allowedActions.delete).toEqual({ allowed: false, reason: 'directory_managed' });
      expect(row.allowedActions.edit).toEqual({ allowed: true });
      expect(row.allowedActions.manageProjects).toEqual({ allowed: true });

      const detail = await call('GET', `/api/iam/principals/group/${ws.groups[groupKey]}`, 'admin');
      expect(detail.status).toBe(200);
      expect(detail.body.principal).toMatchObject({ source, managed: true });
      expect(detail.body.allowedActions.manageMembers).toEqual({ allowed: false, reason: 'directory_managed' });

      const members = await call('GET', `/api/iam/principals/group/${ws.groups[groupKey]}/members`, 'admin');
      expect(members.status).toBe(200);
      expect(members.body.items.length).toBeGreaterThan(0);
      for (const item of members.body.items) expect(item.membershipSource).toBe(source);
    });
  });

  it('keeps the members of a local group editable and says so', async () => {
    const list = await call('GET', '/api/iam/principals?type=group', 'admin');
    const row = list.body.items.find((item: any) => item.id === ws.groups.local);
    expect(row).toMatchObject({ source: 'local', managed: false });
    expect(row.allowedActions.manageMembers).toEqual({ allowed: true });
    const members = await call('GET', `/api/iam/principals/group/${ws.groups.local}/members`, 'admin');
    expect(members.body.items.every((item: any) => item.membershipSource === 'local')).toBe(true);
    expect((await call('POST', `/api/groups/${ws.groups.local}/members`, 'admin', { userId: id('other') })).status).toBe(201);
    expect((await call('DELETE', `/api/groups/${ws.groups.local}/members/${id('other')}`, 'admin')).status).toBe(200);
  });

  it('marks, on the person, which memberships are the directory\'s and cannot be left from here', async () => {
    const detail = await call('GET', `/api/iam/principals/user/${id('sso')}`, 'admin');
    const groups = detail.body.groups as Array<{ id: string; source: string; removable: boolean }>;
    expect(groups.find((g) => g.id === ws.groups.sso)).toMatchObject({ source: 'oidc', removable: false });
    expect(groups.find((g) => g.id === ws.groups.local)).toMatchObject({ source: 'local', removable: true });
  });

  it('filters the groups by the single sign-on and by "directory" (LDAP and SSO)', async () => {
    const names = async (source: string) =>
      (await call('GET', `/api/iam/principals?type=group&source=${source}`, 'admin')).body.items.map((i: any) => i.label).sort();
    expect(await names('oidc')).toEqual(['SSO team']);
    expect(await names('sso')).toEqual(['SSO team']);
    expect(await names('ldap')).toEqual(['LDAP team']);
    expect(await names('directory')).toEqual(['LDAP team', 'SSO team']);
    expect(await names('local')).toEqual(['Handmade']);
  });
});
