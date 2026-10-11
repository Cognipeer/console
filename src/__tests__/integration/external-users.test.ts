/**
 * External users - the people of a host application who use a portal through its embed - on BOTH SQLite and MongoDB.
 *
 *   storage       an external account is found by the identity (issuer + subject) its token names, never by email;
 *                 it stays out of `listUsers()` and the seat counts, and is counted on its own
 *   resolution    the identity first; then a member by VERIFIED email (linking the identity to them), or a new external
 *                 account when provisioning is on; nobody found and provisioning off is a refusal; the profile and mapped
 *                 groups of an external account follow the token
 *   limits        a token never signs in as an owner or admin by default - by role or through a group - never rewrites a
 *                 member's profile or groups, never fills a group that grants access (a role, permissions, a project
 *                 assignment, a custom policy) or a directory group, and never removes a membership an administrator made
 *   the directory the Authorization center lists them as their own kind, with the counter
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

import type { DatabaseProvider, IGroup, IUser } from '@/lib/database';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { listDirectory } from '@/lib/iam/directory';
import { userKind } from '@/lib/iam/identity';
import { resetGroupPolicyRefsForTests } from '@/lib/iam/policyGroupRefs';
import { createPolicy, deletePolicy } from '@/lib/iam/store';
import {
  countExternalUsers,
  EXTERNAL_MEMBERSHIP_SOURCE,
  EXTERNAL_PASSWORD_PLACEHOLDER,
  externalGroupProblem,
  findExternalGroupProblem,
  isExternalUser,
  resolveExternalUser,
  type ExternalUserMapping,
} from '@/lib/services/users/externalUsers';
import { isUserLoginBlocked } from '@/lib/services/users/userAuthState';
import { describeForEachProvider } from './db-parity.helper';

const ISSUER = 'https://intranet.example.com';

describeForEachProvider('external users', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  const run = <T,>(fn: () => Promise<T>): Promise<T> => db.runWithTenant!(tenantDbName, fn);
  const isMongo = () => getDb() instanceof MongoDBProvider;

  let member: IUser;
  let admin: IUser;
  let disabledMember: IUser;
  let serviceAccount: IUser;
  let groupAdmin: IUser;
  let groupGranted: IUser;
  const groups: Record<string, IGroup> = {};

  const byIdentity: ExternalUserMapping = { matchBy: 'external_id', provision: true };
  const resolve = (claims: Record<string, unknown>, mapping: Partial<ExternalUserMapping> = {}) =>
    resolveExternalUser({
      tenantDbName,
      tenantId,
      claims: { issuer: ISSUER, subject: 'sub-1', ...claims } as never,
      mapping: { ...byIdentity, ...mapping },
    });

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'External', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);
    await run(async () => {
      const mk = (email: string, name: string, extra: Partial<IUser> = {}) => db.createUser({
        tenantId, email, name, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [], ...extra,
      });
      member = await mk('Ayse@Intranet.Example.com', 'Ayse Member');
      admin = await mk('boss@intranet.example.com', 'Boss', { role: 'admin' });
      disabledMember = await mk('gone@intranet.example.com', 'Gone', { status: 'disabled' });
      serviceAccount = await mk('svc@intranet.example.com', 'Service', { canLogin: false });
      groupAdmin = await mk('effadmin@intranet.example.com', 'Admin Through A Group');
      groupGranted = await mk('granted@intranet.example.com', 'Has A Permission Group');
      const grp = (key: string, extra: Partial<IGroup> = {}) => db.createGroup({
        tenantId, name: key, createdBy: 't', source: 'local', ...extra,
      } as never).then((g) => { groups[key] = g; });
      await grp('plain');
      await grp('plain-two');
      await grp('privileged', { tenantRole: 'admin' } as never);
      await grp('granting', { servicePermissions: { agents: 'write' } } as never);
      await grp('directory', { source: 'ldap' } as never);
      // a member whose admin power comes only from a group's workspace role, and one in a group that grants a service level
      await db.addGroupMember({ tenantId, groupId: String(groups.privileged._id), userId: String(groupAdmin._id), role: 'member', source: 'local' });
      await db.addGroupMember({ tenantId, groupId: String(groups.granting._id), userId: String(groupGranted._id), role: 'member', source: 'local' });
    });
  });
  afterAll(async () => {
    hoisted.getDatabase.mockReset();
  });
  beforeEach(async () => {
    // every test starts with no external accounts, so counts mean something, and with no member linked to an identity
    resetGroupPolicyRefsForTests();
    await run(async () => {
      for (const user of await db.listUsers({ includeExternal: true })) {
        if (isExternalUser(user)) await db.deleteUser(String(user._id));
      }
      for (const fixture of [member, admin, disabledMember, serviceAccount, groupAdmin, groupGranted]) {
        await db.updateUser(String(fixture._id), { externalIdentities: [] });
      }
    });
  });

  describe('storage', () => {
    it('finds an external account by identity and never by email, and keeps it out of the lists and counts', async () => {
      await run(async () => {
        const created = await db.createUser({
          tenantId, email: member.email, name: 'Same Address', password: EXTERNAL_PASSWORD_PLACEHOLDER, role: 'user', licenseId: 'FREE',
          features: [], canLogin: false, kind: 'external', source: 'portal-embed', externalIdentities: [{ issuer: ISSUER, subject: 'abc' }],
        });
        expect(created).toMatchObject({ kind: 'external', source: 'portal-embed', canLogin: false });

        const found = await db.findUserByExternalIdentity(ISSUER, 'abc');
        expect(String(found?._id)).toBe(String(created._id));
        expect(found).toMatchObject({ kind: 'external', externalIdentities: [{ issuer: ISSUER, subject: 'abc' }] });
        expect(await db.findUserByExternalIdentity(ISSUER, 'other')).toBeNull();
        expect(await db.findUserByExternalIdentity('https://elsewhere.example.com', 'abc')).toBeNull();
        expect(await db.findUserByExternalIdentity('', 'abc')).toBeNull();

        // the member with the same address is the one an email lookup finds
        expect(String((await db.findUserByEmail(member.email))?._id)).toBe(String(member._id));
        expect(String((await db.findUserByEmail(member.email.toLowerCase()))?._id)).toBe(String(member._id));

        expect((await db.listUsers()).some((u) => String(u._id) === String(created._id))).toBe(false);
        expect((await db.listUsers({ includeExternal: true })).some((u) => String(u._id) === String(created._id))).toBe(true);
        expect(await db.countExternalUsers()).toBe(1);

        expect(await db.iamCountUsers({ tenantId, external: true })).toBe(1);
        const all = await db.iamCountUsers({ tenantId });
        expect(await db.iamCountUsers({ tenantId, external: false })).toBe(all - 1);
        const onlyExternal = await db.iamListUsers({ tenantId, external: true, limit: 50 });
        expect(onlyExternal.items.map((u) => String(u._id))).toEqual([String(created._id)]);
        expect((await db.iamListUsers({ tenantId, external: false, limit: 50 })).items.some((u) => isExternalUser(u))).toBe(false);

        await db.deleteUser(String(created._id));
        expect(await db.findUserByExternalIdentity(ISSUER, 'abc')).toBeNull();
        expect(await db.countExternalUsers()).toBe(0);
      });
    });

    it('moves an identity with the account: an update replaces the list', async () => {
      await run(async () => {
        const created = await db.createUser({
          tenantId, email: '', name: 'Mover', password: EXTERNAL_PASSWORD_PLACEHOLDER, role: 'user', licenseId: 'FREE',
          features: [], canLogin: false, kind: 'external', externalIdentities: [{ issuer: ISSUER, subject: 'old' }],
        });
        await db.updateUser(String(created._id), { externalIdentities: [{ issuer: ISSUER, subject: 'new' }] });
        expect(await db.findUserByExternalIdentity(ISSUER, 'old')).toBeNull();
        expect(String((await db.findUserByExternalIdentity(ISSUER, 'new'))?._id)).toBe(String(created._id));
      });
    });

    it('refuses a second account for an identity that is taken (where the store enforces it)', async () => {
      if (isMongo()) return; // MongoDB enforces it with the unique index the index manifest creates, which a fresh test collection may not have yet
      await run(async () => {
        const make = () => db.createUser({
          tenantId, email: '', name: 'Dup', password: EXTERNAL_PASSWORD_PLACEHOLDER, role: 'user', licenseId: 'FREE',
          features: [], canLogin: false, kind: 'external', externalIdentities: [{ issuer: ISSUER, subject: 'dup' }],
        });
        await make();
        await expect(make()).rejects.toThrow();
        expect(await db.countExternalUsers()).toBe(1); // the failed attempt left no account behind
      });
    });

    it('does not put an external account in the cross-workspace email directory', async () => {
      await run(async () => {
        await db.createUser({
          tenantId, email: 'visitor@host.example.com', name: 'Visitor', password: EXTERNAL_PASSWORD_PLACEHOLDER, role: 'user',
          licenseId: 'FREE', features: [], canLogin: false, kind: 'external', externalIdentities: [{ issuer: ISSUER, subject: 'v' }],
        });
      });
      expect(await db.listTenantsForUser('visitor@host.example.com')).toEqual([]);
    });
  });

  describe('who is blocked from signing in', () => {
    it('an external account is, however it is asked', () => {
      expect(isUserLoginBlocked({ canLogin: true, kind: 'external' })).toBe(true);
      expect(isUserLoginBlocked({ kind: 'external' })).toBe(true);
      expect(isUserLoginBlocked({ kind: 'member' })).toBe(false);
      expect(isUserLoginBlocked({})).toBe(false);
      expect(userKind({ canLogin: false, kind: 'external' })).toBe('external');
      expect(userKind({ canLogin: false })).toBe('service');
      expect(userKind({})).toBe('person');
    });
  });

  describe('resolveExternalUser', () => {
    it('provisions an external account on the first exchange and finds it again on the next', async () => {
      const first = await resolve({ email: 'visitor@host.example.com', name: 'Vera Visitor' });
      expect(first).toMatchObject({ ok: true, created: true, matchedBy: 'external_id' });
      if (!first.ok) return;
      expect(first.user).toMatchObject({
        kind: 'external', source: 'portal-embed', role: 'user', canLogin: false, name: 'Vera Visitor', email: 'visitor@host.example.com',
        password: EXTERNAL_PASSWORD_PLACEHOLDER,
      });
      const second = await resolve({ email: 'visitor@host.example.com', name: 'Vera Visitor' });
      expect(second).toMatchObject({ ok: true, created: false, profileSynced: false });
      if (second.ok) expect(String(second.user._id)).toBe(String(first.user._id));
      expect(await countExternalUsers(tenantDbName)).toBe(1);
    });

    it('follows the token: a new name or address is written, nothing else changes', async () => {
      const first = await resolve({ email: 'v@host.example.com', name: 'V One' });
      const next = await resolve({ email: 'v2@host.example.com', name: 'V Two' });
      expect(next).toMatchObject({ ok: true, created: false, profileSynced: true });
      if (!first.ok || !next.ok) return;
      expect(next.user).toMatchObject({ name: 'V Two', email: 'v2@host.example.com' });
      expect(String(next.user._id)).toBe(String(first.user._id));
      // a token without a name or an address leaves the profile alone
      const bare = await resolve({});
      expect(bare).toMatchObject({ ok: true, profileSynced: false });
      if (bare.ok) expect(bare.user).toMatchObject({ name: 'V Two', email: 'v2@host.example.com' });
    });

    it('uses the subject when the token has no name and no address', async () => {
      const result = await resolve({ subject: 'employee-4711' });
      expect(result.ok && result.user.name).toBe('employee-4711');
    });

    it('refuses an unknown person when provisioning is off', async () => {
      const result = await resolve({ email: 'nobody@host.example.com' }, { provision: false });
      expect(result).toMatchObject({ ok: false, code: 'identity_not_found' });
      expect(await countExternalUsers(tenantDbName)).toBe(0);
    });

    it('keeps two issuers apart', async () => {
      const a = await resolve({});
      const b = await resolve({ issuer: 'https://other.example.com' });
      expect(a.ok && b.ok && String(a.user._id) !== String(b.user._id)).toBe(true);
    });

    it('matches a member by email, whatever the case, and leaves the member\'s profile alone', async () => {
      const result = await resolve({ email: 'AYSE@intranet.example.com', name: 'Someone Else', emailVerified: true }, { matchBy: 'email', provision: false });
      expect(result).toMatchObject({ ok: true, created: false, matchedBy: 'email', linked: true, profileSynced: false });
      if (!result.ok) return;
      expect(String(result.user._id)).toBe(String(member._id));
      const stored = await run(() => db.findUserById(String(member._id)));
      expect(stored).toMatchObject({ name: 'Ayse Member' });
      expect(await countExternalUsers(tenantDbName)).toBe(0);
    });

    describe('by email, the host must vouch for the address', () => {
      const identitiesOf = async (user: IUser) => (await run(() => db.findUserById(String(user._id))))?.externalIdentities ?? [];

      it('never matches a member by an address the token does not say is verified', async () => {
        for (const claims of [{ email: member.email }, { email: member.email, emailVerified: false }]) {
          const result = await resolve({ subject: 'claimant', ...claims }, { matchBy: 'email', provision: false });
          expect(result, JSON.stringify(claims)).toMatchObject({ ok: false, code: 'identity_not_found', reason: 'email_unverified' });
        }
        expect(await identitiesOf(member)).toEqual([]);
        expect(await countExternalUsers(tenantDbName)).toBe(0);
      });

      it('with provisioning on, an unverified address makes an external account and never reaches the member', async () => {
        const result = await resolve({ subject: 'claimant', email: member.email, name: 'Claimant' }, { matchBy: 'email', provision: true });
        expect(result).toMatchObject({ ok: true, created: true, linked: false, matchedBy: 'external_id' });
        if (!result.ok) return;
        expect(String(result.user._id)).not.toBe(String(member._id));
        expect(result.user).toMatchObject({ kind: 'external', canLogin: false });
        expect(await identitiesOf(member)).toEqual([]);
      });

      it('matches a member by an address the administrator trusts the host with, and says so in the row it keeps', async () => {
        const result = await resolve({ subject: 'trusted-sub', email: member.email }, { matchBy: 'email', provision: false, trustEmails: true });
        expect(result).toMatchObject({ ok: true, matchedBy: 'email', linked: true });
        // trusting the host changes nothing about the rules for owners and admins
        expect(await resolve({ subject: 'trusted-admin', email: admin.email }, { matchBy: 'email', provision: false, trustEmails: true })).toMatchObject({ ok: false, code: 'identity_privileged' });
      });

      it('links the identity to the member at the first verified match, and the next sign-in is by identity', async () => {
        const first = await resolve({ subject: 'ayse-1', email: member.email, emailVerified: true }, { matchBy: 'email', provision: false });
        expect(first).toMatchObject({ ok: true, matchedBy: 'email', linked: true, created: false });
        expect(await identitiesOf(member)).toEqual([{ issuer: ISSUER, subject: 'ayse-1' }]);
        expect(String((await run(() => db.findUserByExternalIdentity(ISSUER, 'ayse-1')))?._id)).toBe(String(member._id));
        // it stays a member: not counted as an external account, not given the external kind
        expect(await countExternalUsers(tenantDbName)).toBe(0);
        expect((await run(() => db.findUserById(String(member._id))))?.kind).toBeUndefined();

        // later the address no longer decides anything: not a verified one, not another member's, not none
        for (const claims of [{}, { email: 'someone.else@intranet.example.com', emailVerified: true }, { email: member.email }]) {
          const again = await resolve({ subject: 'ayse-1', ...claims }, { matchBy: 'email', provision: false });
          expect(again, JSON.stringify(claims)).toMatchObject({ ok: true, matchedBy: 'external_id', linked: false });
          if (again.ok) expect(String(again.user._id)).toBe(String(member._id));
        }
      });

      it('refuses another subject of the same issuer for a member who is already linked', async () => {
        await resolve({ subject: 'ayse-1', email: member.email, emailVerified: true }, { matchBy: 'email', provision: false });
        const taker = await resolve({ subject: 'attacker', email: member.email, emailVerified: true }, { matchBy: 'email', provision: false });
        expect(taker).toMatchObject({ ok: false, code: 'identity_not_found', reason: 'identity_conflict' });
        expect(await identitiesOf(member)).toEqual([{ issuer: ISSUER, subject: 'ayse-1' }]);
        expect(await run(() => db.findUserByExternalIdentity(ISSUER, 'attacker'))).toBeNull();
        // with provisioning on the refusal stands: a conflict is not "nobody found"
        expect(await resolve({ subject: 'attacker', email: member.email, emailVerified: true }, { matchBy: 'email', provision: true })).toMatchObject({ ok: false, reason: 'identity_conflict' });
        expect(await countExternalUsers(tenantDbName)).toBe(0);
      });

      it('lets a member be linked to one subject per issuer', async () => {
        await resolve({ subject: 'ayse-1', email: member.email, emailVerified: true }, { matchBy: 'email', provision: false });
        const other = await resolveExternalUser({
          tenantDbName,
          tenantId,
          claims: { issuer: 'https://other-host.example.com', subject: 'ayse-9', email: member.email, emailVerified: true },
          mapping: { matchBy: 'email', provision: false },
        });
        expect(other).toMatchObject({ ok: true, linked: true });
        expect(await identitiesOf(member)).toEqual([
          { issuer: ISSUER, subject: 'ayse-1' },
          { issuer: 'https://other-host.example.com', subject: 'ayse-9' },
        ]);
      });

      it('lets the identity win over the address: a subject that an external account holds stays that account', async () => {
        const ext = await resolve({ subject: 'holder', email: 'holder@host.example.com' }, { matchBy: 'external_id', provision: true });
        if (!ext.ok) throw new Error('expected an account');
        const viaEmailMapping = await resolve({ subject: 'holder', email: member.email, emailVerified: true }, { matchBy: 'email', provision: false });
        expect(viaEmailMapping).toMatchObject({ ok: true, matchedBy: 'external_id', created: false, linked: false });
        if (viaEmailMapping.ok) expect(String(viaEmailMapping.user._id)).toBe(String(ext.user._id));
        expect(await identitiesOf(member)).toEqual([]);
      });

      it('refuses to link when the identity was taken by another account in the meantime (where the store enforces it)', async () => {
        if (isMongo()) return; // MongoDB enforces it with the unique index of the index manifest, which a fresh test collection may not have yet
        const holder = await resolve({ subject: 'raced' }, { matchBy: 'external_id', provision: true });
        if (!holder.ok) throw new Error('expected an account');
        const real = db.findUserByExternalIdentity.bind(db);
        let blind = 1; // the first lookup of the second request ran before the first request wrote anything
        const spy = vi.spyOn(db, 'findUserByExternalIdentity').mockImplementation(async (issuer, subject) => (blind-- > 0 ? null : real(issuer, subject)));
        try {
          const result = await resolve({ subject: 'raced', email: member.email, emailVerified: true }, { matchBy: 'email', provision: false });
          expect(result).toMatchObject({ ok: false, reason: 'identity_conflict' });
          expect(await identitiesOf(member)).toEqual([]);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('by email, falls back to the identity and then to provisioning', async () => {
      const first = await resolve({ email: 'new@host.example.com' }, { matchBy: 'email', provision: true });
      expect(first).toMatchObject({ ok: true, created: true });
      const again = await resolve({ email: 'new@host.example.com' }, { matchBy: 'email', provision: true });
      expect(again).toMatchObject({ ok: true, created: false, matchedBy: 'external_id' });
      // no address in the token: nothing to match by, so provisioning decides
      expect(await resolve({ subject: 'no-mail' }, { matchBy: 'email', provision: false })).toMatchObject({ ok: false, code: 'identity_not_found' });
    });

    it('by email, an external account with a member\'s address never takes the member\'s place', async () => {
      // the external account holds the address too (its profile follows the host)...
      const ext = await resolve({ subject: 'twin', email: member.email, name: 'Twin' });
      expect(ext).toMatchObject({ ok: true, created: true });
      // ...but an email match finds the member
      const viaEmail = await resolve({ subject: 'other', email: member.email, emailVerified: true }, { matchBy: 'email', provision: false });
      expect(viaEmail.ok && String(viaEmail.user._id)).toBe(String(member._id));
    });

    it('does not treat a service account as a person the host can vouch for', async () => {
      const result = await resolve({ email: serviceAccount.email, emailVerified: true }, { matchBy: 'email', provision: false });
      expect(result).toMatchObject({ ok: false, code: 'identity_not_found' });
      expect(result.ok === false && result.reason).toBeUndefined();
    });

    it('refuses a disabled member and a disabled external account', async () => {
      expect(await resolve({ email: disabledMember.email, emailVerified: true }, { matchBy: 'email' })).toMatchObject({ ok: false, code: 'account_disabled' });
      const first = await resolve({ subject: 'soon-gone' });
      if (!first.ok) throw new Error('expected an account');
      await run(() => db.updateUser(String(first.user._id), { status: 'disabled' }));
      expect(await resolve({ subject: 'soon-gone' })).toMatchObject({ ok: false, code: 'account_disabled' });
    });

    it('does not sign in as an owner or admin unless asked to', async () => {
      expect(await resolve({ email: admin.email, emailVerified: true }, { matchBy: 'email' })).toMatchObject({ ok: false, code: 'identity_privileged' });
      expect(await resolve({ email: admin.email, emailVerified: true }, { matchBy: 'email', allowPrivilegedRoles: true })).toMatchObject({ ok: true, matchedBy: 'email' });
    });

    it('judges an owner or admin by the effective role: a workspace role from a group counts, a service permission does not', async () => {
      const refused = await resolve({ subject: 'eff', email: groupAdmin.email, emailVerified: true }, { matchBy: 'email', provision: false });
      expect(refused).toMatchObject({ ok: false, code: 'identity_privileged' });
      // a refused account is left exactly as it was: no link
      expect((await run(() => db.findUserById(String(groupAdmin._id))))?.externalIdentities ?? []).toEqual([]);
      expect(await run(() => db.findUserByExternalIdentity(ISSUER, 'eff'))).toBeNull();
      // the same refusal when the account is found by an identity it was linked to earlier (and its role changed since)
      await run(() => db.updateUser(String(groupAdmin._id), { externalIdentities: [{ issuer: ISSUER, subject: 'eff-linked' }] }));
      expect(await resolve({ subject: 'eff-linked' }, { matchBy: 'external_id', provision: false })).toMatchObject({ ok: false, code: 'identity_privileged' });
      // allowed on purpose
      expect(await resolve({ subject: 'eff-linked' }, { matchBy: 'external_id', provision: false, allowPrivilegedRoles: true })).toMatchObject({ ok: true, matchedBy: 'external_id' });
      // a group that only grants a service level is not a workspace role
      expect(await resolve({ subject: 'granted', email: groupGranted.email, emailVerified: true }, { matchBy: 'email', provision: false })).toMatchObject({ ok: true, matchedBy: 'email' });
    });

    it('refuses claims that are not usable', async () => {
      for (const claims of [{ subject: '' }, { issuer: '' }, { email: 'not-an-address' }, { subject: 'x'.repeat(600) }]) {
        expect(await resolve(claims), JSON.stringify(claims)).toMatchObject({ ok: false, code: 'invalid_claims' });
      }
      expect(await countExternalUsers(tenantDbName)).toBe(0);
    });

    it('stops provisioning at the cap', async () => {
      expect(await resolve({ subject: 'one' }, { maxExternalUsers: 1 })).toMatchObject({ ok: true, created: true });
      expect(await resolve({ subject: 'two' }, { maxExternalUsers: 1 })).toMatchObject({ ok: false, code: 'quota_exceeded' });
      // a known person is still let in
      expect(await resolve({ subject: 'one' }, { maxExternalUsers: 1 })).toMatchObject({ ok: true, created: false });
    });

    it('survives two first sign-ins at once (where the store makes the identity unique)', async () => {
      if (isMongo()) return; // see "refuses a second account"
      const real = db.findUserByExternalIdentity.bind(db);
      let blind = 1; // the first lookup of the second request runs before the first request wrote anything
      const spy = vi.spyOn(db, 'findUserByExternalIdentity').mockImplementation(async (issuer, subject) => (blind-- > 0 ? null : real(issuer, subject)));
      try {
        const first = await resolve({ subject: 'race' });
        expect(first).toMatchObject({ ok: true, created: true });
        blind = 1;
        const second = await resolve({ subject: 'race' });
        expect(second).toMatchObject({ ok: true, created: false });
        expect(await countExternalUsers(tenantDbName)).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('groups', () => {
    const map = (): Record<string, string> => ({
      sales: String(groups.plain._id),
      support: String(groups['plain-two']._id),
      bosses: String(groups.privileged._id),
      granting: String(groups.granting._id),
      ldap: String(groups.directory._id),
      ghost: 'no-such-group',
    });
    const memberships = async (userId: string) => run(async () => (await db.listGroupMembersByUser(userId)).map((m) => [String(m.groupId), m.source ?? 'local'] as const));

    it('adds the mapped groups of the token and nothing else, and says what it skipped', async () => {
      const result = await resolve({ groups: ['sales', 'bosses', 'granting', 'ldap', 'ghost', 'unmapped'] }, { groupMap: map() });
      if (!result.ok) throw new Error('expected an account');
      expect(result.groups.added).toEqual([String(groups.plain._id)]);
      expect(result.groups.skipped).toEqual(expect.arrayContaining([
        { groupId: String(groups.privileged._id), reason: 'privileged_group' },
        { groupId: String(groups.granting._id), reason: 'privileged_group' },
        { groupId: String(groups.directory._id), reason: 'directory_group' },
        { groupId: 'no-such-group', reason: 'group_not_found' },
      ]));
      expect(await memberships(String(result.user._id))).toEqual([[String(groups.plain._id), EXTERNAL_MEMBERSHIP_SOURCE]]);
    });

    it('follows the token: leaving a claim removes what it added, entering one adds', async () => {
      const first = await resolve({ groups: ['sales'] }, { groupMap: map() });
      const second = await resolve({ groups: ['support'] }, { groupMap: map() });
      if (!first.ok || !second.ok) throw new Error('expected an account');
      expect(second.groups).toMatchObject({ added: [String(groups['plain-two']._id)], removed: [String(groups.plain._id)] });
      expect(await memberships(String(second.user._id))).toEqual([[String(groups['plain-two']._id), EXTERNAL_MEMBERSHIP_SOURCE]]);
      const none = await resolve({ groups: [] }, { groupMap: map() });
      expect(none.ok && none.groups.removed).toEqual([String(groups['plain-two']._id)]);
      expect(await memberships(String(second.user._id))).toEqual([]);
    });

    it('never removes a membership an administrator made, nor one in a group the host does not map', async () => {
      const first = await resolve({ groups: [] }, { groupMap: map() });
      if (!first.ok) throw new Error('expected an account');
      const userId = String(first.user._id);
      await run(async () => {
        await db.addGroupMember({ tenantId, groupId: String(groups.plain._id), userId, role: 'member', source: 'local' });
        await db.addGroupMember({ tenantId, groupId: String(groups.privileged._id), userId, role: 'member', source: EXTERNAL_MEMBERSHIP_SOURCE });
      });
      // the token names no group: the administrator's membership stays, and so does a row in a group the host does not map
      const again = await resolve({ groups: [] }, { groupMap: { sales: String(groups.plain._id), support: String(groups['plain-two']._id) } });
      expect(again.ok && again.groups.removed).toEqual([]);
      expect((await memberships(userId)).map(([id]) => id).sort()).toEqual([String(groups.plain._id), String(groups.privileged._id)].sort());
      // and a claim for a group an administrator already put them in does not turn it into the host's
      const claimed = await resolve({ groups: ['sales'] }, { groupMap: { sales: String(groups.plain._id) } });
      expect(claimed.ok && claimed.groups.added).toEqual([]);
      expect((await memberships(userId)).find(([id]) => id === String(groups.plain._id))?.[1]).toBe('local');
    });

    it('does not touch groups when the host maps none', async () => {
      const first = await resolve({ groups: ['sales'] });
      if (!first.ok) throw new Error('expected an account');
      expect(first.groups).toEqual({ added: [], removed: [], skipped: [] });
    });

    it('leaves the groups of a member alone: they are the administrators\'', async () => {
      const result = await resolve({ email: member.email, emailVerified: true, groups: ['sales', 'support'] }, { matchBy: 'email', groupMap: map() });
      expect(result).toMatchObject({ ok: true, matchedBy: 'email' });
      if (!result.ok) return;
      expect(result.groups.added).toEqual([]);
      expect(result.groups.removed).toEqual([]);
      expect(result.groups.skipped).toEqual(expect.arrayContaining([
        { groupId: String(groups.plain._id), reason: 'member_account' },
        { groupId: String(groups['plain-two']._id), reason: 'member_account' },
      ]));
      expect(await memberships(String(member._id))).toEqual([]);
      // and a membership an administrator made is neither touched nor reported as the host's
      await run(() => db.addGroupMember({ tenantId, groupId: String(groups.plain._id), userId: String(member._id), role: 'member', source: 'local' }));
      const again = await resolve({ email: member.email, emailVerified: true, groups: [] }, { matchBy: 'email', groupMap: map() });
      expect(again.ok && again.groups.removed).toEqual([]);
      expect(await memberships(String(member._id))).toEqual([[String(groups.plain._id), 'local']]);
      await run(() => db.removeGroupMember(String(groups.plain._id), String(member._id)));
    });

    it('does not fill a group that is assigned to a project, nor one a custom policy names', async () => {
      const mk = (name: string) => run(() => db.createGroup({ tenantId, name: `${name}-${Math.random().toString(36).slice(2, 6)}`, createdBy: 't', source: 'local' } as never));
      const projected = await mk('projected');
      const named = await mk('named');
      const policyId = `names-${Math.random().toString(36).slice(2, 8)}`;
      await run(async () => {
        await db.upsertGroupProject({ tenantId, groupId: String(projected._id), projectId: 'project-1', role: 'member' });
        await createPolicy(tenantDbName, { policyId, name: policyId, cedar: `forbid(principal in Group::"${String(named._id)}", action == Action::"agents.write", resource is Service);` }, 'u');
      });
      try {
        const map2 = { sales: String(groups.plain._id), projected: String(projected._id), named: String(named._id) };
        const result = await resolve({ groups: ['sales', 'projected', 'named'] }, { groupMap: map2 });
        if (!result.ok) throw new Error('expected an account');
        expect(result.groups.added).toEqual([String(groups.plain._id)]);
        expect(result.groups.skipped).toEqual(expect.arrayContaining([
          { groupId: String(projected._id), reason: 'project_group' },
          { groupId: String(named._id), reason: 'policy_group' },
        ]));
        expect(await memberships(String(result.user._id))).toEqual([[String(groups.plain._id), EXTERNAL_MEMBERSHIP_SOURCE]]);
        await run(async () => {
          expect(await findExternalGroupProblem(db, projected)).toBe('project_group');
          expect(await findExternalGroupProblem(db, named)).toBe('policy_group');
          expect(await findExternalGroupProblem(db, groups.plain)).toBeNull();
          expect(await findExternalGroupProblem(db, groups.privileged)).toBe('privileged_group');
          expect(await findExternalGroupProblem(db, groups.directory)).toBe('directory_group');
        });
      } finally {
        await deletePolicy(tenantDbName, policyId);
      }
      // with the policy gone the group may be filled again (the answer follows the policy version)
      await run(async () => { expect(await findExternalGroupProblem(db, named)).toBeNull(); });
    });

    it('takes the host\'s people out of a group that started to grant something after they were put there', async () => {
      const grp = await run(() => db.createGroup({ tenantId, name: `later-${Math.random().toString(36).slice(2, 6)}`, createdBy: 't', source: 'local' } as never));
      const map3 = { later: String(grp._id) };
      const first = await resolve({ subject: 'later-person', groups: ['later'] }, { groupMap: map3 });
      expect(first.ok && first.groups.added).toEqual([String(grp._id)]);
      if (!first.ok) return;
      await run(() => db.upsertGroupProject({ tenantId, groupId: String(grp._id), projectId: 'project-2', role: 'project_admin' }));
      const second = await resolve({ subject: 'later-person', groups: ['later'] }, { groupMap: map3 });
      expect(second.ok && second.groups).toMatchObject({ added: [], removed: [String(grp._id)], skipped: [{ groupId: String(grp._id), reason: 'project_group' }] });
      expect(await memberships(String(first.user._id))).toEqual([]);
    });

    it('classifies groups by their own document', () => {
      expect(externalGroupProblem({})).toBeNull();
      expect(externalGroupProblem({ source: 'local' })).toBeNull();
      expect(externalGroupProblem({ tenantRole: 'admin' })).toBe('privileged_group');
      expect(externalGroupProblem({ servicePermissions: { agents: 'read' } })).toBe('privileged_group');
      expect(externalGroupProblem({ servicePermissions: {} })).toBeNull();
      expect(externalGroupProblem({ source: 'ldap' })).toBe('directory_group');
    });
  });

  describe('the Authorization center', () => {
    it('lists them as their own kind, with the counter, and filters by it', async () => {
      await resolve({ subject: 'listed-1', name: 'Listed One' });
      await resolve({ subject: 'listed-2', name: 'Listed Two' });
      const viewer = { id: String(admin._id), role: 'owner' };
      const tenant = { tenantDbName, tenantId };
      const everyone = await listDirectory(tenant, viewer, { type: 'user', limit: 100, offset: 0, count: true });
      const externals = everyone.items.filter((i) => i.type === 'user' && i.kind === 'external');
      expect(externals).toHaveLength(2);
      expect(everyone.externalTotal).toBe(2);
      expect(everyone.items.some((i) => i.type === 'user' && i.kind === 'service')).toBe(true);
      expect(everyone.items.some((i) => i.type === 'user' && i.kind === 'person')).toBe(true);

      const only = await listDirectory(tenant, viewer, { type: 'user', kind: 'external', limit: 100, offset: 0, count: true });
      expect(only.items.every((i) => i.type === 'user' && i.kind === 'external')).toBe(true);
      expect(only.total).toBe(2);
      // the other kinds leave them out, and the service filter does not pick them up although they cannot sign in either
      const services = await listDirectory(tenant, viewer, { type: 'user', kind: 'service', limit: 100, offset: 0 });
      expect(services.items.every((i) => i.type === 'user' && i.kind === 'service')).toBe(true);
      const people = await listDirectory(tenant, viewer, { type: 'user', kind: 'person', limit: 100, offset: 0 });
      expect(people.items.every((i) => i.type === 'user' && i.kind === 'person')).toBe(true);
    });
  });
});

describeForEachProvider('external identities and the unique index (MongoDB)', (getDb) => {
  it('two accounts cannot hold the same identity once the index manifest is applied, and members are unaffected', async () => {
    const db = getDb();
    if (!(db instanceof MongoDBProvider)) return; // SQLite keeps the identity in a table with a primary key (tested above)
    const { ensureTenantDbIndexes } = await import('@/lib/database/mongodb/indexManifest');
    const slug = `ext-idx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Index', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    const tid = String(row._id);
    await db.runWithTenant(dbName, async () => {
      const base = { tenantId: tid, password: '!external-account', role: 'user' as const, licenseId: 'FREE', features: [], canLogin: false, kind: 'external' as const };
      // the collection must exist for the manifest to index it (it is existence-guarded)
      await db.createUser({ ...base, kind: undefined, canLogin: true, email: 'first@x.example.com', name: 'First' });
      const handle = (db as unknown as { client: import('mongodb').MongoClient }).client.db(dbName);
      await ensureTenantDbIndexes(handle, `${dbName}-unique-test`);
      await db.createUser({ ...base, email: '', name: 'A', externalIdentities: [{ issuer: 'i', subject: 's' }] });
      await expect(db.createUser({ ...base, email: '', name: 'B', externalIdentities: [{ issuer: 'i', subject: 's' }] })).rejects.toThrow(/E11000|duplicate/i);
      // another subject, another issuer, and any number of members without identities are fine
      await db.createUser({ ...base, email: '', name: 'C', externalIdentities: [{ issuer: 'i', subject: 't' }] });
      await db.createUser({ ...base, email: '', name: 'D', externalIdentities: [{ issuer: 'j', subject: 's' }] });
      await db.createUser({ ...base, kind: undefined, canLogin: true, email: 'second@x.example.com', name: 'Second' });
      await db.createUser({ ...base, kind: undefined, canLogin: true, email: 'third@x.example.com', name: 'Third' });
    });
  });
});
