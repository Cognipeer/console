/**
 * A portal's embed on the SHARED verified-identity core, on BOTH SQLite and MongoDB.
 *
 * The embed has no identity model of its own: the token the host page signs is checked by `verifyIdentityAssertion` (the
 * portal's trust: audience `cognipeer-portal:<key>`, a pinned algorithm, a short life, each `jti` accepted once), the person it
 * names is found, linked or created by `resolveDelegatedPrincipal`, and the portal's one rule of its own - a statement never
 * signs in as an owner or an administrator - is the `accountGuard` of `portalAccountGuard`. What is covered here is that whole
 * path as the portal runs it; the resolver's own rules (match order, races, caches, groups) are covered by
 * delegated-identity.test.ts and external-users.test.ts.
 *
 *   the token        a token for this portal is accepted once; one for another portal is not
 *   the mapping      the portal's default (a verified email, nobody created) and the one that provisions external people
 *   external people  their account, what it cannot do, and that they are found again by identity
 *   the guard        an owner, an administrator, an administrator through a group: refused, and left exactly as they were
 *   groups           memberships follow the token, only in groups created for the issuer
 *   the engine       the resulting person is decided by the real policy engine in the portal channel: `access.embedded`,
 *                    the access list, the network boundary
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

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
import {
  DelegatedAccountRefusal,
  DelegatedIdentityError,
  resetDelegatedIdentityCachesForTests,
  resolveDelegatedPrincipal,
  type DelegatedMapping,
} from '@/lib/iam/delegatedIdentity';
import { resetDelegatedGroupsForTests } from '@/lib/iam/delegatedGroups';
import { IdentityAssertionError, resetIdentityAssertionCachesForTests, verifyIdentityAssertion, type IdentityAssertionTrust } from '@/lib/iam/identityAssertion';
import { portalAccountGuard, refusePrivilegedPortalAccount } from '@/lib/iam/portalIdentityGuard';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { loadEvaluationPrincipal } from '@/lib/iam/principals';
import { authorize, configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { portalResource, type PortalSubject } from '@/lib/iam/portalEntities';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { userKind } from '@/lib/iam/identity';
import { isUserLoginBlocked } from '@/lib/services/users/userAuthState';
import { describeForEachProvider } from './db-parity.helper';

const ISSUER = 'https://intranet.example.com';
const PORTAL_KEY = 'support';
const SECRET = 'a-shared-secret-of-at-least-32-characters-A';
const enc = new TextEncoder();

/** The trust a portal builds from its embed settings (audience fixed, one algorithm, single use). */
const portalTrust = (patch: Partial<IdentityAssertionTrust> = {}): IdentityAssertionTrust => ({
  issuer: ISSUER,
  audience: `cognipeer-portal:${PORTAL_KEY}`,
  algorithms: ['HS256'],
  keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] },
  maxTokenAgeSeconds: 300,
  requireSingleUse: true,
  ...patch,
});

interface HostToken {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
  aud?: string;
}

/** What the host application's backend signs. */
async function hostToken(claims: HostToken = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const { sub = 'sub-1', aud = `cognipeer-portal:${PORTAL_KEY}`, ...profile } = claims;
  return new SignJWT({ ...profile })
    .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomUUID())
    .sign(enc.encode(SECRET));
}

