/**
 * PATCH /api/users/:id - edit a person's name, email and role.
 *
 * The rules are people-policy's (covered as truth tables in unit/people-policy);
 * this pins what the route adds: validation, "a value equal to the stored one is
 * not a change", the answer shape, the audit rows, the cache drop on a role
 * change, the rate limit - and that the caller is judged on the role they have NOW.
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

import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { enqueueAuditLog } from '@/server/api/plugin';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = 'tenant-1';
const MALFORMED_ID = 'not-an-id';

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
const OWNER = headers('owner-1', 'owner');
const ADMIN = headers('admin-1', 'admin');

const fixture = (): Record<string, Record<string, unknown>> => ({
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, email: 'owner@acme.test', name: 'Olivia Owner' },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT, email: 'admin-1@acme.test', name: 'Adam Admin' },
  'admin-2': { _id: 'admin-2', role: 'admin', tenantId: TENANT, email: 'admin-2@acme.test', name: 'Alma Admin' },
  'pa-1': { _id: 'pa-1', role: 'project_admin', tenantId: TENANT, email: 'pa-1@acme.test', name: 'Paula Pa' },
  'member-1': { _id: 'member-1', role: 'user', tenantId: TENANT, email: 'member-1@acme.test', name: 'Mia Member' },
  'member-2': { _id: 'member-2', role: 'user', tenantId: TENANT, email: 'member-2@acme.test', name: 'Max Member' },
  'svc-1': { _id: 'svc-1', role: 'user', tenantId: TENANT, email: '', name: 'Build Bot', canLogin: false },
  'ldap-1': { _id: 'ldap-1', role: 'user', tenantId: TENANT, email: 'ldap-1@acme.test', name: 'Lena Ldap', authProvider: 'ldap' },
  'foreign-1': { _id: 'foreign-1', role: 'user', tenantId: 'other', email: 'f@x.test', name: 'Foreign' },
});

type PatchReply = { user: Record<string, unknown>; changed: string[]; error?: string; code?: string; details?: Array<{ field: string }> };

describe('PATCH /api/users/:id', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  let users: Record<string, Record<string, unknown>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRateLimitStore();
    users = fixture();
    db = createMockDb();
    h.db = db;
    h.recordAuditLog.mockResolvedValue(undefined);
    db.findUserById.mockImplementation(async (id: string) => {
      if (id.startsWith(MALFORMED_ID)) {
        throw Object.assign(new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'), { name: 'BSONError' });
      }
      return (users[id] ? { ...users[id] } : null) as never;
    });
    db.findUserByEmail.mockImplementation(async (email: string) => {
      const found = Object.values(users).find((u) => String(u.email).toLowerCase() === email.toLowerCase() && u.email !== '');
      return (found ? { ...found } : null) as never;
    });
    db.updateUser.mockImplementation(async (id: string, patch: object) => {
      users[id] = { ...users[id], ...patch };
      return { ...users[id] } as never;
    });
    app = await createFastifyApiTestApp(async (instance) => {
      // the real audit hook, so a doubled row would show
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      await instance.register(usersApiPlugin);
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const patch = (id: string, hdrs: Record<string, string>, body: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: hdrs, payload: typeof body === 'string' ? body : JSON.stringify(body) });
  const reply = (res: { body: string }) => parseJsonBody<PatchReply>(res.body);
  const auditEvents = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return h.recordAuditLog.mock.calls.map((call) => (call[1] as { event: string }).event);
  };

  describe('who may edit', () => {
    it('refuses people who do not administer people, and writes nothing', async () => {
      for (const who of [headers('member-1', 'user'), headers('pa-1', 'project_admin')]) {
        const res = await patch('member-2', who, { name: 'Hacked Name' });
        expect(res.statusCode).toBe(403);
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('judges the caller on the role the account has now: a demoted admin cannot edit', async () => {
      users['admin-1'].role = 'user';
      const res = await patch('member-1', ADMIN, { name: 'Renamed Person' });
      expect(res.statusCode).toBe(403);
      expect(db.updateUser).not.toHaveBeenCalled();
    });
  });

  describe('the request', () => {
    it('needs a JSON object with at least one of name, email and role, and nothing else', async () => {
      for (const body of ['[]', '"text"', '{}', { nickname: 'x' }, { name: 'Fine Name', extra: 1 }]) {
        const res = await patch('member-1', OWNER, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(reply(res).code, JSON.stringify(body)).toBe('invalid_body');
      }
      const unknown = reply(await patch('member-1', OWNER, { nickname: 'x' }));
      expect(unknown.details).toEqual([{ field: 'nickname', message: 'Unknown field' }]);
      // text that is not JSON never reaches the handler
      expect((await patch('member-1', OWNER, 'not json')).statusCode).toBe(400);
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('validates the name', async () => {
      for (const name of ['x', ' ', 'y'.repeat(121), 7, null, ['a', 'b']]) {
        const res = await patch('member-1', OWNER, { name });
        expect(res.statusCode, JSON.stringify(name)).toBe(400);
        expect(reply(res).code).toBe('invalid_body');
        expect(reply(res).details?.[0].field).toBe('name');
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('validates the email, which a person who signs in cannot do without', async () => {
      for (const email of ['nope', 'a@b', 'two words@x.test', 5]) {
        const res = await patch('member-1', OWNER, { email });
        expect(res.statusCode, JSON.stringify(email)).toBe(400);
        expect(reply(res).details?.[0].field).toBe('email');
      }
      const empty = await patch('member-1', OWNER, { email: '  ' });
      expect(empty.statusCode).toBe(400);
      expect(reply(empty).code).toBe('email_required');
      // a service account has none
      const cleared = await patch('svc-1', OWNER, { email: '' });
      expect(cleared.statusCode).toBe(200);
      expect(reply(cleared).changed).toEqual([]);
    });

    it('answers 404 for an unknown person, another workspace\'s, and an id the database cannot parse', async () => {
      for (const id of ['nobody', 'foreign-1', MALFORMED_ID, `${MALFORMED_ID}-with-a-longer-tail`]) {
        const res = await patch(id, OWNER, { name: 'Valid Name' });
        expect(res.statusCode, id).toBe(404);
        expect(reply(res).code).toBe('user_not_found');
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });
  });

  describe('a profile', () => {
    it('changes name and email together and says which changed', async () => {
      const res = await patch('member-1', ADMIN, { name: '  Mia Renamed  ', email: 'mia.new@acme.test' });
      expect(res.statusCode).toBe(200);
      expect(reply(res)).toMatchObject({ changed: ['name', 'email'], user: { _id: 'member-1', name: 'Mia Renamed', email: 'mia.new@acme.test', role: 'user' } });
      expect(db.updateUser).toHaveBeenCalledTimes(1);
      expect(db.updateUser).toHaveBeenCalledWith('member-1', { name: 'Mia Renamed', email: 'mia.new@acme.test' });
    });

    it('ignores a value equal to the stored one (no write, no row)', async () => {
      const res = await patch('member-1', ADMIN, { name: 'Mia Member', email: 'member-1@acme.test', role: 'user' });
      expect(res.statusCode).toBe(200);
      expect(reply(res).changed).toEqual([]);
      expect(db.updateUser).not.toHaveBeenCalled();
      expect(await auditEvents()).toEqual([]);
    });

    it('only writes what differs', async () => {
      await patch('member-1', ADMIN, { name: 'Mia Member', email: 'mia.new@acme.test' });
      expect(db.updateUser).toHaveBeenCalledWith('member-1', { email: 'mia.new@acme.test' });
    });

    it('keeps an email unique within the workspace, but lets a person keep their own', async () => {
      const taken = await patch('member-1', ADMIN, { email: 'MEMBER-2@acme.test' });
      expect(taken.statusCode).toBe(409);
      expect(reply(taken).code).toBe('email_taken');
      expect(db.updateUser).not.toHaveBeenCalled();
      // only the case differs: still theirs
      const own = await patch('member-1', ADMIN, { email: 'Member-1@acme.test' });
      expect(own.statusCode).toBe(200);
      expect(reply(own).changed).toEqual(['email']);
    });

    it('leaves the name and email of a directory account to the directory, but not its role', async () => {
      for (const body of [{ name: 'Lena Renamed' }, { email: 'lena@elsewhere.test' }, { name: 'Lena Renamed', role: 'admin' }]) {
        const res = await patch('ldap-1', OWNER, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(409);
        expect(reply(res).code).toBe('directory_managed');
      }
      expect(db.updateUser).not.toHaveBeenCalled();
      expect((await patch('ldap-1', OWNER, { name: 'Lena Ldap' })).statusCode).toBe(200); // not a change
      const role = await patch('ldap-1', OWNER, { role: 'project_admin' });
      expect(role.statusCode).toBe(200);
      expect(reply(role).changed).toEqual(['role']);
    });

    it('keeps the owner\'s profile for the owner', async () => {
      const byAdmin = await patch('owner-1', ADMIN, { name: 'Taken Over' });
      expect(byAdmin.statusCode).toBe(403);
      expect(reply(byAdmin).code).toBe('higher_privileges');
      expect((await patch('owner-1', OWNER, { name: 'Olivia Renamed' })).statusCode).toBe(200);
    });

    it('lets an admin edit another admin', async () => {
      expect((await patch('admin-2', ADMIN, { name: 'Alma Renamed' })).statusCode).toBe(200);
    });
  });

  describe('a role', () => {
    it.each([
      ['owner', OWNER, 'member-1', 'admin'],
      ['owner', OWNER, 'admin-2', 'user'],
      ['admin', ADMIN, 'member-1', 'admin'],
      ['admin', ADMIN, 'admin-2', 'user'],
      ['admin', ADMIN, 'pa-1', 'user'],
      ['admin', ADMIN, 'member-1', 'project_admin'],
      ['admin', ADMIN, 'svc-1', 'admin'],
    ] as const)('%s may change %s to %s', async (_who, who, id, role) => {
      const before = users[id].role;
      const res = await patch(id, who, { role });
      expect(res.statusCode).toBe(200);
      expect(reply(res)).toMatchObject({ changed: ['role'], user: { _id: id, role } });
      expect(db.updateUser).toHaveBeenCalledWith(id, { role });
      await vi.waitFor(() => expect(h.recordAuditLog).toHaveBeenCalled());
      const row = h.recordAuditLog.mock.calls[0][1] as Record<string, unknown>;
      expect(row).toMatchObject({
        event: 'user.role.change', service: 'members', resourceType: 'user', resourceId: id,
        metadata: { from: before, to: role }, outcome: 'success',
      });
    });

    it('drops the cached state of the person at once, so their next request is judged on the new role', async () => {
      await patch('member-1', OWNER, { role: 'admin' });
      expect(h.cacheDel).toHaveBeenCalledWith('user-auth-state:tenant_acme:member-1');
      expect(h.cacheDel).toHaveBeenCalledWith('user-identity:tenant_acme:member-1');
    });

    it('refuses the owner role, and a role that does not exist', async () => {
      for (const role of ['owner', 'root', '', 7, null]) {
        const res = await patch('member-1', OWNER, { role });
        expect(res.statusCode, JSON.stringify(role)).toBe(400);
        expect(reply(res).code).toBe('invalid_role');
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('never changes the owner\'s role - not by an admin, not by the owner', async () => {
      for (const who of [ADMIN, OWNER]) {
        const res = await patch('owner-1', who, { role: 'user' });
        expect(res.statusCode).toBe(403);
        expect(reply(res).code).toBe('owner_immutable');
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('nobody changes their own role', async () => {
      const res = await patch('admin-1', ADMIN, { role: 'user' });
      expect(res.statusCode).toBe(403);
      expect(reply(res).code).toBe('cannot_change_own_role');
      // ... but their own name is theirs to edit
      expect((await patch('admin-1', ADMIN, { name: 'Adam Renamed' })).statusCode).toBe(200);
    });

    it('is not a change to the role a person already has', async () => {
      const res = await patch('admin-2', ADMIN, { role: 'admin' });
      expect(res.statusCode).toBe(200);
      expect(reply(res).changed).toEqual([]);
      expect(db.updateUser).not.toHaveBeenCalled();
      // the owner echoing their own role back is not a change either
      expect((await patch('owner-1', OWNER, { role: 'owner', name: 'Olivia Renamed' })).statusCode).toBe(200);
    });

    it('checks the role before it writes anything of the profile', async () => {
      const res = await patch('owner-1', OWNER, { name: 'Olivia Renamed', role: 'admin' });
      expect(res.statusCode).toBe(403);
      expect(db.updateUser).not.toHaveBeenCalled();
    });
  });

  describe('the trail', () => {
    it('writes a row for what changed - fields by name, never the address - and no generic row', async () => {
      await patch('member-1', ADMIN, { name: 'Mia Renamed', email: 'secret.new@acme.test', role: 'admin' });
      expect((await auditEvents()).sort()).toEqual(['user.profile.update', 'user.role.change']);
      const profile = h.recordAuditLog.mock.calls.map((c) => c[1] as Record<string, unknown>).find((r) => r.event === 'user.profile.update')!;
      expect(profile).toMatchObject({
        actorUserId: 'admin-1', actorRole: 'admin', resourceType: 'user', resourceId: 'member-1', service: 'members',
        method: 'PATCH', path: '/api/users/member-1', metadata: { changedFields: ['name', 'email'] },
      });
      expect(JSON.stringify(h.recordAuditLog.mock.calls)).not.toContain('secret.new@acme.test');
    });

    it('writes nothing for a refusal of the rules (the request hook records those) and for a no-op', async () => {
      await patch('owner-1', ADMIN, { role: 'user' });
      await patch('member-1', ADMIN, { name: 'Mia Member' });
      expect((await auditEvents()).filter((event) => event.startsWith('user.'))).toEqual([]);
    });
  });

  it('is rate limited per actor', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await patch('member-1', ADMIN, { name: 'Mia Member' })).statusCode).toBe(200);
    }
    const limited = await patch('member-1', ADMIN, { name: 'Mia Member' });
    expect(limited.statusCode).toBe(429);
    expect(reply(limited).code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeTruthy();
    // another actor has a limit of their own
    expect((await patch('member-1', OWNER, { name: 'Mia Member' })).statusCode).toBe(200);
  });
});
