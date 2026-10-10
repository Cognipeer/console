/**
 * POST /api/users/bulk - one action for a page of people.
 *
 * Every person is judged by the guards of the single-person endpoints and gets a
 * result of their own; a refused person (yourself, the owner) never stops the rest.
 * `dryRun` writes nothing. One parent audit row summarises the request and the rows
 * the single actions write share its batch id.
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
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: TENANT, email: 'owner@acme.test', name: 'Owner' },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: TENANT, email: 'admin-1@acme.test', name: 'Admin' },
  'admin-2': { _id: 'admin-2', role: 'admin', tenantId: TENANT, email: 'admin-2@acme.test', name: 'Admin Two' },
  'member-1': { _id: 'member-1', role: 'user', tenantId: TENANT, email: 'm1@acme.test', name: 'Member One' },
  'member-2': { _id: 'member-2', role: 'user', tenantId: TENANT, email: 'm2@acme.test', name: 'Member Two' },
  'member-3': { _id: 'member-3', role: 'user', tenantId: TENANT, email: 'm3@acme.test', name: 'Member Three' },
  'off-1': { _id: 'off-1', role: 'user', tenantId: TENANT, email: 'off@acme.test', name: 'Off', status: 'disabled' },
  'ldap-1': { _id: 'ldap-1', role: 'user', tenantId: TENANT, email: 'ldap@acme.test', name: 'Lena Ldap', authProvider: 'ldap' },
  'foreign-1': { _id: 'foreign-1', role: 'user', tenantId: 'other', email: 'f@x.test', name: 'Foreign' },
});

interface BulkReply {
  action: string;
  dryRun: boolean;
  requested: number;
  ok: number;
  skipped: number;
  failed: number;
  batchId: string;
  results: Array<{ id: string; outcome: string; code?: string; revoked?: number }>;
  code?: string;
  error?: string;
}

describe('POST /api/users/bulk', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  let users: Record<string, Record<string, unknown>>;
  /** userId -> group ids */
  let memberships: Record<string, string[]>;
  let tokens: Array<{ _id: string; userId: string; label: string; tokenHash: string }>;

  const groups: Record<string, Record<string, unknown>> = {
    'g-local': { _id: 'g-local', tenantId: TENANT, name: 'Local team', source: 'local' },
    'g-ldap': { _id: 'g-ldap', tenantId: TENANT, name: 'Directory team', source: 'ldap' },
    'g-foreign': { _id: 'g-foreign', tenantId: 'other', name: 'Foreign team', source: 'local' },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetRateLimitStore();
    users = fixture();
    memberships = { 'member-1': ['g-local'], 'member-3': ['g-local', 'g-ldap'] };
    tokens = [
      { _id: 'tok-1', userId: 'member-1', label: 'ci', tokenHash: 'a'.repeat(64) },
      { _id: 'tok-2', userId: 'member-1', label: 'notebook', tokenHash: 'b'.repeat(64) },
      { _id: 'tok-3', userId: 'owner-1', label: 'owner key', tokenHash: 'c'.repeat(64) },
      { _id: 'tok-4', userId: 'admin-2', label: 'admin key', tokenHash: 'd'.repeat(64) },
    ];
    db = createMockDb();
    h.db = db;
    h.recordAuditLog.mockResolvedValue(undefined);
    db.findUserById.mockImplementation(async (id: string) => (users[id] ? { ...users[id] } : null) as never);
    db.updateUser.mockImplementation(async (id: string, patch: object) => {
      users[id] = { ...users[id], ...patch };
      return { ...users[id] } as never;
    });
    db.findGroupById.mockImplementation(async (id: string) => {
      if (id === 'not-an-id') throw Object.assign(new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'), { name: 'BSONError' });
      return (groups[id] ? { ...groups[id] } : null) as never;
    });
    db.listGroupMembersByUser.mockImplementation(async (userId: string) =>
      (memberships[userId] ?? []).map((groupId) => ({ groupId, userId })) as never);
    db.addGroupMember.mockImplementation(async (data: { groupId: string; userId: string }) => {
      memberships[data.userId] = [...(memberships[data.userId] ?? []), data.groupId];
      return data as never;
    });
    db.removeGroupMember.mockImplementation(async (groupId: string, userId: string) => {
      const had = (memberships[userId] ?? []).includes(groupId);
      memberships[userId] = (memberships[userId] ?? []).filter((g) => g !== groupId);
      return had;
    });
    db.listApiTokens.mockImplementation(async (userId: string) => tokens.filter((t) => t.userId === userId).map((t) => ({ ...t })) as never);
    db.deleteApiToken.mockImplementation(async (id: string, userId: string) => {
      const before = tokens.length;
      tokens = tokens.filter((t) => !(t._id === id && t.userId === userId));
      return tokens.length < before;
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

  const bulk = (hdrs: Record<string, string>, body: unknown) =>
    app.inject({ method: 'POST', url: '/api/users/bulk', headers: hdrs, payload: typeof body === 'string' ? body : JSON.stringify(body) });
  const reply = (res: { body: string }) => parseJsonBody<BulkReply>(res.body);
  const resultOf = (res: { body: string }, id: string) => reply(res).results.find((result) => result.id === id);
  const auditRows = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return h.recordAuditLog.mock.calls.map((call) => call[1] as Record<string, any>);
  };

  describe('who may call it, and what it needs', () => {
    it('refuses people who do not administer people', async () => {
      for (const who of [headers('member-1', 'user'), headers('member-1', 'project_admin')]) {
        expect((await bulk(who, { action: 'disable', ids: ['member-2'] })).statusCode).toBe(403);
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('judges the caller on the role the account has now', async () => {
      users['admin-1'].role = 'user';
      expect((await bulk(ADMIN, { action: 'disable', ids: ['member-2'] })).statusCode).toBe(403);
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('needs a JSON object with a known action and a list of ids', async () => {
      const bad: Array<[unknown, string]> = [
        ['[]', 'invalid_body'], ['"x"', 'invalid_body'],
        [{ ids: ['member-1'] }, 'invalid_action'], [{ action: 'delete', ids: ['member-1'] }, 'invalid_action'], [{ action: 7, ids: ['member-1'] }, 'invalid_action'],
        [{ action: 'disable' }, 'invalid_body'], [{ action: 'disable', ids: [] }, 'invalid_body'], [{ action: 'disable', ids: 'member-1' }, 'invalid_body'],
        [{ action: 'disable', ids: ['member-1', 7] }, 'invalid_body'], [{ action: 'disable', ids: ['member-1', ''] }, 'invalid_body'],
        [{ action: 'disable', ids: ['member-1'], reason: 'x'.repeat(501) }, 'invalid_body'], [{ action: 'disable', ids: ['member-1'], reason: 5 }, 'invalid_body'],
        [{ action: 'disable', ids: ['member-1'], dryRun: 'yes' }, 'invalid_body'],
        [{ action: 'add-to-group', ids: ['member-1'] }, 'invalid_body'], [{ action: 'remove-from-group', ids: ['member-1'], groupId: '' }, 'invalid_body'],
      ];
      for (const [body, code] of bad) {
        const res = await bulk(ADMIN, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(reply(res).code, JSON.stringify(body)).toBe(code);
      }
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('takes a page of people at most', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `member-${i}`);
      const res = await bulk(ADMIN, { action: 'disable', ids });
      expect(res.statusCode).toBe(400);
      expect(reply(res).code).toBe('too_many_ids');
      const exactly = await bulk(ADMIN, { action: 'disable', ids: ids.slice(0, 100), dryRun: true });
      expect(exactly.statusCode).toBe(200);
      expect(reply(exactly).requested).toBe(100);
    });

    it('is rate limited per actor', async () => {
      for (let i = 0; i < 20; i += 1) {
        expect((await bulk(ADMIN, { action: 'disable', ids: ['member-1'], dryRun: true })).statusCode).toBe(200);
      }
      const limited = await bulk(ADMIN, { action: 'disable', ids: ['member-1'], dryRun: true });
      expect(limited.statusCode).toBe(429);
      expect(reply(limited).code).toBe('rate_limited');
      expect((await bulk(OWNER, { action: 'disable', ids: ['member-1'], dryRun: true })).statusCode).toBe(200);
    });
  });

  describe('disable and enable', () => {
    it('gives every person a result: the refused ones are skipped with a code, the rest go through', async () => {
      const res = await bulk(ADMIN, {
        action: 'disable',
        reason: 'offboarding',
        ids: ['member-1', 'member-2', 'admin-1', 'owner-1', 'nobody', 'off-1', 'foreign-1', 'ldap-1', 'admin-2'],
      });
      expect(res.statusCode).toBe(200);
      const body = reply(res);
      expect(body).toMatchObject({ action: 'disable', dryRun: false, requested: 9, ok: 4, skipped: 5, failed: 0 });
      expect(body.results.map((r) => [r.id, r.outcome, r.code])).toEqual([
        ['member-1', 'ok', undefined],
        ['member-2', 'ok', undefined],
        ['admin-1', 'skipped', 'self_not_allowed'],
        ['owner-1', 'skipped', 'owner_immutable'],
        ['nobody', 'skipped', 'user_not_found'],
        ['off-1', 'skipped', 'already_in_state'],
        ['foreign-1', 'skipped', 'user_not_found'],
        ['ldap-1', 'ok', undefined], // a directory account is disabled, not deleted
        ['admin-2', 'ok', undefined], // an admin acts on admins
      ]);
      expect(users['member-1'].status).toBe('disabled');
      expect(users['member-2'].status).toBe('disabled');
      expect(users['owner-1'].status).toBeUndefined();
      expect(users['admin-1'].status).toBeUndefined();
    });

    it('writes one row per person (carrying the batch id) and one parent row - and no generic row', async () => {
      const res = await bulk(ADMIN, { action: 'disable', reason: ' offboarding ', ids: ['member-1', 'member-2', 'owner-1'] });
      const { batchId } = reply(res);
      expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
      const rows = await auditRows();
      const events = rows.map((row) => row.event).sort();
      expect(events).toEqual(['user.bulk', 'user.disable', 'user.disable']);
      for (const row of rows.filter((r) => r.event === 'user.disable')) {
        expect(row.metadata).toMatchObject({ reason: 'offboarding', batchId });
      }
      const parent = rows.find((row) => row.event === 'user.bulk')!;
      expect(parent).toMatchObject({
        service: 'members', resourceType: 'user', resourceId: batchId, actorUserId: 'admin-1', method: 'POST', path: '/api/users/bulk',
        metadata: { action: 'disable', batchId, requested: 3, ok: 2, skipped: 1, failed: 0 },
      });
    });

    it('enables, and skips the people who are active already', async () => {
      const res = await bulk(OWNER, { action: 'enable', ids: ['off-1', 'member-1'] });
      expect(reply(res)).toMatchObject({ ok: 1, skipped: 1 });
      expect(resultOf(res, 'member-1')).toMatchObject({ outcome: 'skipped', code: 'already_in_state' });
      expect(users['off-1'].status).toBe('active');
    });

    it('counts a person named twice once', async () => {
      const res = await bulk(ADMIN, { action: 'disable', ids: ['member-1', 'member-1', 'member-1'] });
      expect(reply(res)).toMatchObject({ requested: 1, ok: 1 });
      expect(db.updateUser).toHaveBeenCalledTimes(1);
    });

    it('does nothing in a dry run - and says what would happen', async () => {
      const res = await bulk(ADMIN, { action: 'disable', ids: ['member-1', 'admin-1', 'off-1', 'owner-1'], dryRun: true });
      expect(reply(res)).toMatchObject({ dryRun: true, requested: 4, ok: 1, skipped: 3 });
      expect(resultOf(res, 'member-1')).toEqual({ id: 'member-1', outcome: 'ok' });
      expect(db.updateUser).not.toHaveBeenCalled();
      expect(await auditRows()).toEqual([]);
    });
  });

  describe('groups', () => {
    it('adds people to a local group: the ones in it already and the ones above the actor are skipped', async () => {
      const res = await bulk(ADMIN, { action: 'add-to-group', groupId: 'g-local', ids: ['member-1', 'member-2', 'owner-1', 'nobody', 'ldap-1'] });
      expect(reply(res)).toMatchObject({ ok: 2, skipped: 3, failed: 0 });
      expect(resultOf(res, 'member-1')).toMatchObject({ outcome: 'skipped', code: 'already_in_state' });
      expect(resultOf(res, 'member-2')).toEqual({ id: 'member-2', outcome: 'ok' });
      expect(resultOf(res, 'owner-1')).toMatchObject({ outcome: 'skipped', code: 'higher_privileges' });
      expect(resultOf(res, 'nobody')).toMatchObject({ outcome: 'skipped', code: 'user_not_found' });
      expect(resultOf(res, 'ldap-1')).toEqual({ id: 'ldap-1', outcome: 'ok' }); // a directory person can join a local group
      expect(db.addGroupMember).toHaveBeenCalledTimes(2);
      expect(db.addGroupMember).toHaveBeenCalledWith({ tenantId: TENANT, groupId: 'g-local', userId: 'member-2', role: 'member', source: 'local', addedBy: 'admin-1' });
    });

    it('removes people from a local group: the ones who are not in it are skipped', async () => {
      const res = await bulk(ADMIN, { action: 'remove-from-group', groupId: 'g-local', ids: ['member-1', 'member-2', 'member-3'] });
      expect(reply(res)).toMatchObject({ ok: 2, skipped: 1 });
      expect(resultOf(res, 'member-2')).toMatchObject({ outcome: 'skipped', code: 'not_a_member' });
      expect(memberships['member-1']).toEqual([]);
      expect(memberships['member-3']).toEqual(['g-ldap']);
    });

    it('writes a row per membership, with the batch id', async () => {
      const res = await bulk(ADMIN, { action: 'add-to-group', groupId: 'g-local', ids: ['member-2'] });
      const rows = await auditRows();
      expect(rows.find((row) => row.event === 'group.member.add')).toMatchObject({
        resourceType: 'group', resourceId: 'g-local', service: 'members', metadata: { userId: 'member-2', batchId: reply(res).batchId },
      });
      expect(rows.find((row) => row.event === 'user.bulk')?.metadata).toMatchObject({ action: 'add-to-group', groupId: 'g-local', ok: 1 });
    });

    it('leaves the members of a directory group to the directory, and refuses an unknown group for the whole request', async () => {
      const ldap = await bulk(ADMIN, { action: 'add-to-group', groupId: 'g-ldap', ids: ['member-2'] });
      expect([ldap.statusCode, reply(ldap).code]).toEqual([409, 'group_directory_managed']);
      for (const groupId of ['nope', 'g-foreign', 'not-an-id']) {
        const res = await bulk(ADMIN, { action: 'remove-from-group', groupId, ids: ['member-2'] });
        expect([res.statusCode, reply(res).code], groupId).toEqual([404, 'group_not_found']);
      }
      expect(db.addGroupMember).not.toHaveBeenCalled();
      expect(db.removeGroupMember).not.toHaveBeenCalled();
    });

    it('does nothing in a dry run', async () => {
      const res = await bulk(ADMIN, { action: 'add-to-group', groupId: 'g-local', ids: ['member-2', 'member-1'], dryRun: true });
      expect(reply(res)).toMatchObject({ ok: 1, skipped: 1 });
      expect(db.addGroupMember).not.toHaveBeenCalled();
      expect(await auditRows()).toEqual([]);
    });
  });

  describe('revoking tokens', () => {
    it('revokes the tokens of the people the actor may reach and reports how many', async () => {
      const res = await bulk(ADMIN, { action: 'revoke-tokens', ids: ['member-1', 'member-2', 'admin-2', 'owner-1'] });
      expect(reply(res)).toMatchObject({ ok: 3, skipped: 1, failed: 0 });
      expect(resultOf(res, 'member-1')).toEqual({ id: 'member-1', outcome: 'ok', revoked: 2 });
      expect(resultOf(res, 'member-2')).toEqual({ id: 'member-2', outcome: 'ok', revoked: 0 });
      expect(resultOf(res, 'admin-2')).toEqual({ id: 'admin-2', outcome: 'ok', revoked: 1 }); // an admin reaches a colleague's
      expect(resultOf(res, 'owner-1')).toMatchObject({ outcome: 'skipped', code: 'higher_privileges' }); // never the owner's
      expect(tokens.map((t) => t._id)).toEqual(['tok-3']);
      // each token's cached record goes with it
      expect(h.cacheDel).toHaveBeenCalledWith(`api-auth:${'a'.repeat(16)}`);
      expect(h.cacheDel).toHaveBeenCalledWith(`api-auth:${'d'.repeat(16)}`);
      expect(h.cacheDel).not.toHaveBeenCalledWith(`api-auth:${'c'.repeat(16)}`);
    });

    it('lets the owner reach everybody\'s, and anybody revoke their own', async () => {
      const res = await bulk(OWNER, { action: 'revoke-tokens', ids: ['owner-1', 'member-1'] });
      expect(reply(res)).toMatchObject({ ok: 2 });
      expect(tokens.map((t) => t._id)).toEqual(['tok-4']);
      const own = await bulk(ADMIN, { action: 'revoke-tokens', ids: ['admin-1'] });
      expect(resultOf(own, 'admin-1')).toEqual({ id: 'admin-1', outcome: 'ok', revoked: 0 });
    });

    it('leaves a row per person with the tokens that went, and none for a person with nothing to revoke', async () => {
      const res = await bulk(ADMIN, { action: 'revoke-tokens', ids: ['member-1', 'member-2'] });
      const rows = await auditRows();
      const revokes = rows.filter((row) => row.event === 'token.revoke');
      expect(revokes).toHaveLength(1);
      expect(revokes[0]).toMatchObject({
        service: 'tokens', resourceType: 'token', resourceId: 'member-1',
        metadata: { ownerUserId: 'member-1', revoked: 2, tokenIds: ['tok-1', 'tok-2'], batchId: reply(res).batchId },
      });
      expect(JSON.stringify(rows)).not.toContain('a'.repeat(16)); // no hash
    });

    it('does nothing in a dry run', async () => {
      const res = await bulk(ADMIN, { action: 'revoke-tokens', ids: ['member-1', 'owner-1'], dryRun: true });
      expect(reply(res)).toMatchObject({ ok: 1, skipped: 1 });
      expect(tokens).toHaveLength(4);
    });

    it('reports a person whose tokens could not all be revoked as failed, and carries on', async () => {
      db.deleteApiToken.mockImplementation(async (id: string, userId: string) => {
        if (id === 'tok-1') throw new Error('db down');
        tokens = tokens.filter((t) => !(t._id === id && t.userId === userId));
        return true;
      });
      const res = await bulk(ADMIN, { action: 'revoke-tokens', ids: ['member-1', 'admin-2'] });
      expect(resultOf(res, 'member-1')).toMatchObject({ outcome: 'failed', code: 'failed', revoked: 1 });
      expect(resultOf(res, 'admin-2')).toMatchObject({ outcome: 'ok', revoked: 1 });
    });
  });

  it('turns a person it cannot process into a failed result, not a failed request', async () => {
    db.updateUser.mockImplementation(async (id: string) => {
      if (id === 'member-1') throw new Error('db down');
      return { ...users[id], status: 'disabled' } as never;
    });
    const res = await bulk(ADMIN, { action: 'disable', ids: ['member-1', 'member-2'] });
    expect(res.statusCode).toBe(200);
    expect(reply(res)).toMatchObject({ ok: 1, failed: 1 });
    expect(resultOf(res, 'member-1')).toMatchObject({ outcome: 'failed', code: 'failed' });
  });
});