describeForEachProvider('portal embed identity (shared core)', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  const run = <T,>(fn: () => Promise<T>): Promise<T> => db.runWithTenant!(tenantDbName, fn);

  let member: IUser;
  let admin: IUser;
  let owner: IUser;
  let groupAdmin: IUser;
  let permitted: IUser;
  const seeded: IUser[] = [];

  /** The portal's default: a verified email matches a member, nobody is created. */
  const defaultMapping: DelegatedMapping = { matchBy: ['verifiedEmail'], jit: 'none' };
  const provisioning: DelegatedMapping = { matchBy: ['externalId'], jit: 'external' };
  const both: DelegatedMapping = { matchBy: ['externalId', 'verifiedEmail'], jit: 'none' };

  /** The exchange as the portal route runs it: verify, resolve under the portal's guard, check the account that comes back. */
  async function exchange(claims: HostToken, mapping: DelegatedMapping, token?: string) {
    const assertion = await verifyIdentityAssertion({ token: token ?? (await hostToken(claims)), trust: portalTrust() });
    const principal = await resolveDelegatedPrincipal({
      tenantDbName,
      tenantId,
      issuer: assertion.issuer,
      subject: assertion.subject,
      email: assertion.email,
      emailVerified: assertion.emailVerified,
      name: assertion.name,
      groups: assertion.groups,
      mapping,
      accountGuard: portalAccountGuard({ tenantDbName, tenantId }),
    });
    await refusePrivilegedPortalAccount({ tenantDbName, tenantId }, principal.user);
    return { assertion, principal };
  }

  async function expectIdentityError(promise: Promise<unknown>, code: DelegatedIdentityError['code']) {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error, `expected ${code}`).toBeInstanceOf(DelegatedIdentityError);
    expect((error as DelegatedIdentityError).code).toBe(code);
  }

  const mkUser = (email: string, name: string, extra: Partial<IUser> = {}) =>
    db.createUser({ tenantId, email, name, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [], ...extra });
  const mkGroup = (name: string, extra: Partial<IGroup> = {}) => db.createGroup({ tenantId, name, createdBy: 'test', ...extra } as never);
  const stored = (user: IUser) => run(() => db.findUserById(String(user._id)));
  const accounts = () => run(() => db.listUsers({ includeExternal: true }));

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `pemb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Portal embed', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);
    await run(async () => {
      await db.createProject({ tenantId, key: 'default', name: 'Default', createdBy: 't' });
      member = await mkUser('Ayse@Intranet.Example.com', 'Ayse Member');
      admin = await mkUser('boss@intranet.example.com', 'Boss', { role: 'admin' });
      owner = await mkUser('founder@intranet.example.com', 'Founder', { role: 'owner' });
      groupAdmin = await mkUser('ops@intranet.example.com', 'Ops');
      permitted = await mkUser('perm@intranet.example.com', 'Permitted');
      seeded.push(member, admin, owner, groupAdmin, permitted);
      const opsAdmins = await mkGroup('Ops admins', { tenantRole: 'admin' });
      await db.addGroupMember({ tenantId, groupId: String(opsAdmins._id), userId: String(groupAdmin._id), role: 'member', source: 'local' });
      // (a service permission is not a workspace role)
      const reporting = await mkGroup('Reporting', { servicePermissions: { agents: 'read' } as never });
      await db.addGroupMember({ tenantId, groupId: String(reporting._id), userId: String(permitted._id), role: 'member', source: 'local' });
    });
  });
  afterAll(() => {
    hoisted.getDatabase.mockReset();
    configureIamEngine({ validateRequests: false, versionCheckMs: 5_000 });
  });
  beforeEach(async () => {
    resetDelegatedIdentityCachesForTests();
    resetDelegatedGroupsForTests();
    resetIdentityAssertionCachesForTests();
    resetPrincipalCacheForTests();
    resetProjectNarrowingCachesForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    // every test starts from the seeded accounts, unlinked, and without anything the embed made
    await run(async () => {
      for (const user of await db.listUsers({ includeExternal: true })) {
        if (!seeded.some((s) => String(s._id) === String(user._id))) {
          await db.deleteUser(String(user._id));
        } else if (user.externalIds) {
          await db.updateUser(String(user._id), { externalIds: {} });
        }
      }
      for (const group of await db.listGroups(tenantId)) {
        if (group.source === 'delegated' || group.name === 'Support staff') {
          await db.deleteGroupMembersByGroup(String(group._id));
          await db.deleteGroup(String(group._id));
        }
      }
    });
  });

  describe('the host token', () => {
    it('is accepted once: the same token presented again is a replay', async () => {
      const token = await hostToken({ email: member.email, email_verified: true });
      const first = await exchange({}, defaultMapping, token);
      expect(String(first.principal.user._id)).toBe(String(member._id));
      const replay = await exchange({}, defaultMapping, token).then(() => null, (e: unknown) => e);
      expect(replay).toBeInstanceOf(IdentityAssertionError);
      expect((replay as IdentityAssertionError).code).toBe('replayed');
    });

    it('is for one portal: a token made for another portal (or for the API) is refused', async () => {
      for (const aud of ['cognipeer-portal:other', 'console-api']) {
        const error = await exchange({ aud, email: member.email, email_verified: true }, defaultMapping).then(() => null, (e: unknown) => e);
        expect(error, aud).toBeInstanceOf(IdentityAssertionError);
        expect((error as IdentityAssertionError).code, aud).toBe('invalid_assertion');
      }
    });

    it('is checked against the pinned algorithm and the portal secret only', async () => {
      const wrong = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).setIssuer(ISSUER)
        .setAudience(`cognipeer-portal:${PORTAL_KEY}`).setSubject('x').setIssuedAt().setExpirationTime('2m').setJti(randomUUID())
        .sign(enc.encode('a-different-secret-of-at-least-32-chars'));
      const error = await verifyIdentityAssertion({ token: wrong, trust: portalTrust() }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(IdentityAssertionError);
      expect((error as IdentityAssertionError).code).toBe('invalid_assertion');
    });
  });

  describe('the default mapping (a verified email; nobody is created)', () => {
    it('lets a member in by a verified address, whatever its case, and writes nothing for them', async () => {
      const before = await stored(member);
      const { principal } = await exchange({ email: 'ayse@intranet.example.com', email_verified: true, name: 'Someone Else' }, defaultMapping);
      expect(String(principal.user._id)).toBe(String(member._id));
      expect(principal).toMatchObject({ kind: 'person', created: false, matchedBy: 'verifiedEmail' });
      // (only `externalId` in matchBy records a link; a member's own profile is theirs)
      const after = await stored(member);
      expect(after?.externalIds).toBeUndefined();
      expect(after?.name).toBe(before?.name);
      expect(after?.email).toBe(before?.email);
    });

    it('does not take an address the host did not verify, unless the portal trusts the host\'s addresses', async () => {
      await expectIdentityError(exchange({ email: member.email }, defaultMapping), 'unknown_principal');
      const trusted = await exchange({ email: member.email }, { ...defaultMapping, trustEmails: true });
      expect(String(trusted.principal.user._id)).toBe(String(member._id));
    });

    it('refuses an unknown person and creates nobody', async () => {
      const before = (await accounts()).length;
      await expectIdentityError(exchange({ sub: 'stranger', email: 'new@host.example.com', email_verified: true }, defaultMapping), 'unknown_principal');
      expect(await accounts()).toHaveLength(before);
    });

    it('refuses a disabled member', async () => {
      await run(() => db.updateUser(String(member._id), { status: 'disabled' }));
      try {
        await expectIdentityError(exchange({ email: member.email, email_verified: true }, defaultMapping), 'disabled');
      } finally {
        await run(() => db.updateUser(String(member._id), { status: 'active' }));
      }
    });
  });

  describe('people of the host application (external accounts)', () => {
    it('are created on the first exchange and found again by their identity', async () => {
      const first = await exchange({ sub: 'emp-7', email: 'emp7@host.example.com', name: 'Emp Seven' }, provisioning);
      expect(first.principal).toMatchObject({ kind: 'external', created: true, matchedBy: 'created' });
      const user = first.principal.user;
      expect(user).toMatchObject({ kind: 'external', role: 'user', canLogin: false, name: 'Emp Seven', externalIds: { [ISSUER]: 'emp-7' } });

      const again = await exchange({ sub: 'emp-7', email: 'emp7@host.example.com', name: 'Emp Seven' }, provisioning);
      expect(again.principal).toMatchObject({ kind: 'external', created: false, matchedBy: 'externalId' });
      expect(String(again.principal.user._id)).toBe(String(user._id));
    });

    it('cannot sign in, are not members, and are counted on their own', async () => {
      const { principal } = await exchange({ sub: 'emp-8', email: 'emp8@host.example.com' }, provisioning);
      const user = principal.user;
      expect(isUserLoginBlocked(user)).toBe(true);
      expect(userKind(user)).toBe('external');
      // not a member of the workspace: out of the lists and pickers, and the address does not find them
      expect((await run(() => db.listUsers())).some((u) => String(u._id) === String(user._id))).toBe(false);
      expect((await accounts()).some((u) => String(u._id) === String(user._id))).toBe(true);
      expect(await run(() => db.findUserByEmail('emp8@host.example.com'))).toBeNull();
      expect(await run(() => db.countExternalUsers())).toBe(1);
    });

    it('follow the token: a new name or address is written, nothing else changes', async () => {
      const first = await exchange({ sub: 'emp-9', email: 'old@host.example.com', name: 'Old Name' }, provisioning);
      const next = await exchange({ sub: 'emp-9', email: 'new@host.example.com', name: 'New Name' }, provisioning);
      expect(String(next.principal.user._id)).toBe(String(first.principal.user._id));
      expect(next.principal.user).toMatchObject({ name: 'New Name', email: 'new@host.example.com', kind: 'external', role: 'user' });
    });

    it('are linked to a member at the first verified match when the portal matches by identity too, and then found by identity alone', async () => {
      const first = await exchange({ sub: 'ayse-1', email: member.email, email_verified: true }, both);
      expect(first.principal).toMatchObject({ kind: 'person', matchedBy: 'verifiedEmail' });
      expect((await stored(member))?.externalIds).toEqual({ [ISSUER]: 'ayse-1' });

      // the next token needs no address at all
      const next = await exchange({ sub: 'ayse-1' }, both);
      expect(String(next.principal.user._id)).toBe(String(member._id));
      expect(next.principal.matchedBy).toBe('externalId');

      // and nobody else of the issuer can take the member over by presenting the address
      await expectIdentityError(exchange({ sub: 'ayse-2', email: member.email, email_verified: true }, both), 'conflict');
    });
  });

  describe('owners and administrators are never signed in by a token', () => {
    it('refuses an administrator, by address, and leaves the account exactly as it was', async () => {
      const error = await exchange({ sub: 'boss-1', email: admin.email, email_verified: true }, both).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DelegatedAccountRefusal);
      expect((await stored(admin))?.externalIds).toBeUndefined();
    });

    it('refuses the workspace owner', async () => {
      const error = await exchange({ sub: 'founder-1', email: owner.email, email_verified: true }, both).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DelegatedAccountRefusal);
      expect((await stored(owner))?.externalIds).toBeUndefined();
    });

    it('refuses a member who is an administrator through a group', async () => {
      const error = await exchange({ sub: 'ops-1', email: groupAdmin.email, email_verified: true }, both).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DelegatedAccountRefusal);
      expect((await stored(groupAdmin))?.externalIds).toBeUndefined();
    });

    it('lets in a member whose group grants only service permissions', async () => {
      const { principal } = await exchange({ sub: 'perm-1', email: permitted.email, email_verified: true }, both);
      expect(String(principal.user._id)).toBe(String(permitted._id));
    });

    it('refuses an external account that an administrator has since put in a group that grants a workspace role', async () => {
      const { principal } = await exchange({ sub: 'emp-10', email: 'emp10@host.example.com' }, provisioning);
      const group = await run(async () => (await db.listGroups(tenantId)).find((g) => g.name === 'Ops admins')!);
      await run(() => db.addGroupMember({ tenantId, groupId: String(group._id), userId: String(principal.user._id), role: 'member', source: 'local' }));
      resetPrincipalCacheForTests();
      resetDelegatedIdentityCachesForTests();
      const error = await exchange({ sub: 'emp-10', email: 'emp10@host.example.com' }, provisioning).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DelegatedAccountRefusal);
    });
  });

  describe('groups of the host', () => {
    const groupMap = [{ idpGroup: 'staff', consoleGroupName: 'Support staff' }];
    const withGroups: DelegatedMapping = { ...provisioning, groupMap };

    it('follow the token, in groups created for the host\'s issuer', async () => {
      const first = await exchange({ sub: 'emp-11', groups: ['staff', 'unmapped'] }, withGroups);
      expect(first.principal.groups.added).toHaveLength(1);
      const created = (await run(() => db.listGroups(tenantId))).find((g) => g.name === 'Support staff');
      expect(created).toMatchObject({ source: 'delegated' });
      expect(await run(() => db.listGroupMembersByUser(String(first.principal.user._id)))).toEqual([
        expect.objectContaining({ groupId: String(created!._id), source: 'delegated' }),
      ]);

      // leaving the claim takes the person out
      resetDelegatedIdentityCachesForTests();
      const left = await exchange({ sub: 'emp-11', groups: [] }, withGroups);
      expect(left.principal.groups.removed).toEqual([String(created!._id)]);
      expect(await run(() => db.listGroupMembersByUser(String(first.principal.user._id)))).toEqual([]);
    });

    it('never touch a group an administrator made, whatever its name', async () => {
      const local = await run(() => mkGroup('Support staff'));
      const { principal } = await exchange({ sub: 'emp-12', groups: ['staff'] }, withGroups);
      expect(await run(() => db.listGroupMembers(String(local._id)))).toEqual([]);
      // the issuer's own group is a different group with the same name
      const members = await run(() => db.listGroupMembersByUser(String(principal.user._id)));
      expect(members).toHaveLength(1);
      expect(members[0]!.groupId).not.toBe(String(local._id));
    });
  });

  describe('the policy engine in the portal channel', () => {
    const portal = (access: Partial<PortalSubject['access']> = {}): PortalSubject => ({
      id: 'P1',
      key: PORTAL_KEY,
      access: { mode: 'selected', userIds: ['somebody-else'], groupIds: [], ...access },
    });
    const enter = async (user: IUser, subject: PortalSubject, context: { embedded?: boolean; ip?: string } = {}) => {
      const evaluated = await loadEvaluationPrincipal({ tenantDbName, tenantId }, { type: 'user', id: String(user._id) }, null, { workspaceLevel: true });
      return authorize({
        tenant: tenantDbName,
        principal: evaluated.principal,
        action: 'portal.use',
        resource: portalResource(subject),
        context: { channel: 'portal', ...context },
      });
    };

    it('admits a person of the host only when the portal says "anyone verified" and the runtime marks the request embedded', async () => {
      const { principal } = await exchange({ sub: 'emp-13', email: 'emp13@host.example.com' }, provisioning);
      const person = principal.user;

      // the access list decides by default: the person is not on it
      expect((await enter(person, portal(), { embedded: true })).allowed).toBe(false);
      // "anyone verified" admits them, but only on a request the portal runtime marked
      expect((await enter(person, portal({ embedded: 'any_verified' }), { embedded: true })).allowed).toBe(true);
      expect((await enter(person, portal({ embedded: 'any_verified' }))).allowed).toBe(false);
      // and the access list still admits a listed person
      expect((await enter(person, portal({ userIds: [String(person._id)] }), { embedded: true })).allowed).toBe(true);
    });

    it('applies the network boundary to them too', async () => {
      const { principal } = await exchange({ sub: 'emp-14', email: 'emp14@host.example.com' }, provisioning);
      const open = portal({ embedded: 'any_verified', networks: { mode: 'allow_list', cidrs: ['10.0.0.0/8'] } });
      expect((await enter(principal.user, open, { embedded: true, ip: '10.1.2.3' })).allowed).toBe(true);
      expect((await enter(principal.user, open, { embedded: true, ip: '8.8.8.8' })).allowed).toBe(false);
    });

    it('lets a group the issuer created carry the access: the person is admitted by the list of groups', async () => {
      const withGroups: DelegatedMapping = { ...provisioning, groupMap: [{ idpGroup: 'staff', consoleGroupName: 'Support staff' }] };
      const { principal } = await exchange({ sub: 'emp-15', groups: ['staff'] }, withGroups);
      const group = (await run(() => db.listGroups(tenantId))).find((g) => g.name === 'Support staff')!;
      expect((await enter(principal.user, portal({ groupIds: [String(group._id)] }), { embedded: true })).allowed).toBe(true);
      expect((await enter(principal.user, portal(), { embedded: true })).allowed).toBe(false);
    });
  });
});
