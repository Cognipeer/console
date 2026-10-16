/**
 * The access endpoints of the users plugin, through the live plugin with a mock database:
 *
 *   POST /api/users/:id/projects          several projects at once (owner/admin, or the project admin of each project)
 *   POST /api/users/external              an external person by hand (issuer of a delegation, unique identity)
 *   GET  /api/users/external/issuers      the issuers to pick from
 *   POST /api/users/me/access-request     "I have no project": recorded, mailed, audited, once per 24 h
 *   POST /api/users/invite                `projects[]`, and the legacy single `projectId` still works
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/iam/delegationIssuers', () => ({
  listDelegationIssuers: vi.fn().mockResolvedValue([{ issuer: 'https://idp.example.com', enabled: true, tokens: 1 }]),
  isDelegationIssuer: vi.fn(async (_db: string, issuer: string) => issuer === 'https://idp.example.com'),
}));
vi.mock('@/lib/services/users/peopleAudit', () => ({
  recordPeopleAudit: vi.fn(),
  directoryAuditActor: vi.fn(),
}));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$hash'),
  compare: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { recordPeopleAudit } from '@/lib/services/users/peopleAudit';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = { _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'STARTER', companyName: 'Acme' };
const PROJECTS = [
  { _id: 'p1', tenantId: 'tenant-1', key: 'one', name: 'Project One' },
  { _id: 'p2', tenantId: 'tenant-1', key: 'two', name: 'Project Two' },
  { _id: 'other', tenantId: 'tenant-2', key: 'foreign', name: 'Foreign' },
];
const ACCOUNTS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: 'tenant-1', name: 'Olivia Owner', email: 'owner@acme.com' },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: 'tenant-1', name: 'Adam Admin', email: 'admin@acme.com' },
  'padmin-1': { _id: 'padmin-1', role: 'user', tenantId: 'tenant-1', name: 'Pat Padmin', email: 'pat@acme.com' },
  'member-1': { _id: 'member-1', role: 'user', tenantId: 'tenant-1', name: 'Mia Member', email: 'member@acme.com' },
  'lost-1': { _id: 'lost-1', role: 'user', tenantId: 'tenant-1', name: 'Lou Lost', email: 'lou@acme.com' },
  'ext-1': { _id: 'ext-1', role: 'user', kind: 'external', canLogin: false, tenantId: 'tenant-1', name: 'Ext', email: '' },
  'foreign-1': { _id: 'foreign-1', role: 'user', tenantId: 'tenant-2', name: 'Foreign', email: 'f@other.com' },
};
const headersFor = (userId: string, role: string) => ({
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-email': String(ACCOUNTS[userId]?.email ?? ''),
  'x-user-id': userId,
  'x-user-role': role,
});

describe('users access endpoints', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  let memberships: Array<Record<string, unknown>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    memberships = [];
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantById.mockResolvedValue(TENANT as never);
    db.findUserByEmail.mockResolvedValue(null);
    db.findUserById.mockImplementation(async (id: string) => (ACCOUNTS[id] ? { ...ACCOUNTS[id] } : null) as never);
    db.listProjects.mockResolvedValue(PROJECTS as never);
    db.listUserProjectsByUser.mockImplementation(async (userId: string) => memberships.filter((m) => m.userId === userId) as never);
    db.upsertUserProject.mockImplementation(async (row: Record<string, unknown>) => {
      memberships = memberships.filter((m) => !(m.userId === row.userId && m.projectId === row.projectId));
      memberships.push(row);
      return row as never;
    });
    db.iamCountUsers.mockResolvedValue(10);
    db.iamListUsers.mockResolvedValue({ items: [ACCOUNTS['owner-1'], ACCOUNTS['admin-1']], hasMore: false } as never);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'new-1', ...input }) as never);
    db.updateUser.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...ACCOUNTS[id], ...patch }) as never);
    db.findUsersByExternalIdentity.mockResolvedValue([]);
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    app = await createFastifyApiTestApp(usersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (url: string, body: unknown, who: [string, string] = ['owner-1', 'owner']) => app.inject({
    method: 'POST', url, headers: headersFor(...who), payload: JSON.stringify(body),
  });
  const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);

  // ── POST /users/:id/projects ──────────────────────────────────────────

  describe('POST /api/users/:id/projects', () => {
    const grant = (projects: unknown, extra: Record<string, unknown> = {}, who?: [string, string], userId = 'member-1') =>
      post(`/api/users/${userId}/projects`, { projects, ...extra }, who);

    it('adds a person to several projects, each with its own role, as a manual membership recorded to the actor', async () => {
      const res = await grant([{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'project_admin' }]);
      expect(res.statusCode).toBe(200);
      expect(json(res)).toEqual({ added: ['p1', 'p2'], updated: [], skipped: [] });
      expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'p2', role: 'project_admin', invitedBy: 'owner-1', source: 'manual', userId: 'member-1', tenantId: 'tenant-1',
      }));
      expect(recordPeopleAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
        event: 'user.projects.add', resourceId: 'member-1', metadata: { added: ['p1', 'p2'], updated: [] },
      }));
    });

    it('leaves a membership that already has the role alone, and updates one whose role differs', async () => {
      memberships = [
        { userId: 'member-1', projectId: 'p1', role: 'member', servicePermissions: {}, invitedBy: 'someone' },
        { userId: 'member-1', projectId: 'p2', role: 'member', servicePermissions: {}, invitedBy: 'someone' },
      ];
      const res = await grant([{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'project_admin' }]);
      expect(json(res)).toEqual({ added: [], updated: ['p2'], skipped: [{ projectId: 'p1', reason: 'already_member' }] });
      expect(db.upsertUserProject).toHaveBeenCalledTimes(1);
      expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2', role: 'project_admin', invitedBy: 'someone' }));
    });

    it('skips a project that is not in the workspace (a foreign one included) and writes nothing for it', async () => {
      const res = await grant([{ projectId: 'p1', role: 'member' }, { projectId: 'other', role: 'member' }, { projectId: 'nope', role: 'member' }]);
      expect(res.statusCode).toBe(200);
      expect(json(res)).toEqual({
        added: ['p1'], updated: [],
        skipped: [{ projectId: 'other', reason: 'project_not_found' }, { projectId: 'nope', reason: 'project_not_found' }],
      });
    });

    it('rejects an external person - they never get project memberships', async () => {
      const res = await grant([{ projectId: 'p1', role: 'member' }], {}, undefined, 'ext-1');
      expect([res.statusCode, json<{ code: string }>(res).code]).toEqual([400, 'external_user']);
      expect(db.upsertUserProject).not.toHaveBeenCalled();
    });

    it('rejects an owner or admin (implicit access) and a person of another workspace', async () => {
      expect((await grant([{ projectId: 'p1', role: 'member' }], {}, undefined, 'admin-1')).statusCode).toBe(400);
      expect((await grant([{ projectId: 'p1', role: 'member' }], {}, undefined, 'foreign-1')).statusCode).toBe(404);
      expect((await grant([{ projectId: 'p1', role: 'member' }], {}, undefined, 'ghost')).statusCode).toBe(404);
      expect(db.upsertUserProject).not.toHaveBeenCalled();
    });

    it('lets the project admin of every named project do it, and refuses when one of them is not theirs', async () => {
      memberships = [
        { userId: 'padmin-1', projectId: 'p1', role: 'project_admin' },
        { userId: 'padmin-1', projectId: 'p2', role: 'member' },
      ];
      const who: [string, string] = ['padmin-1', 'user'];
      expect((await grant([{ projectId: 'p1', role: 'member' }], {}, who)).statusCode).toBe(200);
      const refused = await grant([{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'member' }], {}, who, 'lost-1');
      expect(refused.statusCode).toBe(403);
      expect(db.upsertUserProject).toHaveBeenCalledTimes(1); // only the first, allowed call wrote
    });

    it('refuses an ordinary member', async () => {
      expect((await grant([{ projectId: 'p1', role: 'member' }], {}, ['member-1', 'user'], 'lost-1')).statusCode).toBe(403);
      expect(db.upsertUserProject).not.toHaveBeenCalled();
    });

    it('validates the body with a code', async () => {
      const code = async (body: Record<string, unknown>) => {
        const res = await post('/api/users/member-1/projects', body);
        return [res.statusCode, json<{ code?: string }>(res).code];
      };
      expect(await code({})).toEqual([400, 'invalid_body']);
      expect(await code({ projects: [] })).toEqual([400, 'invalid_body']);
      expect(await code({ projects: [{ projectId: 'p1', role: 'owner' }] })).toEqual([400, 'invalid_body']);
      expect(await code({ projects: [{ role: 'member' }] })).toEqual([400, 'invalid_body']);
      expect(await code({ projects: [{ projectId: 'p1', role: 'member' }], notify: 'yes' })).toEqual([400, 'invalid_body']);
      expect(await code({ projects: [{ projectId: 'p1', role: 'member' }], servicePermissions: 'all' })).toEqual([400, 'invalid_body']);
    });

    it('keeps a stored service access unless one is given; null resets it to the project default', async () => {
      memberships = [{ userId: 'member-1', projectId: 'p1', role: 'member', servicePermissions: { models: 'read' }, invitedBy: 'x' }];
      await grant([{ projectId: 'p1', role: 'project_admin' }]);
      expect(db.upsertUserProject).toHaveBeenLastCalledWith(expect.objectContaining({ servicePermissions: { models: 'read' } }));
      await grant([{ projectId: 'p1', role: 'project_admin' }], { servicePermissions: null });
      expect(db.upsertUserProject).toHaveBeenLastCalledWith(expect.objectContaining({ servicePermissions: {} }));
    });

    it('mails the person only when asked, and a mail that cannot be sent does not undo the memberships', async () => {
      await grant([{ projectId: 'p1', role: 'member' }]);
      expect(sendEmail).not.toHaveBeenCalled();

      (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      const res = await grant([{ projectId: 'p2', role: 'project_admin' }], { notify: true });
      expect(res.statusCode).toBe(200);
      expect(sendEmail).toHaveBeenCalledWith('member@acme.com', 'projects-added', expect.objectContaining({
        companyName: 'Acme',
        adderName: 'Olivia Owner',
        projects: [{ name: 'Project Two', roleLabel: 'Project admin' }],
      }));
      expect(json(res)).toMatchObject({ added: ['p2'] });
    });

    it('does not mail when nothing was added', async () => {
      memberships = [{ userId: 'member-1', projectId: 'p1', role: 'member', servicePermissions: {} }];
      await grant([{ projectId: 'p1', role: 'member' }], { notify: true });
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  // ── external users ────────────────────────────────────────────────────

  describe('POST /api/users/external', () => {
    const body = { issuer: 'https://idp.example.com', subject: 'sub-42', name: 'Ayşe', email: 'ayse@partner.example' };
    const create = (payload: Record<string, unknown> = body, who?: [string, string]) => post('/api/users/external', payload, who);

    it('creates the account a verified assertion would create: external, no sign-in, the User role, bound to the identity', async () => {
      const res = await create();
      expect(res.statusCode).toBe(201);
      expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'external', canLogin: false, role: 'user', authProvider: 'local', tenantId: 'tenant-1',
        externalIds: { 'https://idp.example.com': 'sub-42' }, name: 'Ayşe', email: 'ayse@partner.example',
        mustChangePassword: false, licenseId: 'STARTER',
      }));
      expect(json<{ user: { canLogin: boolean } }>(res).user.canLogin).toBe(false);
      expect(recordPeopleAudit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ event: 'user.external.create' }));
    });

    it('names the account after the subject when no name or address is given', async () => {
      await create({ issuer: 'https://idp.example.com', subject: 'sub-7' });
      expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ name: 'sub-7', email: '' }));
    });

    it('is for owners and admins only', async () => {
      expect((await create(body, ['member-1', 'user'])).statusCode).toBe(403);
      expect((await create(body, ['admin-1', 'admin'])).statusCode).toBe(201);
      expect(db.createUser).toHaveBeenCalledTimes(1);
    });

    it('refuses an issuer the workspace has no delegation for', async () => {
      const res = await create({ ...body, issuer: 'https://evil.example.com' });
      expect([res.statusCode, json<{ code: string }>(res).code]).toEqual([400, 'invalid_issuer']);
      expect(db.createUser).not.toHaveBeenCalled();
    });

    it('answers 409 when the identity already has an account in the workspace', async () => {
      db.findUsersByExternalIdentity.mockResolvedValue([{ _id: 'old', tenantId: 'tenant-1' }] as never);
      const res = await create();
      expect([res.statusCode, json<{ code: string }>(res).code]).toEqual([409, 'identity_taken']);
      expect(db.createUser).not.toHaveBeenCalled();
    });

    it('answers 409 when the address belongs to an account already', async () => {
      db.findUserByEmail.mockResolvedValue({ _id: 'someone', tenantId: 'tenant-1' } as never);
      const res = await create();
      expect([res.statusCode, json<{ code: string }>(res).code]).toEqual([409, 'email_taken']);
      expect(db.createUser).not.toHaveBeenCalled();
    });

    it('removes its own account and answers 409 when a concurrent call created the identity first', async () => {
      db.findUsersByExternalIdentity
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ _id: 'first', tenantId: 'tenant-1' }, { _id: 'new-1', tenantId: 'tenant-1' }] as never);
      const res = await create();
      expect(res.statusCode).toBe(409);
      expect(db.deleteUser).toHaveBeenCalledWith('new-1');
    });

    it('counts toward the user quota', async () => {
      (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: false, reason: 'users limit reached' });
      const res = await create();
      expect([res.statusCode, json<{ code: string }>(res).code]).toEqual([429, 'quota_exceeded']);
      expect(db.createUser).not.toHaveBeenCalled();
    });

    it('validates the body', async () => {
      for (const bad of [{}, { issuer: 'https://idp.example.com' }, { subject: 'x' }, { ...body, email: 'nope' }, { ...body, groupIds: 'g1' }, { ...body, active: 'no' }]) {
        const res = await create(bad);
        expect(res.statusCode).toBe(400);
      }
      expect(db.createUser).not.toHaveBeenCalled();
    });

    it('puts the person in the groups named, and never in one that grants access', async () => {
      db.findGroupById.mockImplementation(async (id: string) => ({
        g1: { _id: 'g1', tenantId: 'tenant-1', name: 'Partners', source: 'local' },
        gadmin: { _id: 'gadmin', tenantId: 'tenant-1', name: 'Admins', source: 'local', tenantRole: 'admin' },
        gdir: { _id: 'gdir', tenantId: 'tenant-1', name: 'Dir', source: 'ldap' },
        gforeign: { _id: 'gforeign', tenantId: 'tenant-2', name: 'F', source: 'local' },
      } as Record<string, unknown>)[id] as never ?? null);

      const ok = await create({ ...body, groupIds: ['g1'] });
      expect(ok.statusCode).toBe(201);
      expect(db.addGroupMember).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'g1', userId: 'new-1', role: 'member', source: 'local', addedBy: 'owner-1' }));

      db.createUser.mockClear();
      for (const groupId of ['gadmin', 'gdir', 'gforeign', 'missing']) {
        const res = await create({ ...body, subject: `sub-${groupId}`, groupIds: [groupId] });
        expect(res.statusCode, groupId).toBeGreaterThanOrEqual(400);
      }
      expect(db.createUser).not.toHaveBeenCalled(); // a refused group leaves no account behind
    });

    it('creates the account disabled when active is false', async () => {
      db.findUserById.mockImplementation(async (id: string) => (
        id === 'new-1' ? { _id: 'new-1', tenantId: 'tenant-1', role: 'user', kind: 'external', canLogin: false } : ACCOUNTS[id] ? { ...ACCOUNTS[id] } : null
      ) as never);
      const res = await create({ ...body, active: false });
      expect(res.statusCode).toBe(201);
      expect(db.updateUser).toHaveBeenCalledWith('new-1', expect.objectContaining({ status: 'disabled' }));
    });
  });

  describe('GET /api/users/external/issuers', () => {
    it('lists the issuers of the workspace to owners and admins', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/users/external/issuers', headers: headersFor('admin-1', 'admin') });
      expect(res.statusCode).toBe(200);
      expect(json(res)).toEqual({ issuers: [{ issuer: 'https://idp.example.com', enabled: true, tokens: 1 }] });
    });

    it('is not for members', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/users/external/issuers', headers: headersFor('member-1', 'user') });
      expect(res.statusCode).toBe(403);
    });
  });

  // ── access request ────────────────────────────────────────────────────

  describe('POST /api/users/me/access-request', () => {
    const ask = (body: unknown = {}, who: [string, string] = ['lost-1', 'user']) => post('/api/users/me/access-request', body, who);

    it('records the request on the person, mails the owners and admins and audits it', async () => {
      const res = await ask({ message: '  I need the Sales project  ' });
      expect(res.statusCode).toBe(200);
      expect(db.updateUser).toHaveBeenCalledWith('lost-1', {
        accessRequest: { at: expect.any(Date), message: 'I need the Sales project' },
      });
      expect(json<{ accessRequest: { message: string } }>(res).accessRequest.message).toBe('I need the Sales project');
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(sendEmail).toHaveBeenCalledWith('owner@acme.com', 'access-request', expect.objectContaining({
        requesterName: 'Lou Lost', requesterEmail: 'lou@acme.com', message: 'I need the Sales project', companyName: 'Acme',
      }));
      expect(recordPeopleAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'lost-1' }), expect.objectContaining({
        event: 'user.access.request', resourceId: 'lost-1',
      }));
    });

    it('works without a message and without a mail server', async () => {
      (sendEmail as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const res = await ask();
      expect(res.statusCode).toBe(200);
      expect(db.updateUser).toHaveBeenCalledWith('lost-1', { accessRequest: { at: expect.any(Date) } });
    });

    it('allows one request per person per 24 hours (429 with Retry-After), and a new one after that', async () => {
      const recent = new Date(Date.now() - 60 * 60 * 1000);
      db.findUserById.mockImplementation(async (id: string) => ({ ...ACCOUNTS[id], accessRequest: { at: recent } }) as never);
      const limited = await ask({ message: 'again' });
      expect(limited.statusCode).toBe(429);
      expect(json<{ code: string }>(limited).code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(22 * 3600);
      expect(db.updateUser).not.toHaveBeenCalled();

      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      db.findUserById.mockImplementation(async (id: string) => ({ ...ACCOUNTS[id], accessRequest: { at: old } }) as never);
      expect((await ask({ message: 'again' })).statusCode).toBe(200);
      expect(db.updateUser).toHaveBeenCalledTimes(1);
    });

    it('is for a person with no accessible project: a membership, a legacy entry or a group grant means they already have one', async () => {
      memberships = [{ userId: 'lost-1', projectId: 'p1', role: 'member' }];
      const direct = await ask();
      expect([direct.statusCode, json<{ code: string }>(direct).code]).toEqual([409, 'already_has_access']);

      memberships = [];
      db.findUserById.mockImplementation(async (id: string) => ({ ...ACCOUNTS[id], projectIds: ['p2'] }) as never);
      expect((await ask()).statusCode).toBe(409);

      db.findUserById.mockImplementation(async (id: string) => ({ ...ACCOUNTS[id] }) as never);
      db.listGroupMembersByUser.mockResolvedValue([{ groupId: 'g1' }] as never);
      db.listGroupProjectsByGroup.mockResolvedValue([{ groupId: 'g1', projectId: 'p1', role: 'member' }] as never);
      expect((await ask()).statusCode).toBe(409);

      expect((await ask({}, ['admin-1', 'admin'])).statusCode).toBe(409);
      expect(db.updateUser).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('does not count a stale project id (a deleted project) as access', async () => {
      memberships = [];
      db.findUserById.mockImplementation(async (id: string) => ({ ...ACCOUNTS[id], projectIds: ['deleted-project'] }) as never);
      expect((await ask()).statusCode).toBe(200);
    });

    it('limits the message to 500 characters and needs it to be text', async () => {
      expect((await ask({ message: 'x'.repeat(501) })).statusCode).toBe(400);
      expect((await ask({ message: 42 })).statusCode).toBe(400);
      expect((await ask({ message: 'x'.repeat(500) })).statusCode).toBe(200);
    });
  });

  // ── invite ────────────────────────────────────────────────────────────

  describe('POST /api/users/invite with projects', () => {
    const person = { name: 'New Person', email: 'new@acme.com' };
    const invite = (body: Record<string, unknown>) => post('/api/users/invite', body);

    it('keeps the legacy single projectId and role working', async () => {
      const res = await invite({ ...person, role: 'project_admin', projectId: 'p1' });
      expect(res.statusCode).toBe(201);
      expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['p1'], role: 'project_admin' }));
      expect(db.upsertUserProject).toHaveBeenCalledTimes(1);
      expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'p1', role: 'project_admin', invitedBy: 'owner-1', source: 'manual', userId: 'new-1',
      }));
    });

    it('takes several projects, each with its own role', async () => {
      const res = await invite({ ...person, role: 'user', projects: [{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'project_admin' }] });
      expect(res.statusCode).toBe(201);
      expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['p1', 'p2'] }));
      expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', role: 'member', source: 'manual' }));
      expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2', role: 'project_admin', source: 'manual' }));
    });

    it('adds the legacy projectId to the list unless it is already named there', async () => {
      await invite({ ...person, role: 'user', projectId: 'p1', projects: [{ projectId: 'p1', role: 'project_admin' }, { projectId: 'p2', role: 'member' }] });
      expect(db.upsertUserProject).toHaveBeenCalledTimes(2);
      expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', role: 'project_admin' }));
    });

    it('gives a service account its projects too, and an admin none (access everywhere)', async () => {
      await invite({ name: 'Bot', role: 'user', canLogin: false, projects: [{ projectId: 'p2', role: 'member' }] });
      expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2', userId: 'new-1' }));

      db.upsertUserProject.mockClear();
      await invite({ ...person, email: 'adm@acme.com', role: 'admin', projects: [{ projectId: 'p1', role: 'member' }] });
      expect(db.upsertUserProject).not.toHaveBeenCalled();
    });

    it('refuses a project that is not in the workspace before creating anybody', async () => {
      for (const projects of [[{ projectId: 'other', role: 'member' }], [{ projectId: 'nope', role: 'member' }]]) {
        const res = await invite({ ...person, role: 'user', projects });
        expect([res.statusCode, json<{ code: string }>(res).code]).toEqual([400, 'project_not_found']);
      }
      expect((await invite({ ...person, role: 'user', projectId: 'nope' })).statusCode).toBe(400);
      expect(db.createUser).not.toHaveBeenCalled();
    });

    it('refuses a malformed project list', async () => {
      for (const projects of ['p1', [{ projectId: 'p1' }], [{ projectId: 'p1', role: 'admin' }], [null]]) {
        const res = await invite({ ...person, role: 'user', projects });
        expect([res.statusCode, json<{ code: string }>(res).code]).toEqual([400, 'invalid_body']);
      }
      expect(db.createUser).not.toHaveBeenCalled();
    });
  });
});
