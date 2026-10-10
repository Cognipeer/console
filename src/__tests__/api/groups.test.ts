import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    // The gate reads the caller (and the engine its policies) through the tenant scope.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

import { getDatabase } from '@/lib/database';
import { groupsApiPlugin } from '@/server/api/plugins/groups';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const adminHeaders = {
  'x-license-type': 'FREE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'admin-1',
  'x-user-role': 'admin',
};

const userHeaders = { ...adminHeaders, 'x-user-id': 'user-2', 'x-user-role': 'user' };

function makeGroup(over: Record<string, unknown> = {}) {
  return {
    _id: 'grp-1',
    tenantId: 'tenant-1',
    name: 'Engineers',
    description: null,
    tenantRole: null,
    servicePermissions: {},
    source: 'local',
    externalId: null,
    createdBy: 'admin-1',
    ...over,
  };
}

describe('groups API', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    // The RBAC gate (members service) loads the caller via findUserById; the
    // handlers also look up target users. Resolve known ids, null otherwise.
    db.findUserById.mockImplementation((async (id: string) => {
      const map: Record<string, unknown> = {
        'admin-1': { _id: 'admin-1', role: 'admin', tenantId: 'tenant-1' },
        'owner-1': { _id: 'owner-1', role: 'owner', tenantId: 'tenant-1' },
        'user-2': { _id: 'user-2', role: 'user', tenantId: 'tenant-1' },
        u9: { _id: 'u9', role: 'user', tenantId: 'tenant-1' },
        'foreign-1': { _id: 'foreign-1', role: 'user', tenantId: 'tenant-2' },
      };
      if (id === 'not-an-id') {
        throw Object.assign(new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'), { name: 'BSONError' });
      }
      return map[id] ?? null;
    }) as never);
    db.listGroupMembersByUser.mockResolvedValue([] as never);
    app = await createFastifyApiTestApp(groupsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('authorization', () => {
    it('forbids non-admins from listing groups', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/groups', headers: userHeaders });
      expect(res.statusCode).toBe(403);
    });

    it('forbids non-admins from creating groups', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups',
        headers: { ...userHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'X' }),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/groups', () => {
    it('lists groups with member/project counts', async () => {
      db.listGroups.mockResolvedValue([makeGroup()] as never);
      db.listGroupMembers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as never);
      db.listGroupProjectsByGroup.mockResolvedValue([{ projectId: 'p1' }] as never);

      const res = await app.inject({ method: 'GET', url: '/api/groups', headers: adminHeaders });
      expect(res.statusCode).toBe(200);
      const body = parseJsonBody<{ groups: Array<{ memberCount: number; projectCount: number }> }>(res.body);
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].memberCount).toBe(2);
      expect(body.groups[0].projectCount).toBe(1);
    });
  });

  describe('POST /api/groups', () => {
    it('requires a name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: '   ' }),
      });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ code: string }>(res.body).code).toBe('invalid_body');
    });

    it('rejects an owner tenantRole grant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'X', tenantRole: 'owner' }),
      });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<{ code: string }>(res.body).code).toBe('invalid_role');
    });

    it('creates a group with a tenantRole grant', async () => {
      db.createGroup.mockImplementation(async (g) => makeGroup({ ...g, _id: 'grp-new' }) as never);
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'Admins', tenantRole: 'admin', servicePermissions: { audit: 'read' } }),
      });
      expect(res.statusCode).toBe(201);
      expect(db.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Admins', tenantRole: 'admin', source: 'local', tenantId: 'tenant-1' }),
      );
    });
  });

  describe('membership', () => {
    it('adds a member to a local group', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups/grp-1/members',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ userId: 'u9' }),
      });
      expect(res.statusCode).toBe(201);
      expect(db.addGroupMember).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: 'grp-1', userId: 'u9', source: 'local' }),
      );
    });

    it('refuses membership edits on an LDAP-synced group', async () => {
      db.findGroupById.mockResolvedValue(makeGroup({ source: 'ldap', externalId: 'cn=eng' }) as never);
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups/grp-1/members',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ userId: 'u9' }),
      });
      expect(res.statusCode).toBe(409);
      expect(db.addGroupMember).not.toHaveBeenCalled();
    });
  });

  describe('who may edit, judged on the role the account has now', () => {
    it('refuses an admin who was demoted since the session was issued', async () => {
      db.findUserById.mockImplementation((async (id: string) =>
        (id === 'admin-1' ? { _id: 'admin-1', role: 'user', tenantId: 'tenant-1' } : null)) as never);
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      db.listGroups.mockResolvedValue([] as never);
      // the session still says admin; the database says user
      const list = await app.inject({ method: 'GET', url: '/api/groups', headers: adminHeaders });
      expect(list.statusCode).toBe(403);
      const add = await app.inject({
        method: 'POST', url: '/api/groups/grp-1/members',
        headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: JSON.stringify({ userId: 'u9' }),
      });
      expect(add.statusCode).toBe(403);
      expect(db.addGroupMember).not.toHaveBeenCalled();
    });
  });

  describe('directory groups answer with a code', () => {
    const post = (url: string, payload: unknown) => app.inject({
      method: 'POST', url, headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: JSON.stringify(payload),
    });

    it('rename, delete, add and remove member all say group_directory_managed for any source but local', async () => {
      for (const source of ['ldap', 'oidc']) {
        db.findGroupById.mockResolvedValue(makeGroup({ source }) as never);
        const rename = await app.inject({
          method: 'PATCH', url: '/api/groups/grp-1', headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'New name' }),
        });
        const remove = await app.inject({ method: 'DELETE', url: '/api/groups/grp-1', headers: adminHeaders });
        const add = await post('/api/groups/grp-1/members', { userId: 'u9' });
        const drop = await app.inject({ method: 'DELETE', url: '/api/groups/grp-1/members/u9', headers: adminHeaders });
        for (const res of [rename, remove, add, drop]) {
          expect(res.statusCode, source).toBe(409);
          expect(parseJsonBody<{ code: string }>(res.body).code).toBe('group_directory_managed');
        }
      }
      expect(db.updateGroup).not.toHaveBeenCalled();
      expect(db.deleteGroup).not.toHaveBeenCalled();
      expect(db.addGroupMember).not.toHaveBeenCalled();
      expect(db.removeGroupMember).not.toHaveBeenCalled();
    });

    it('keeps the grants of a directory group editable', async () => {
      db.findGroupById.mockResolvedValue(makeGroup({ source: 'ldap' }) as never);
      db.updateGroup.mockResolvedValue(makeGroup({ source: 'ldap', tenantRole: 'user' }) as never);
      const res = await app.inject({
        method: 'PATCH', url: '/api/groups/grp-1', headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: JSON.stringify({ tenantRole: 'user' }),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('adding a member', () => {
    const add = (userId: string) => app.inject({
      method: 'POST', url: '/api/groups/grp-1/members',
      headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: JSON.stringify({ userId }),
    });

    it('answers 404 for a person who does not exist, belongs to another workspace, or has an unreadable id', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      for (const userId of ['nobody', 'foreign-1', 'not-an-id']) {
        const res = await add(userId);
        expect(res.statusCode, userId).toBe(404);
        expect(parseJsonBody<{ code: string }>(res.body).code).toBe('user_not_found');
      }
      expect(db.addGroupMember).not.toHaveBeenCalled();
    });

    it('does not let an admin put the owner in a group', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      const res = await add('owner-1');
      expect(res.statusCode).toBe(403);
      expect(parseJsonBody<{ code: string }>(res.body).code).toBe('higher_privileges');
      expect(db.addGroupMember).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/groups/:id: clearing the tenant role', () => {
    it.each([[null], ['']])('writes null when the role is sent as %j (a provider leaves an undefined field alone)', async (value) => {
      db.findGroupById.mockResolvedValue(makeGroup({ tenantRole: 'admin' }) as never);
      db.updateGroup.mockResolvedValue(makeGroup({ tenantRole: null }) as never);
      const res = await app.inject({
        method: 'PATCH', url: '/api/groups/grp-1',
        headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: JSON.stringify({ tenantRole: value }),
      });
      expect(res.statusCode).toBe(200);
      expect(db.updateGroup).toHaveBeenCalledWith('grp-1', expect.objectContaining({ tenantRole: null }));
    });

    it('leaves the role alone when it is not sent', async () => {
      db.findGroupById.mockResolvedValue(makeGroup({ tenantRole: 'admin' }) as never);
      db.updateGroup.mockResolvedValue(makeGroup({ tenantRole: 'admin' }) as never);
      await app.inject({
        method: 'PATCH', url: '/api/groups/grp-1',
        headers: { ...adminHeaders, 'content-type': 'application/json' }, payload: JSON.stringify({ description: 'New text' }),
      });
      expect(db.updateGroup.mock.calls[0][1]).not.toHaveProperty('tenantRole');
    });
  });

  describe('a group that is not there', () => {
    it('is group_not_found, whatever is asked of it', async () => {
      db.findGroupById.mockResolvedValue(null as never);
      const asks: Array<[string, string]> = [['GET', '/api/groups/nope'], ['DELETE', '/api/groups/nope']];
      for (const [method, url] of asks) {
        const res = await app.inject({ method: method as never, url, headers: adminHeaders });
        expect([res.statusCode, parseJsonBody<{ code: string }>(res.body).code], `${method} ${url}`).toEqual([404, 'group_not_found']);
      }
    });

    it('is group_not_found, on every group route, for a group of another workspace', async () => {
      db.findGroupById.mockResolvedValue(makeGroup({ tenantId: 'tenant-2' }) as never);
      const asks: Array<[string, string, Record<string, unknown> | undefined]> = [
        ['GET', '/api/groups/grp-1', undefined],
        ['PATCH', '/api/groups/grp-1', { name: 'Renamed' }],
        ['DELETE', '/api/groups/grp-1', undefined],
        ['POST', '/api/groups/grp-1/members', { userId: 'u9' }],
        ['DELETE', '/api/groups/grp-1/members/u9', undefined],
        ['POST', '/api/groups/grp-1/projects', { projectId: 'p1' }],
        ['DELETE', '/api/groups/grp-1/projects/p1', undefined],
      ];
      for (const [method, url, body] of asks) {
        const res = await app.inject({
          method: method as never,
          url,
          headers: body ? { ...adminHeaders, 'content-type': 'application/json' } : adminHeaders,
          ...(body ? { payload: JSON.stringify(body) } : {}),
        });
        expect([res.statusCode, parseJsonBody<{ code: string }>(res.body).code], `${method} ${url}`).toEqual([404, 'group_not_found']);
      }
      expect(db.updateGroup).not.toHaveBeenCalled();
      expect(db.deleteGroup).not.toHaveBeenCalled();
      expect(db.addGroupMember).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/groups/:id', () => {
    it('names the members without reading the whole user table', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      db.listGroupMembers.mockResolvedValue([
        { userId: 'u9', role: 'member', source: 'local' }, { userId: 'gone', role: 'member', source: 'local' },
      ] as never);
      db.listGroupProjectsByGroup.mockResolvedValue([] as never);
      db.iamListUsers.mockResolvedValue({ items: [{ _id: 'u9', name: 'Ula Nine', email: 'u9@acme.test' }], hasMore: false } as never);

      const res = await app.inject({ method: 'GET', url: '/api/groups/grp-1', headers: adminHeaders });
      expect(res.statusCode).toBe(200);
      expect(db.listUsers).not.toHaveBeenCalled();
      expect(db.iamListUsers).toHaveBeenCalledWith({ tenantId: 'tenant-1', ids: ['u9', 'gone'], limit: 200 });
      expect(parseJsonBody<{ members: Array<Record<string, unknown>> }>(res.body).members).toEqual([
        { userId: 'u9', name: 'Ula Nine', email: 'u9@acme.test', role: 'member', source: 'local' },
        { userId: 'gone', name: null, email: null, role: 'member', source: 'local' },
      ]);
    });

    it('reads the members of a big group a chunk of ids at a time', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      const members = Array.from({ length: 450 }, (_, i) => ({ userId: `u${i}`, role: 'member', source: 'local' }));
      db.listGroupMembers.mockResolvedValue(members as never);
      db.listGroupProjectsByGroup.mockResolvedValue([] as never);
      db.iamListUsers.mockResolvedValue({ items: [], hasMore: false } as never);
      const res = await app.inject({ method: 'GET', url: '/api/groups/grp-1', headers: adminHeaders });
      expect(res.statusCode).toBe(200);
      expect(db.iamListUsers.mock.calls.map((call) => (call[0].ids ?? []).length)).toEqual([200, 200, 50]);
    });
  });

  describe('DELETE /api/groups/:id', () => {
    it('cascades member + project cleanup for local groups', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      const res = await app.inject({ method: 'DELETE', url: '/api/groups/grp-1', headers: adminHeaders });
      expect(res.statusCode).toBe(200);
      expect(db.deleteGroupMembersByGroup).toHaveBeenCalledWith('grp-1');
      expect(db.deleteGroupProjectsByGroup).toHaveBeenCalledWith('grp-1');
      expect(db.deleteGroup).toHaveBeenCalledWith('grp-1');
    });

    it('refuses to delete an LDAP-synced group', async () => {
      db.findGroupById.mockResolvedValue(makeGroup({ source: 'ldap' }) as never);
      const res = await app.inject({ method: 'DELETE', url: '/api/groups/grp-1', headers: adminHeaders });
      expect(res.statusCode).toBe(409);
      expect(db.deleteGroup).not.toHaveBeenCalled();
    });
  });

  describe('project assignment', () => {
    it('assigns a project to a group', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      db.findProjectById.mockResolvedValue({ _id: 'p1', tenantId: 'tenant-1', name: 'Proj' } as never);
      db.upsertGroupProject.mockResolvedValue({ projectId: 'p1', role: 'project_admin', servicePermissions: {} } as never);
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups/grp-1/projects',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ projectId: 'p1', role: 'project_admin' }),
      });
      expect(res.statusCode).toBe(201);
      expect(db.upsertGroupProject).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: 'grp-1', projectId: 'p1', role: 'project_admin' }),
      );
    });

    it('404s when the project does not exist', async () => {
      db.findGroupById.mockResolvedValue(makeGroup() as never);
      db.findProjectById.mockResolvedValue(null as never);
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups/grp-1/projects',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ projectId: 'nope' }),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
