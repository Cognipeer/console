/**
 * The directory filters, sorts and counts behind the people & access list - the
 * same contract on BOTH backends: who signs in how (local / LDAP / SSO), service
 * accounts, pending invitations, membership of a group or a project, sort order and
 * paging, the token filters, and counts that always agree with the listings.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseProvider, IamUserFilter } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MINUTE = 60_000;

describeForEachProvider('IAM directory filters and counts', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let otherTenantId: string;
  let dbName: string;
  const ids: Record<string, string> = {};
  const groups: Record<string, string> = {};
  const projects: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  const names = (items: Array<{ name: string }>) => items.map((item) => item.name);
  const listNames = async (filter: Partial<IamUserFilter> & { sort?: 'name' | 'email' | 'createdAt'; dir?: 'asc' | 'desc' }) =>
    names((await db.iamListUsers({ tenantId, limit: 200, ...filter })).items);

  beforeAll(async () => {
    db = getDb();
    const slug = `iamflt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Filters', slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    const other = `iamflt-o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    otherTenantId = String((await db.createTenant({ companyName: 'Other', slug: other, dbName: `tenant_${other}`, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(dbName);

    const mk = async (key: string, name: string, extra: Record<string, unknown> = {}) => {
      const user = await db.createUser({
        tenantId,
        email: extra.email !== undefined ? (extra.email as string) : `${key}@corp.example`,
        name,
        password: 'h',
        role: 'user',
        licenseId: 'FREE',
        features: [],
        ...extra,
      } as never);
      ids[key] = String(user._id);
    };
    const invitedAt = new Date('2026-01-01T00:00:00Z');

    await mk('owner', 'Olivia Owner', { role: 'owner' });
    await mk('admin1', 'Adam Admin', { role: 'admin' });
    await mk('admin2', 'Ada Ldap', { role: 'admin', authProvider: 'ldap', externalId: 'cn=ada' });
    await mk('pa', 'Paula Pa', { role: 'project_admin' });
    await mk('u1', 'Una User');
    await mk('u2', 'Uri User');
    await mk('u3', 'Uma User');
    await mk('oidc', 'Oscar Oidc', { authProvider: 'oidc', externalId: 'sub-1' });
    await mk('saml', 'Sam Saml', { authProvider: 'saml', externalId: 'sub-2' });
    await mk('off', 'Otto Off', { status: 'disabled' });
    await mk('invited', 'Ivy Invited', { invitedBy: ids.owner, invitedAt });
    await mk('accepted', 'Abe Accepted', { invitedBy: ids.owner, invitedAt, inviteAcceptedAt: new Date('2026-01-02T00:00:00Z') });
    await mk('invitedOff', 'Ines InvitedOff', { invitedBy: ids.owner, invitedAt, status: 'disabled' });
    await mk('svc1', 'Svc Beta', { canLogin: false, email: '', invitedBy: ids.owner, invitedAt });
    await mk('svc2', 'Svc Alpha', { canLogin: false, email: '' });
    await mk('svcOff', 'Svc Off', { canLogin: false, email: '', status: 'disabled' });
    await db.createUser({ tenantId: otherTenantId, email: 'intruder@other.example', name: 'Intruder', password: 'h', role: 'user', licenseId: 'FREE', features: [] });

    // groups: a local one, a directory one
    const g1 = await db.createGroup({ tenantId, name: 'Local team', createdBy: 't', source: 'local' } as never);
    const g2 = await db.createGroup({ tenantId, name: 'Directory team', createdBy: 't', source: 'ldap' } as never);
    const g3 = await db.createGroup({ tenantId, name: 'Empty team', createdBy: 't', source: 'local' } as never);
    groups.local = String(g1._id);
    groups.ldap = String(g2._id);
    groups.empty = String(g3._id);
    for (const key of ['u1', 'u2', 'admin2']) await db.addGroupMember({ groupId: groups.local, userId: ids[key], tenantId, role: 'member' });
    await db.addGroupMember({ groupId: groups.ldap, userId: ids.u3, tenantId, role: 'member', source: 'ldap' });

    // projects: direct, legacy list, and through a group
    const pA = await db.createProject({ tenantId, key: 'pa', name: 'Project A', createdBy: 'x' });
    const pB = await db.createProject({ tenantId, key: 'pb', name: 'Project B', createdBy: 'x' });
    projects.a = String(pA._id);
    projects.b = String(pB._id);
    await db.upsertUserProject({ tenantId, userId: ids.pa, projectId: projects.a, role: 'project_admin' });
    await db.upsertUserProject({ tenantId, userId: ids.u3, projectId: projects.b, role: 'member' });
    await db.updateUser(ids.oidc, { projectIds: [projects.a] });
    await db.upsertGroupProject({ tenantId, groupId: groups.local, projectId: projects.a, role: 'member' });
    // a longer id that merely starts with project A's must not match it
    await db.updateUser(ids.saml, { projectIds: [`${projects.a}-extra`] });

    // tokens: unscoped/scoped, expiring/expired/never, two owners
    const mkToken = async (key: string, owner: string, extra: Record<string, unknown>) => {
      const token = await db.createApiToken({
        tenantId, userId: ids[owner], label: key, tokenHash: `hash-${key}-${Math.random()}`, tokenPrefix: `cp_${key}`, createdBy: ids[owner], ...extra,
      } as never);
      tokens[key] = String(token._id);
    };
    await mkToken('plain', 'u1', { projectId: projects.a });
    await mkToken('scoped', 'u1', { projectId: projects.b, servicePermissions: { agents: 'read' } });
    await mkToken('emptyScope', 'u2', { projectId: projects.a, servicePermissions: {} });
    await mkToken('expired', 'u2', { expiresAt: new Date(Date.now() - 5 * MINUTE) });
    await mkToken('future', 'admin1', { expiresAt: new Date(Date.now() + 60 * MINUTE) });
    await mkToken('ownerTok', 'owner', {});
    await db.createApiToken({ tenantId: otherTenantId, userId: 'someone', label: 'Foreign', tokenHash: `hash-foreign-${Math.random()}`, tokenPrefix: 'cp_fx' } as never);
  });

  describe('users', () => {
    it('filters by whether the account can sign in', async () => {
      expect((await listNames({ canLogin: false })).sort()).toEqual(['Svc Alpha', 'Svc Beta', 'Svc Off']);
      const people = await listNames({ canLogin: true });
      expect(people).toHaveLength(13);
      expect(people).not.toContain('Svc Alpha');
      expect(await db.iamCountUsers({ tenantId, canLogin: false })).toBe(3);
    });

    it('filters by provider; local also matches an account that has no provider at all', async () => {
      expect(await listNames({ authProviders: ['ldap'] })).toEqual(['Ada Ldap']);
      expect(await listNames({ authProviders: ['oidc'] })).toEqual(['Oscar Oidc']);
      expect((await listNames({ authProviders: ['oidc', 'saml'] })).sort()).toEqual(['Oscar Oidc', 'Sam Saml']);
      const local = await listNames({ authProviders: ['local'] });
      expect(local).toHaveLength(16 - 3);
      expect(local).toContain('Una User');
      expect(local).not.toContain('Ada Ldap');
      expect((await listNames({ authProviders: ['local', 'ldap'] })).length).toBe(14);
    });

    it('finds pending invitations: invited, able to sign in, not accepted, not disabled', async () => {
      expect(await listNames({ invited: true })).toEqual(['Ivy Invited']);
      const rest = await listNames({ invited: false });
      expect(rest).toHaveLength(15);
      expect(rest).not.toContain('Ivy Invited');
      expect(rest).toContain('Abe Accepted'); // accepted
      expect(rest).toContain('Svc Beta'); // a service account has nobody to invite
      expect(rest).toContain('Ines InvitedOff'); // disabled outranks invited
      expect(await listNames({ invited: true, status: 'disabled' })).toEqual([]);
      expect(await db.iamCountUsers({ tenantId, invited: true })).toBe(1);
      expect(await db.iamCountUsers({ tenantId, invited: false })).toBe(15);
    });

    it('combines status filters the way the list does', async () => {
      // active (not disabled, not pending) / disabled / invited partition the workspace
      const active = await listNames({ status: 'active', invited: false });
      const disabled = await listNames({ status: 'disabled' });
      const invited = await listNames({ invited: true });
      expect(disabled.sort()).toEqual(['Ines InvitedOff', 'Otto Off', 'Svc Off']);
      expect(active.length + disabled.length + invited.length).toBe(16);
      expect(new Set([...active, ...disabled, ...invited]).size).toBe(16);
    });

    it('leaves ids out', async () => {
      const all = await listNames({});
      const without = await listNames({ excludeIds: [ids.owner, ids.admin1, 'not-an-id', 'ffffffffffffffffffffffff'] });
      expect(without).toHaveLength(all.length - 2);
      expect(without).not.toContain('Olivia Owner');
      expect(await listNames({ excludeIds: [] })).toHaveLength(all.length);
    });

    it('lists the members of a group, whatever else filters', async () => {
      expect((await listNames({ groupId: groups.local })).sort()).toEqual(['Ada Ldap', 'Una User', 'Uri User']);
      expect(await listNames({ groupId: groups.ldap })).toEqual(['Uma User']);
      expect(await listNames({ groupId: groups.empty })).toEqual([]);
      expect(await listNames({ groupId: groups.local, roles: ['admin'] })).toEqual(['Ada Ldap']);
      expect(await listNames({ groupId: groups.local, authProviders: ['local'] })).toHaveLength(2);
      expect(await db.iamCountUsers({ tenantId, groupId: groups.local })).toBe(3);
      expect(await db.iamCountUsers({ tenantId, groupId: groups.empty })).toBe(0);
    });

    it('lists the members of a project: direct, legacy list and through a group; an id that only starts the same does not match', async () => {
      // pa (direct), oidc (legacy list), u1 + u2 + admin2 (their group is assigned to the project)
      expect((await listNames({ projectId: projects.a })).sort()).toEqual(['Ada Ldap', 'Oscar Oidc', 'Paula Pa', 'Una User', 'Uri User']);
      expect(await listNames({ projectId: projects.b })).toEqual(['Uma User']);
      expect(await listNames({ projectId: projects.a, groupId: groups.local })).toHaveLength(3);
      expect(await db.iamCountUsers({ tenantId, projectId: projects.a })).toBe(5);
      expect(await listNames({ projectId: 'pjnobody' })).toEqual([]);
    });

    it('searches, filters by role and by ids together', async () => {
      expect(await listNames({ q: 'svc', canLogin: false, sort: 'name' })).toEqual(['Svc Alpha', 'Svc Beta', 'Svc Off']);
      expect(await listNames({ q: 'user', roles: ['user'], authProviders: ['local'] })).toEqual(['Uma User', 'Una User', 'Uri User']);
      expect(await listNames({ ids: [ids.u1, ids.u2], canLogin: true })).toEqual(['Una User', 'Uri User']);
      expect(await listNames({ ids: [], canLogin: true })).toEqual([]);
    });

    it('sorts by name, email or creation time, ascending or descending, with the id breaking ties', async () => {
      const byName = await listNames({ sort: 'name' });
      expect(byName).toEqual([...byName].sort());
      expect(await listNames({ sort: 'name', dir: 'desc' })).toEqual([...byName].reverse());

      // email: the lower-cased address; accounts without one sort first
      const byEmail = (await db.iamListUsers({ tenantId, limit: 200, sort: 'email' })).items.map((u) => u.email.toLowerCase());
      expect(byEmail).toEqual([...byEmail].sort());
      expect((await db.iamListUsers({ tenantId, limit: 200, sort: 'email', dir: 'desc' })).items.map((u) => u.email.toLowerCase())).toEqual([...byEmail].reverse());
    });

    it('sorts by creation time', async () => {
      const slug = `iamflt-time-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tenant = String((await db.createTenant({ companyName: 'Time', slug, dbName: `tenant_${slug}`, licenseType: 'FREE', ownerId: 'x' }))._id);
      await db.switchToTenant(`tenant_${slug}`);
      for (const name of ['Third', 'First', 'Second', 'Fourth']) {
        await db.createUser({ tenantId: tenant, email: `${name}@t.example`, name, password: 'h', role: 'user', licenseId: 'FREE', features: [] });
        await pause(8);
      }
      const asc = (await db.iamListUsers({ tenantId: tenant, limit: 10, sort: 'createdAt' })).items.map((u) => u.name);
      expect(asc).toEqual(['Third', 'First', 'Second', 'Fourth']);
      expect((await db.iamListUsers({ tenantId: tenant, limit: 10, sort: 'createdAt', dir: 'desc' })).items.map((u) => u.name)).toEqual(['Fourth', 'Second', 'First', 'Third']);
      await db.switchToTenant(dbName);
    });

    it('pages a sorted listing without gaps or repeats, and its count equals the listing', async () => {
      for (const sort of ['name', 'email', 'createdAt'] as const) {
        for (const dir of ['asc', 'desc'] as const) {
          const seen: string[] = [];
          let offset = 0;
          for (;;) {
            const page = await db.iamListUsers({ tenantId, limit: 5, offset, sort, dir });
            seen.push(...page.items.map((u) => String(u._id)));
            if (!page.hasMore) break;
            offset += 5;
          }
          const full = (await db.iamListUsers({ tenantId, limit: 200, sort, dir })).items.map((u) => String(u._id));
          expect(seen, `${sort} ${dir}`).toEqual(full);
          expect(new Set(seen).size).toBe(seen.length);
          expect(await db.iamCountUsers({ tenantId })).toBe(full.length);
        }
      }
    });

    it('counts exactly what the same filter lists', async () => {
      const filters: Array<Partial<IamUserFilter>> = [
        {}, { canLogin: false }, { canLogin: true }, { authProviders: ['ldap'] }, { authProviders: ['local'] }, { authProviders: ['oidc', 'saml'] },
        { invited: true }, { invited: false }, { status: 'disabled' }, { status: 'active' }, { roles: ['admin', 'owner'] },
        { groupId: groups.local }, { projectId: projects.a }, { q: 'user' }, { q: 'svc', canLogin: false }, { excludeIds: [ids.u1] },
        { ids: [ids.u1, ids.u2, ids.u3] }, { ids: [] },
      ];
      for (const filter of filters) {
        const listed = (await db.iamListUsers({ tenantId, limit: 200, ...filter })).items.length;
        expect(await db.iamCountUsers({ tenantId, ...filter }), JSON.stringify(filter)).toBe(listed);
      }
    });

    it('never sees another workspace', async () => {
      expect(await db.iamCountUsers({ tenantId: otherTenantId })).toBe(1);
      expect(await listNames({})).not.toContain('Intruder');
      expect(await db.iamCountUsers({ tenantId: otherTenantId, groupId: groups.local })).toBe(0);
    });
  });

  describe('groups', () => {
    it('filters by source (local also matches a group with none) and by project', async () => {
      const list = async (filter: Record<string, unknown>) => names((await db.iamListGroups({ tenantId, limit: 50, ...filter })).items);
      expect(await list({ sources: ['ldap'] })).toEqual(['Directory team']);
      expect(await list({ sources: ['local'] })).toEqual(['Empty team', 'Local team']);
      expect(await list({ sources: ['local', 'ldap'] })).toHaveLength(3);
      expect(await list({ projectId: projects.a })).toEqual(['Local team']);
      expect(await list({ projectId: projects.b })).toEqual([]);
      expect(await db.iamCountGroups({ tenantId })).toBe(3);
      expect(await db.iamCountGroups({ tenantId, sources: ['ldap'] })).toBe(1);
      expect(await db.iamCountGroups({ tenantId, projectId: projects.a })).toBe(1);
      expect(await db.iamCountGroups({ tenantId, ids: [] })).toBe(0);
      expect(await db.iamCountGroups({ tenantId: otherTenantId })).toBe(0);
    });
  });

  describe('tokens', () => {
    const labels = async (filter: Record<string, unknown>) =>
      (await db.iamListTokens({ tenantId, limit: 50, ...filter })).items.map((t) => t.label).sort();

    it('filters by expiry state, as of a moment', async () => {
      expect(await labels({ status: 'expired' })).toEqual(['expired']);
      expect(await labels({ status: 'active' })).toEqual(['emptyScope', 'future', 'ownerTok', 'plain', 'scoped']);
      // a token that is active now has expired in two hours
      const later = new Date(Date.now() + 120 * MINUTE);
      expect(await labels({ status: 'expired', now: later })).toEqual(['expired', 'future']);
      expect(await labels({ status: 'active', now: later })).toEqual(['emptyScope', 'ownerTok', 'plain', 'scoped']);
    });

    it('filters by whether the token has a scope of its own (an empty scope counts)', async () => {
      expect(await labels({ scoped: true })).toEqual(['emptyScope', 'scoped']);
      expect(await labels({ scoped: false })).toEqual(['expired', 'future', 'ownerTok', 'plain']);
    });

    it('filters by owner: only these, or all but these', async () => {
      expect(await labels({ userIds: [ids.u1] })).toEqual(['plain', 'scoped']);
      expect(await labels({ userIds: [ids.u1, ids.owner] })).toEqual(['ownerTok', 'plain', 'scoped']);
      expect(await labels({ userIds: [] })).toEqual([]);
      expect(await labels({ excludeUserIds: [ids.owner] })).toEqual(['emptyScope', 'expired', 'future', 'plain', 'scoped']);
      expect(await labels({ excludeUserIds: [ids.owner, ids.u1, ids.u2] })).toEqual(['future']);
      expect(await labels({ excludeUserIds: [] })).toHaveLength(6);
      // one owner and the allowed owners must both hold
      expect(await labels({ userId: ids.u1, userIds: [ids.u2] })).toEqual([]);
      expect(await labels({ userId: ids.u1, excludeUserIds: [ids.u2] })).toEqual(['plain', 'scoped']);
    });

    it('combines with the project and the search', async () => {
      expect(await labels({ projectId: projects.a })).toEqual(['emptyScope', 'plain']);
      expect(await labels({ projectId: projects.a, scoped: true })).toEqual(['emptyScope']);
      expect(await labels({ q: 'cp_sco' })).toEqual(['scoped']);
    });

    it('counts exactly what the same filter lists, and stays in its workspace', async () => {
      const filters: Array<Record<string, unknown>> = [
        {}, { status: 'expired' }, { status: 'active' }, { scoped: true }, { scoped: false }, { userIds: [ids.u1] }, { userIds: [] },
        { excludeUserIds: [ids.owner] }, { projectId: projects.a }, { q: 'cp_' }, { ids: [] }, { ids: [tokens.plain, tokens.scoped] },
      ];
      for (const filter of filters) {
        const listed = (await db.iamListTokens({ tenantId, limit: 50, ...filter })).items.length;
        expect(await db.iamCountTokens({ tenantId, ...filter }), JSON.stringify(filter)).toBe(listed);
      }
      expect(await db.iamCountTokens({ tenantId })).toBe(6);
      expect(await db.iamCountTokens({ tenantId: otherTenantId })).toBe(1);
    });
  });
});
