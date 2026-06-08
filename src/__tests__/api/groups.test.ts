import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

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
        'user-2': { _id: 'user-2', role: 'user', tenantId: 'tenant-1' },
        u9: { _id: 'u9', role: 'user', tenantId: 'tenant-1' },
      };
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
    });

    it('rejects an owner tenantRole grant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/groups',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        payload: JSON.stringify({ name: 'X', tenantRole: 'owner' }),
      });
      expect(res.statusCode).toBe(400);
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
