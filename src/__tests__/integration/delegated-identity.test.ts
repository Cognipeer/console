/**
 * From a verified identity to an account (src/lib/iam/delegatedIdentity.ts), on BOTH SQLite and MongoDB.
 *
 *   match order   the identity first, then a VERIFIED address (members only); an address is linked to the identity
 *                 once, and an account linked to another subject of the issuer is a conflict
 *   JIT           none refuses; person creates an ordinary person managed by the identity provider; external creates
 *                 an account of kind external - either counts toward the licence's user limit
 *   limits        a disabled account, a service account, an external account's address, an unverified address, a claimed
 *                 address that belongs to somebody else
 *   races         one new person arriving twice at once is one account; the loser of a cross-node race removes itself
 *   cache         an identity is remembered as a hint only: the account is read again and must still hold the identity
 *   groups        memberships follow the claim, only in groups created for the issuer, never in a local group
 *   audit         creating, linking and group changes are written with the issuer as the actor
 *   account guard the caller's rule about EXISTING accounts is asked before anything is written for them: no link,
 *                 no profile change, no group change for an account it refuses
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { DatabaseProvider, IGroup, IUser } from '@/lib/database';
import {
  DELEGATED_PASSWORD_PLACEHOLDER,
  DelegatedAccountRefusal,
  DelegatedIdentityError,
  invalidateDelegatedIdentityHints,
  resetDelegatedIdentityCachesForTests,
  resolveDelegatedPrincipal,
  validateDelegatedMapping,
  type DelegatedMapping,
} from '@/lib/iam/delegatedIdentity';
import { delegatedGroupExternalId, resetDelegatedGroupsForTests, validateGroupMap } from '@/lib/iam/delegatedGroups';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { isUserLoginBlocked } from '@/lib/services/users/userAuthState';
import { userKind } from '@/lib/iam/identity';
import { describeForEachProvider } from './db-parity.helper';

const ISSUER = 'https://idp.example.com/realms/acme';
const OTHER_ISSUER = 'https://other-idp.example.com';

async function expectCode(promise: Promise<unknown>, code: DelegatedIdentityError['code']) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error, `expected ${code}`).toBeInstanceOf(DelegatedIdentityError);
  expect((error as DelegatedIdentityError).code).toBe(code);
}

describeForEachProvider('delegated identity resolution', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  const run = <T,>(fn: () => Promise<T>): Promise<T> => db.runWithTenant!(tenantDbName, fn);

  let member: IUser;
  let admin: IUser;
  let disabledMember: IUser;
  let serviceAccount: IUser;

  const mapping = (patch: Partial<DelegatedMapping> = {}): DelegatedMapping => ({ matchBy: ['externalId', 'verifiedEmail'], jit: 'none', ...patch });
  const resolve = (claims: { subject?: string; issuer?: string; email?: string; emailVerified?: boolean; name?: string; groups?: string[] }, map: Partial<DelegatedMapping> = {}) =>
    resolveDelegatedPrincipal({
      tenantDbName, tenantId, issuer: ISSUER, subject: 'sub-1', ...claims, mapping: mapping(map),
    });
  const mkUser = (email: string, name: string, extra: Partial<IUser> = {}) =>
    db.createUser({ tenantId, email, name, password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [], ...extra });
  const accounts = () => run(() => db.listUsers({ includeExternal: true }));
  const auditEvents = async (event: string) => {
    await drainPendingTasks();
    return run(async () => (await db.listAuditLogs({ limit: 500 })).filter((row) => row.event === event));
  };

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `deleg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Delegated', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);
    await run(async () => {
      await db.createProject({ tenantId, key: 'default', name: 'Default', createdBy: 't' });
      member = await mkUser('Ayse@Intranet.Example.com', 'Ayse Member');
      admin = await mkUser('boss@intranet.example.com', 'Boss', { role: 'admin' });
      disabledMember = await mkUser('gone@intranet.example.com', 'Gone', { status: 'disabled' });
      serviceAccount = await mkUser('svc@intranet.example.com', 'Service', { canLogin: false });
    });
  });
  afterAll(() => {
    hoisted.getDatabase.mockReset();
  });
  beforeEach(async () => {
    resetDelegatedIdentityCachesForTests();
    resetDelegatedGroupsForTests();
    resetProjectNarrowingCachesForTests();
    // every test starts from the four accounts above, unlinked
    await run(async () => {
      for (const user of await db.listUsers({ includeExternal: true })) {
        if (user.kind === 'external' || (user.authProvider === 'oidc' && ![member, admin, disabledMember, serviceAccount].some((k) => String(k._id) === String(user._id)))) {
          await db.deleteUser(String(user._id));
        } else {
          await db.updateUser(String(user._id), {
            ...(user.externalIds ? { externalIds: {} } : {}),
            status: String(user._id) === String(disabledMember._id) ? 'disabled' : 'active',
          });
        }
      }
      for (const group of await db.listGroups(tenantId)) {
        if (group.source === 'delegated') {
          await db.deleteGroupMembersByGroup(String(group._id));
          await db.deleteGroup(String(group._id));
        }
      }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('matching', () => {
    it('finds the account that holds the identity, and the identity wins over an address', async () => {
      await run(() => db.updateUser(String(member._id), { externalIds: { [ISSUER]: 'sub-1' } }));
      // another member owns the claimed address - it must not matter once the identity matches
      const result = await resolve({ email: admin.email, emailVerified: true });
      expect(String(result.user._id)).toBe(String(member._id));
      expect(result).toMatchObject({ kind: 'person', created: false, matchedBy: 'externalId', issuer: ISSUER, subject: 'sub-1' });
    });

    it('matches a member by a VERIFIED address (whatever the case), and records the link', async () => {
      const first = await resolve({ email: 'AYSE@intranet.example.com', emailVerified: true });
      expect(String(first.user._id)).toBe(String(member._id));
      expect(first).toMatchObject({ created: false, matchedBy: 'verifiedEmail', kind: 'person' });
      expect(first.user.externalIds).toEqual({ [ISSUER]: 'sub-1' });
      expect((await run(() => db.findUserById(String(member._id))))?.externalIds).toEqual({ [ISSUER]: 'sub-1' });

      // the next time the identity is enough - no address, or another one
      const second = await resolve({});
      expect(second).toMatchObject({ matchedBy: 'externalId' });
      expect(String(second.user._id)).toBe(String(member._id));
      const third = await resolve({ email: 'someone-else@example.com', emailVerified: true });
      expect(String(third.user._id)).toBe(String(member._id));
    });

    it('does not match an address the issuer did not verify', async () => {
      await expectCode(resolve({ email: member.email }), 'unknown_principal');
      await expectCode(resolve({ email: member.email, emailVerified: false }), 'unknown_principal');
      expect((await run(() => db.findUserById(String(member._id))))?.externalIds).toBeUndefined();
    });

    it('matches an address without email_verified only when the mapping trusts the issuer\'s emails', async () => {
      await expectCode(resolve({ email: member.email }, { trustEmails: false }), 'unknown_principal');
      const trusted = await resolve({ email: member.email }, { trustEmails: true });
      expect(trusted).toMatchObject({ matchedBy: 'verifiedEmail' });
      expect(String(trusted.user._id)).toBe(String(member._id));
    });

    it('with only externalId enabled an address is never looked at; with only verifiedEmail nothing is linked', async () => {
      await expectCode(resolve({ email: member.email, emailVerified: true }, { matchBy: ['externalId'] }), 'unknown_principal');
      const byEmail = await resolve({ email: member.email, emailVerified: true }, { matchBy: ['verifiedEmail'] });
      expect(String(byEmail.user._id)).toBe(String(member._id));
      expect((await run(() => db.findUserById(String(member._id))))?.externalIds).toBeUndefined();
      // and the identity alone is not enough then
      await expectCode(resolve({}, { matchBy: ['verifiedEmail'] }), 'unknown_principal');
    });

    it('refuses to move an account to another subject of the same issuer', async () => {
      await resolve({ email: member.email, emailVerified: true });
      await expectCode(resolve({ subject: 'sub-2', email: member.email, emailVerified: true }), 'conflict');
      expect((await run(() => db.findUserById(String(member._id))))?.externalIds).toEqual({ [ISSUER]: 'sub-1' });
      // a second issuer is another identity of the same person
      const other = await resolve({ issuer: OTHER_ISSUER, subject: 'abc', email: member.email, emailVerified: true });
      expect(String(other.user._id)).toBe(String(member._id));
      expect(other.user.externalIds).toEqual({ [ISSUER]: 'sub-1', [OTHER_ISSUER]: 'abc' });
    });

    it('keeps issuers apart: the same subject at two issuers is two identities', async () => {
      const a = await resolve({}, { jit: 'external' });
      const b = await resolve({ issuer: OTHER_ISSUER }, { jit: 'external' });
      expect(String(a.user._id)).not.toBe(String(b.user._id));
    });

    it('does not treat a service account as a person an issuer can vouch for', async () => {
      await expectCode(resolve({ email: serviceAccount.email, emailVerified: true }), 'unknown_principal');
      await run(() => db.updateUser(String(serviceAccount._id), { externalIds: { [ISSUER]: 'sub-1' } }));
      resetDelegatedIdentityCachesForTests();
      await expectCode(resolve({}), 'unknown_principal');
    });

    it('never finds an external account by address', async () => {
      const external = await resolve({ subject: 'twin', email: member.email, name: 'Twin' }, { jit: 'external' });
      expect(external.created).toBe(true);
      const viaEmail = await resolve({ subject: 'other', email: member.email, emailVerified: true });
      expect(String(viaEmail.user._id)).toBe(String(member._id));
      expect(String(viaEmail.user._id)).not.toBe(String(external.user._id));
    });

    it('refuses a disabled account, by address (and links nothing) or by identity', async () => {
      await expectCode(resolve({ email: disabledMember.email, emailVerified: true }), 'disabled');
      expect((await run(() => db.findUserById(String(disabledMember._id))))?.externalIds).toBeUndefined();
      // (linked behind the resolver's back, as another node would: its short memory of "nobody holds this" is forgotten)
      await run(() => db.updateUser(String(member._id), { externalIds: { [ISSUER]: 'sub-1' } }));
      resetDelegatedIdentityCachesForTests();
      await resolve({});
      await run(() => db.updateUser(String(member._id), { status: 'disabled' }));
      await expectCode(resolve({}), 'disabled');
    });

    it('leaves a member\'s own profile alone', async () => {
      await resolve({ email: member.email, emailVerified: true, name: 'Someone Else' });
      await resolve({ name: 'Another Name' });
      expect(await run(() => db.findUserById(String(member._id)))).toMatchObject({ name: 'Ayse Member', email: member.email });
    });

    it('says who the account is without deciding what it may do (an admin resolves like anybody unless the caller passes an account guard)', async () => {
      const result = await resolve({ email: admin.email, emailVerified: true });
      expect(result.user.role).toBe('admin');
    });

    it('rejects input and mappings it cannot use', async () => {
      await expectCode(resolve({ subject: '' }), 'unknown_principal');
      await expectCode(resolve({ issuer: '' }), 'unknown_principal');
      await expectCode(resolve({ subject: 'x'.repeat(513) }), 'unknown_principal');
      await expectCode(resolve({}, { matchBy: [] }), 'unknown_principal');
      await expectCode(resolve({}, { jit: 'everybody' as never }), 'unknown_principal');
      await expectCode(resolve({}, { matchBy: ['externalId', 'externalId'] }), 'unknown_principal');
      expect(validateDelegatedMapping(mapping())).toEqual([]);
      expect(validateDelegatedMapping(null)).toHaveLength(1);
    });

    it('finds the workspace itself when the caller does not pass its id, and refuses an id that does not belong to the database', async () => {
      // the frozen contract names the database only
      const viaDatabaseName = await resolveDelegatedPrincipal({ tenantDbName, issuer: ISSUER, subject: 'no-id', mapping: mapping({ jit: 'external' }) });
      expect(viaDatabaseName.created).toBe(true);
      expect(String(viaDatabaseName.user.tenantId)).toBe(tenantId);
      await expect(resolveDelegatedPrincipal({ tenantDbName, tenantId: 'not-this-workspace', issuer: ISSUER, subject: 'sub-1', mapping: mapping() })).rejects.toThrow();
    });
  });

  describe('provisioning an external account', () => {
    it('creates one on the first arrival and finds it again', async () => {
      const first = await resolve({ email: 'visitor@host.example.com', name: 'Vera Visitor' }, { jit: 'external' });
      expect(first).toMatchObject({ created: true, kind: 'external', matchedBy: 'created' });
      expect(first.user).toMatchObject({
        kind: 'external', role: 'user', canLogin: false, name: 'Vera Visitor', email: 'visitor@host.example.com',
        password: DELEGATED_PASSWORD_PLACEHOLDER, externalIds: { [ISSUER]: 'sub-1' },
      });
      expect(isUserLoginBlocked(first.user)).toBe(true);
      expect(userKind(first.user)).toBe('external');

      const second = await resolve({ email: 'visitor@host.example.com', name: 'Vera Visitor' }, { jit: 'external' });
      expect(second).toMatchObject({ created: false, kind: 'external', matchedBy: 'externalId' });
      expect(String(second.user._id)).toBe(String(first.user._id));
      expect(await run(() => db.countExternalUsers())).toBe(1);
      // it stays out of the people lists and cannot be found by address
      expect((await run(() => db.listUsers())).some((u) => String(u._id) === String(first.user._id))).toBe(false);
      expect(await run(() => db.findUserByEmail('visitor@host.example.com'))).toBeNull();
    });

    it('works without a name or an address: the subject is the name', async () => {
      const result = await resolve({ subject: 'employee-4711' }, { jit: 'external' });
      expect(result.user).toMatchObject({ name: 'employee-4711', email: '', kind: 'external' });
    });

    it('follows the assertion: a new name or address is written, nothing else changes', async () => {
      const first = await resolve({ email: 'v@host.example.com', name: 'V One' }, { jit: 'external' });
      const next = await resolve({ email: 'v2@host.example.com', name: 'V Two' }, { jit: 'external' });
      expect(String(next.user._id)).toBe(String(first.user._id));
      expect(next.user).toMatchObject({ name: 'V Two', email: 'v2@host.example.com', role: 'user', canLogin: false });
      // an assertion without them leaves the profile alone
      const bare = await resolve({}, { jit: 'external' });
      expect(bare.user).toMatchObject({ name: 'V Two', email: 'v2@host.example.com' });
    });

    it('uses an unverified address as a label only', async () => {
      const result = await resolve({ email: 'claimed@host.example.com', emailVerified: false }, { jit: 'external' });
      expect(result.user.email).toBe('claimed@host.example.com');
      expect(await run(() => db.findUserByEmail('claimed@host.example.com'))).toBeNull();
    });

    it('survives two arrivals at once: one account', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => resolve({ subject: 'race', name: 'Racer' }, { jit: 'external' })));
      expect(new Set(results.map((r) => String(r.user._id))).size).toBe(1);
      expect((await accounts()).filter((u) => u.externalIds?.[ISSUER] === 'race')).toHaveLength(1);
    });

    it('lets the oldest account win a race between two nodes: the later one removes itself', async () => {
      // the other node already created the account...
      const rival = await run(() => db.createUser({
        tenantId, email: '', name: 'Rival', password: DELEGATED_PASSWORD_PLACEHOLDER, role: 'user', licenseId: 'FREE', features: [],
        canLogin: false, kind: 'external', externalIds: { [ISSUER]: 'cross-node' },
      }));
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
      // ...but this node's first look did not see it yet
      const real = db.findUsersByExternalIdentity.bind(db);
      let blind = 1;
      vi.spyOn(db, 'findUsersByExternalIdentity').mockImplementation(async (issuer, subject) => (blind-- > 0 ? [] : real(issuer, subject)));
      const result = await resolve({ subject: 'cross-node', name: 'Latecomer' }, { jit: 'external' });
      expect(String(result.user._id)).toBe(String(rival._id));
      expect(result.created).toBe(false);
      expect((await accounts()).filter((u) => u.externalIds?.[ISSUER] === 'cross-node')).toHaveLength(1);
    });
  });

  describe('provisioning a person', () => {
    it('creates an ordinary person managed by the identity provider, for a verified address', async () => {
      const result = await resolve({ subject: 'p-1', email: 'new.person@example.com', emailVerified: true, name: 'New Person' }, { jit: 'person', matchBy: ['externalId'] });
      expect(result).toMatchObject({ created: true, kind: 'person', matchedBy: 'created' });
      expect(result.user).toMatchObject({
        email: 'new.person@example.com', name: 'New Person', role: 'user', authProvider: 'oidc', canLogin: true,
        password: DELEGATED_PASSWORD_PLACEHOLDER, externalIds: { [ISSUER]: 'p-1' },
      });
      expect(result.user.kind).toBeUndefined();
      // a person is found by address like anybody, and appears in the member lists
      expect(String((await run(() => db.findUserByEmail('new.person@example.com')))?._id)).toBe(String(result.user._id));
      expect((await run(() => db.listUsers())).some((u) => String(u._id) === String(result.user._id))).toBe(true);
      // found again by identity
      const again = await resolve({ subject: 'p-1' }, { jit: 'person', matchBy: ['externalId'] });
      expect(again).toMatchObject({ created: false, matchedBy: 'externalId' });
      expect(String(again.user._id)).toBe(String(result.user._id));
    });

    it('needs a verified address, and an address nobody holds', async () => {
      await expectCode(resolve({ subject: 'p-2' }, { jit: 'person' }), 'unknown_principal');
      await expectCode(resolve({ subject: 'p-2', email: 'x@example.com' }, { jit: 'person' }), 'unknown_principal');
      await expectCode(resolve({ subject: 'p-2', email: 'x@example.com', emailVerified: false }, { jit: 'person' }), 'unknown_principal');
      // the address of an existing member, found only by identity: creating a twin would be a takeover
      await expectCode(resolve({ subject: 'p-2', email: member.email, emailVerified: true }, { jit: 'person', matchBy: ['externalId'] }), 'conflict');
      expect((await accounts()).filter((u) => u.externalIds?.[ISSUER] === 'p-2')).toHaveLength(0);
    });

    it('prefers linking an existing member to creating a person', async () => {
      const result = await resolve({ subject: 'p-3', email: member.email, emailVerified: true }, { jit: 'person' });
      expect(result).toMatchObject({ created: false, matchedBy: 'verifiedEmail' });
      expect(String(result.user._id)).toBe(String(member._id));
    });
  });

  describe('the licence user limit', () => {
    let limitedTenant: string;
    let limitedDb: string;
    const limited = (claims: { subject: string; email?: string; emailVerified?: boolean }, map: Partial<DelegatedMapping>) =>
      resolveDelegatedPrincipal({ tenantDbName: limitedDb, tenantId: limitedTenant, issuer: ISSUER, ...claims, mapping: mapping(map) });

    beforeAll(async () => {
      const slug = `limit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      limitedDb = `tenant_${slug}`;
      const row = await db.createTenant({ companyName: 'Limited', slug, dbName: limitedDb, licenseType: 'FREE', ownerId: 'pending' });
      limitedTenant = String(row._id);
      await db.runWithTenant!(limitedDb, async () => {
        const project = await db.createProject({ tenantId: limitedTenant, key: 'default', name: 'Default', createdBy: 't' });
        await db.createUser({ tenantId: limitedTenant, email: 'owner@limited.example.com', name: 'Owner', password: 'x', role: 'owner', licenseId: 'FREE', features: [] });
        await db.createUser({ tenantId: limitedTenant, email: 'second@limited.example.com', name: 'Second', password: 'x', role: 'user', licenseId: 'FREE', features: [] });
        // two people, a limit of three: room for exactly one more
        await db.createQuotaPolicy({
          tenantId: limitedTenant, projectId: String(project._id), scope: 'tenant', domain: 'global', priority: 0, enabled: true,
          limits: { quotas: { maxUsers: 3 } },
        });
      });
    });

    it('counts a created account toward the limit, whichever kind, and refuses past it', async () => {
      const first = await limited({ subject: 'seat-1' }, { jit: 'external' });
      expect(first.created).toBe(true);
      await expectCode(limited({ subject: 'seat-2' }, { jit: 'external' }), 'seat_limit');
      await expectCode(limited({ subject: 'seat-3', email: 'p@limited.example.com', emailVerified: true }, { jit: 'person' }), 'seat_limit');
      // nothing was created by the refusals
      const count = await db.runWithTenant!(limitedDb, async () => (await db.listUsers({ includeExternal: true })).length);
      expect(count).toBe(3);
    });

    it('still lets in an account that already exists', async () => {
      const again = await limited({ subject: 'seat-1' }, { jit: 'external' });
      expect(again).toMatchObject({ created: false, kind: 'external' });
      const byEmail = await limited({ subject: 'seat-9', email: 'second@limited.example.com', emailVerified: true }, { jit: 'none' });
      expect(byEmail.created).toBe(false);
    });
  });

  describe('what the lookup remembers', () => {
    it('serves a known identity from a hint, but always re-reads the account', async () => {
      const first = await resolve({ subject: 'hint-1', name: 'Hinted' }, { jit: 'external' });
      const spy = vi.spyOn(db, 'findUsersByExternalIdentity');
      const second = await resolve({ subject: 'hint-1' }, { jit: 'external' });
      expect(String(second.user._id)).toBe(String(first.user._id));
      expect(spy).not.toHaveBeenCalled();

      // the account is deleted: the hint does not bring it back
      await run(() => db.deleteUser(String(first.user._id)));
      const third = await resolve({ subject: 'hint-1', name: 'Hinted' }, { jit: 'external' });
      expect(third.created).toBe(true);
      expect(String(third.user._id)).not.toBe(String(first.user._id));
    });

    it('drops a hint whose account no longer holds the identity, or is disabled', async () => {
      const first = await resolve({ subject: 'hint-2' }, { jit: 'external' });
      await run(() => db.updateUser(String(first.user._id), { externalIds: { [ISSUER]: 'moved-away' } }));
      const second = await resolve({ subject: 'hint-2' }, { jit: 'external' });
      expect(second.created).toBe(true);
      expect(String(second.user._id)).not.toBe(String(first.user._id));

      await run(() => db.updateUser(String(second.user._id), { status: 'disabled' }));
      await expectCode(resolve({ subject: 'hint-2' }, { jit: 'external' }), 'disabled');
    });

    it('forgets the hints of a workspace on request', async () => {
      await resolve({ subject: 'hint-3' }, { jit: 'external' });
      invalidateDelegatedIdentityHints(tenantDbName);
      const spy = vi.spyOn(db, 'findUsersByExternalIdentity');
      await resolve({ subject: 'hint-3' }, { jit: 'external' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('lets a hint expire', async () => {
      await resolve({ subject: 'hint-4' }, { jit: 'external' });
      const spy = vi.spyOn(db, 'findUsersByExternalIdentity');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await resolve({ subject: 'hint-4' }, { jit: 'external' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('remembers for a short while that nobody holds an identity: the scan is skipped, nothing else is', async () => {
      await expectCode(resolve({ subject: 'nobody-1' }), 'unknown_principal');
      const spy = vi.spyOn(db, 'findUsersByExternalIdentity');
      // asked again and again: still nobody, and no scan of the workspace's accounts
      for (let i = 0; i < 3; i += 1) await expectCode(resolve({ subject: 'nobody-1' }), 'unknown_principal');
      expect(spy).not.toHaveBeenCalled();
      // another identity is another question
      await expectCode(resolve({ subject: 'nobody-2' }), 'unknown_principal');
      expect(spy).toHaveBeenCalledTimes(1);

      // a verified address is still tried while the miss is remembered, and links the member: the identity is held from then on
      const linked = await resolve({ subject: 'nobody-1', email: member.email, emailVerified: true });
      expect(String(linked.user._id)).toBe(String(member._id));
      expect(linked.matchedBy).toBe('verifiedEmail');
      expect((await resolve({ subject: 'nobody-1' })).user).toMatchObject({ _id: member._id });
    });

    it('believes a miss only for a few seconds', async () => {
      await expectCode(resolve({ subject: 'late-1' }), 'unknown_principal');
      // an account that holds the identity appears (made on another node, say)
      const other = await run(() => mkUser('late@intranet.example.com', 'Late', { externalIds: { [ISSUER]: 'late-1' } }));
      await expectCode(resolve({ subject: 'late-1' }), 'unknown_principal');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31_000);
      expect(String((await resolve({ subject: 'late-1' })).user._id)).toBe(String(other._id));
    });

    it('does not keep out a person it is asked to create, and forgets the miss once the account is there', async () => {
      await expectCode(resolve({ subject: 'make-1' }), 'unknown_principal');
      // the same identity under a mapping that creates accounts: created at once, the miss is no obstacle
      const created = await resolve({ subject: 'make-1', name: 'Made' }, { jit: 'external' });
      expect(created).toMatchObject({ created: true, kind: 'external' });
      const spy = vi.spyOn(db, 'findUsersByExternalIdentity');
      const again = await resolve({ subject: 'make-1' });
      expect(String(again.user._id)).toBe(String(created.user._id));
      expect(spy).not.toHaveBeenCalled(); // (served from the hint now)
    });

    it('forgets the misses of a workspace on request, like the hints', async () => {
      await expectCode(resolve({ subject: 'forget-1' }), 'unknown_principal');
      invalidateDelegatedIdentityHints(tenantDbName);
      const spy = vi.spyOn(db, 'findUsersByExternalIdentity');
      await expectCode(resolve({ subject: 'forget-1' }), 'unknown_principal');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('remembers who holds an identity even when the call is refused: a disabled person costs no scan on the next call', async () => {
      await run(() => db.updateUser(String(disabledMember._id), { externalIds: { [ISSUER]: 'gone-1' } }));
      const spy = vi.spyOn(db, 'findUsersByExternalIdentity');
      await expectCode(resolve({ subject: 'gone-1' }), 'disabled');
      expect(spy).toHaveBeenCalledTimes(1);
      await expectCode(resolve({ subject: 'gone-1' }), 'disabled');
      await expectCode(resolve({ subject: 'gone-1' }), 'disabled');
      expect(spy).toHaveBeenCalledTimes(1);
      // (and the account is read again every time: re-enabled, it is let in at once)
      await run(() => db.updateUser(String(disabledMember._id), { status: 'active' }));
      expect(String((await resolve({ subject: 'gone-1' })).user._id)).toBe(String(disabledMember._id));
    });
  });

  describe('audit', () => {
    it('records an account created for an identity and a link, with the issuer as the actor', async () => {
      const created = await resolve({ subject: 'aud-1', name: 'Audited' }, { jit: 'external' });
      const linked = await resolve({ subject: 'aud-2', email: member.email, emailVerified: true });
      const jit = await auditEvents('user.jit.create');
      const link = await auditEvents('user.identity.link');
      expect(jit.find((row) => row.resourceId === String(created.user._id))).toMatchObject({
        actorType: 'system', actorUserId: `delegated:${ISSUER}`, resourceType: 'user', outcome: 'success', metadata: { issuer: ISSUER, kind: 'external' },
      });
      expect(link.find((row) => row.resourceId === String(linked.user._id))).toMatchObject({
        actorType: 'system', actorUserId: `delegated:${ISSUER}`, metadata: { issuer: ISSUER, via: 'verified_email' },
      });
    });
  });

  describe('groups', () => {
    const gmap = [
      { idpGroup: 'sales', consoleGroupName: 'Sales (verified)' },
      { idpGroup: 'support', consoleGroupName: 'Support (verified)' },
    ];
    const memberships = (userId: string) => run(async () => {
      const rows = await db.listGroupMembersByUser(userId);
      const named: Array<[string, string]> = [];
      for (const row of rows) named.push([(await db.findGroupById(String(row.groupId)))?.name ?? '?', row.source ?? 'local']);
      return named.sort();
    });
    const groupNamed = (name: string, issuer = ISSUER) =>
      run(() => db.findGroupByExternalId(delegatedGroupExternalId(issuer, name)));

    it('creates the groups for the issuer the first time and puts the person in the ones the claim names', async () => {
      const result = await resolve({ groups: ['sales', 'unmapped'] }, { jit: 'external', groupMap: gmap });
      expect(await memberships(String(result.user._id))).toEqual([['Sales (verified)', 'delegated']]);
      expect(result.groups.added).toHaveLength(1);
      const group = (await groupNamed('Sales (verified)')) as IGroup;
      expect(group).toMatchObject({ name: 'Sales (verified)', source: 'delegated', externalId: delegatedGroupExternalId(ISSUER, 'Sales (verified)') });
      expect(group.tenantRole).toBeFalsy();
      expect(Object.keys(group.servicePermissions ?? {})).toHaveLength(0);
      // a group nobody was claimed into is not created
      expect(await groupNamed('Support (verified)')).toBeNull();
    });

    it('follows the claim: leaving it removes the membership, entering it adds', async () => {
      const first = await resolve({ groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      resetDelegatedIdentityCachesForTests();
      const second = await resolve({ groups: ['support'] }, { jit: 'external', groupMap: gmap });
      expect(second.groups.added).toHaveLength(1);
      expect(second.groups.removed).toEqual(first.groups.added);
      expect(await memberships(String(second.user._id))).toEqual([['Support (verified)', 'delegated']]);
      resetDelegatedIdentityCachesForTests();
      const none = await resolve({ groups: [] }, { jit: 'external', groupMap: gmap });
      expect(none.groups.removed).toHaveLength(1);
      expect(await memberships(String(none.user._id))).toEqual([]);
    });

    it('does nothing while the claim is unchanged, and does not touch groups when no map is configured', async () => {
      await resolve({ groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      const spy = vi.spyOn(db, 'listGroupMembersByUser');
      const again = await resolve({ groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      expect(again.groups).toEqual({ added: [], removed: [], skipped: [] });
      expect(spy).not.toHaveBeenCalled();
      const unmapped = await resolve({ subject: 'no-map', groups: ['sales'] }, { jit: 'external' });
      expect(unmapped.groups).toEqual({ added: [], removed: [], skipped: [] });
      expect(await memberships(String(unmapped.user._id))).toEqual([]);
    });

    it('looks at an unchanged claim again after a while: a membership that was lost is put back', async () => {
      const first = await resolve({ groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      const groupId = first.groups.added[0];
      await run(() => db.removeGroupMember(groupId, String(first.user._id)));
      // inside the interval the claim is taken as handled
      const soon = await resolve({ groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      expect(soon.groups.added).toEqual([]);
      expect(await memberships(String(first.user._id))).toEqual([]);
      // after it, the groups are brought in step again
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const later = await resolve({ groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      expect(later.groups.added).toEqual([groupId]);
      expect(await memberships(String(first.user._id))).toEqual([['Sales (verified)', 'delegated']]);
    });

    it('never fills or empties a local group, whatever its name; groups of other issuers stay as they are', async () => {
      const local = await run(() => db.createGroup({ tenantId, name: 'Sales (verified)', createdBy: 't', source: 'local' }));
      const result = await resolve({ email: member.email, emailVerified: true, groups: ['sales'] }, { groupMap: gmap });
      const userId = String(result.user._id);
      // a local membership of the person survives every sync, and the local group of the same name got nobody
      await run(() => db.addGroupMember({ tenantId, groupId: String(local._id), userId, role: 'member', source: 'local' }));
      const other = await run(() => db.createGroup({ tenantId, name: 'Sales (verified)', createdBy: 't', source: 'delegated', externalId: delegatedGroupExternalId(OTHER_ISSUER, 'Sales (verified)') }));
      await run(() => db.addGroupMember({ tenantId, groupId: String(other._id), userId, role: 'member', source: 'delegated' }));
      resetDelegatedIdentityCachesForTests();
      const second = await resolve({ groups: [] }, { groupMap: gmap });
      expect(second.groups.removed).toHaveLength(1);
      const names = await run(async () => (await db.listGroupMembersByUser(userId)).map((m) => String(m.groupId)).sort());
      expect(names).toEqual([String(local._id), String(other._id)].sort());
      await run(async () => {
        await db.removeGroupMember(String(local._id), userId);
        await db.removeGroupMember(String(other._id), userId);
        await db.deleteGroup(String(local._id));
        await db.deleteGroup(String(other._id));
      });
    });

    it('does not fill a group that has been given grants', async () => {
      await resolve({ subject: 'g-0', groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      const group = (await groupNamed('Sales (verified)')) as IGroup;
      await run(() => db.updateGroup(String(group._id), { tenantRole: 'admin' }));
      const next = await resolve({ subject: 'g-1', groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      expect(next.groups.skipped).toEqual([{ group: 'Sales (verified)', reason: 'grants_access' }]);
      expect(await memberships(String(next.user._id))).toEqual([]);
      await run(() => db.updateGroup(String(group._id), { tenantRole: undefined as never }));
    });

    it('writes the changes to the audit trail as the issuer', async () => {
      const first = await resolve({ subject: 'g-audit', groups: ['sales'] }, { jit: 'external', groupMap: gmap });
      resetDelegatedIdentityCachesForTests();
      await resolve({ subject: 'g-audit', groups: [] }, { jit: 'external', groupMap: gmap });
      const groupId = first.groups.added[0];
      const added = (await auditEvents('group.member.add')).find((row) => row.resourceId === groupId);
      const removed = (await auditEvents('group.member.remove')).find((row) => row.resourceId === groupId);
      expect(added).toMatchObject({ actorType: 'system', actorUserId: `delegated:${ISSUER}`, resourceType: 'group', metadata: { userId: String(first.user._id), issuer: ISSUER } });
      expect(removed).toMatchObject({ actorType: 'system', actorUserId: `delegated:${ISSUER}` });
      expect((await auditEvents('group.jit.create')).some((row) => row.resourceId === groupId)).toBe(true);
    });

    it('creates a group once when two people arrive together', async () => {
      await Promise.all(['a', 'b', 'c'].map((subject) => resolve({ subject: `g-${subject}`, groups: ['support'] }, { jit: 'external', groupMap: gmap })));
      const groups = (await run(() => db.listGroups(tenantId))).filter((g) => g.externalId === delegatedGroupExternalId(ISSUER, 'Support (verified)'));
      expect(groups).toHaveLength(1);
    });

    it('checks the group map', () => {
      expect(validateGroupMap(gmap)).toEqual([]);
      expect(validateGroupMap('x')).toHaveLength(1);
      expect(validateGroupMap([{ idpGroup: '', consoleGroupName: 'A' }])).not.toEqual([]);
      expect(validateGroupMap([{ idpGroup: 'a', consoleGroupName: ' padded ' }])).not.toEqual([]);
      expect(validateGroupMap([{ idpGroup: 'a', consoleGroupName: 'A' }, { idpGroup: 'a', consoleGroupName: 'B' }])).not.toEqual([]);
      expect(validateGroupMap(Array.from({ length: 101 }, (_, i) => ({ idpGroup: `g${i}`, consoleGroupName: `G${i}` })))).toHaveLength(1);
    });
  });

  describe('the caller\'s rule about existing accounts (accountGuard)', () => {
    const gmap = [{ idpGroup: 'sales', consoleGroupName: 'Sales (verified)' }];
    const refuseAdmins = (asked: string[] = []) => ({
      key: 'no-admins',
      check: async (user: IUser) => {
        asked.push(String(user._id));
        if (user.role === 'admin') throw new DelegatedAccountRefusal('no administrators');
      },
    });
    const anybody = (asked: string[] = []) => ({
      key: 'anybody',
      check: async (user: IUser) => {
        asked.push(String(user._id));
      },
    });
    const resolveWith = (
      accountGuard: { key: string; check: (user: IUser) => Promise<void> } | undefined,
      claims: { subject?: string; email?: string; emailVerified?: boolean; groups?: string[] },
      map: Partial<DelegatedMapping> = {},
    ) => resolveDelegatedPrincipal({ tenantDbName, tenantId, issuer: ISSUER, subject: 'sub-1', ...claims, mapping: mapping(map), accountGuard });
    const stored = (user: IUser) => run(() => db.findUserById(String(user._id)));
    const delegatedGroups = async () => (await run(() => db.listGroups(tenantId))).filter((group) => group.source === 'delegated');

    it('refuses an account found by address BEFORE it is linked to the identity', async () => {
      const linksOf = async (user: IUser) => (await auditEvents('user.identity.link')).filter((row) => row.resourceId === String(user._id)).length;
      const linksBefore = await linksOf(admin);
      await expect(resolveWith(refuseAdmins(), { email: admin.email, emailVerified: true })).rejects.toBeInstanceOf(DelegatedAccountRefusal);
      expect((await stored(admin))?.externalIds ?? {}).toEqual({});
      expect(await linksOf(admin)).toBe(linksBefore);
      // without the rule the same call links, as it always did
      await resolveWith(undefined, { email: admin.email, emailVerified: true });
      expect((await stored(admin))?.externalIds).toEqual({ [ISSUER]: 'sub-1' });
    });

    it('refuses an account found by identity BEFORE its groups follow the claim', async () => {
      await run(() => db.updateUser(String(admin._id), { externalIds: { [ISSUER]: 'sub-1' } }));
      const addsOf = async (user: IUser) => (await auditEvents('group.member.add')).filter((row) => (row.metadata as { userId?: string } | undefined)?.userId === String(user._id)).length;
      const addsBefore = await addsOf(admin);
      await expect(resolveWith(refuseAdmins(), { groups: ['sales'] }, { groupMap: gmap })).rejects.toBeInstanceOf(DelegatedAccountRefusal);
      expect(await run(() => db.listGroupMembersByUser(String(admin._id)))).toHaveLength(0);
      expect(await delegatedGroups()).toHaveLength(0);
      expect(await addsOf(admin)).toBe(addsBefore);
    });

    it('refuses an external account\'s profile update too: nothing is rewritten for a refused account', async () => {
      const external = await resolveWith(undefined, { subject: 'ext-1', email: 'first@host.example.com' }, { jit: 'external' });
      resetDelegatedIdentityCachesForTests();
      const refuseEveryone = { key: 'nobody', check: async () => { throw new DelegatedAccountRefusal('nobody'); } };
      await expect(resolveWith(refuseEveryone, { subject: 'ext-1', email: 'second@host.example.com' }, { jit: 'external' })).rejects.toBeInstanceOf(DelegatedAccountRefusal);
      expect((await stored(external.user))?.email).toBe('first@host.example.com');
    });

    it('asks once, with the account that was found, and lets an accepted account through exactly as before', async () => {
      const asked: string[] = [];
      const result = await resolveWith(refuseAdmins(asked), { email: member.email, emailVerified: true });
      expect(String(result.user._id)).toBe(String(member._id));
      expect(result.matchedBy).toBe('verifiedEmail');
      // (the address path continues into the matched-account step, which must not ask a second time)
      expect(asked).toEqual([String(member._id)]);
      expect((await stored(member))?.externalIds).toEqual({ [ISSUER]: 'sub-1' });
    });

    it('asks on every call, also when the identity is served from the hint of an earlier one', async () => {
      await run(() => db.updateUser(String(admin._id), { externalIds: { [ISSUER]: 'sub-1' } }));
      await resolveWith(anybody(), {}); // remembered
      await expect(resolveWith(refuseAdmins(), {})).rejects.toBeInstanceOf(DelegatedAccountRefusal);
    });

    it('does not ask about an account it has just created, and asks about it afterwards', async () => {
      const asked: string[] = [];
      const guard = refuseAdmins(asked);
      const created = await resolveWith(guard, { subject: 'brand-new' }, { jit: 'external' });
      expect(created.created).toBe(true);
      expect(asked).toEqual([]);
      const again = await resolveWith(guard, { subject: 'brand-new' }, { jit: 'external' });
      expect(again.created).toBe(false);
      expect(asked).toEqual([String(created.user._id)]);
    });

    it('asks about the account that won a race between two nodes, which is an existing account', async () => {
      const rival = await run(() => db.createUser({
        tenantId, email: 'rival-admin@intranet.example.com', name: 'Rival Admin', password: '$2b$10$x', role: 'admin', licenseId: 'FREE', features: [],
        externalIds: { [ISSUER]: 'cross-node-guard' },
      }));
      try {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        const real = db.findUsersByExternalIdentity.bind(db);
        let blind = 1;
        vi.spyOn(db, 'findUsersByExternalIdentity').mockImplementation(async (issuer, subject) => (blind-- > 0 ? [] : real(issuer, subject)));
        await expect(resolveWith(refuseAdmins(), { subject: 'cross-node-guard' }, { jit: 'external' })).rejects.toBeInstanceOf(DelegatedAccountRefusal);
        // the account this node made for nothing removed itself
        expect((await accounts()).filter((u) => u.externalIds?.[ISSUER] === 'cross-node-guard')).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        await run(() => db.deleteUser(String(rival._id)));
      }
    });

    it('fails the resolution like a failing store when the rule itself fails: nothing is written', async () => {
      const broken = { key: 'broken', check: async () => { throw new Error('the roles could not be read'); } };
      await expect(resolveWith(broken, { email: member.email, emailVerified: true })).rejects.toThrow('the roles could not be read');
      expect((await stored(member))?.externalIds ?? {}).toEqual({});
      // a later call is not poisoned by it
      await expect(resolveWith(anybody(), { email: member.email, emailVerified: true })).resolves.toMatchObject({ matchedBy: 'verifiedEmail' });
    });

    it('never lets two rules share one lookup', async () => {
      await run(() => db.updateUser(String(admin._id), { externalIds: { [ISSUER]: 'sub-1' } }));
      const [strict, loose] = await Promise.allSettled([resolveWith(refuseAdmins(), {}), resolveWith(anybody(), {})]);
      expect(strict.status).toBe('rejected');
      expect(loose.status).toBe('fulfilled');
      resetDelegatedIdentityCachesForTests();
      const [looseFirst, strictSecond] = await Promise.allSettled([resolveWith(anybody(), {}), resolveWith(refuseAdmins(), {})]);
      expect(looseFirst.status).toBe('fulfilled');
      expect(strictSecond.status).toBe('rejected');
    });
  });
});
