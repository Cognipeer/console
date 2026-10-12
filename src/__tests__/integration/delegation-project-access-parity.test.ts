/**
 * Acting for a user: the person must be able to open the project the application token is bound to
 * (lib/iam/delegationGate.ts), on BOTH SQLite and MongoDB with the real stores.
 *
 *   opens      a membership of the person's own (current, or the legacy project list), a project one of their groups is
 *              assigned to - for an external account, a delegated group - and any project for a person whose role is
 *              administrator
 *   refuses    everybody else with 403 `project_not_accessible` and a decision id: a member of other projects only (who a
 *              dashboard session would move to one of them), a person with no project at all, an external account in no
 *              group that has the project, a project that no longer exists
 *   closes     at once when the membership or the group's project assignment is taken away
 *   fails      closed when the lookup fails: 503 `delegation_unavailable`, never an allow
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { drainPendingTasks } from '@/lib/core/asyncTask';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { DelegationError, resolveDelegatedCaller } from '@/lib/iam/delegationGate';
import { resetDelegatedGroupsForTests, delegatedGroupExternalId } from '@/lib/iam/delegatedGroups';
import { resetDelegatedIdentityCachesForTests } from '@/lib/iam/delegatedIdentity';
import { resetIdentityAssertionCachesForTests } from '@/lib/iam/identityAssertion';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { putTokenDelegation, resetTokenDelegationCacheForTests } from '@/lib/iam/tokenDelegation';
import { describeForEachProvider } from './db-parity.helper';

const ISSUER = 'https://idp.example.com/realms/acme';
const AUDIENCE = 'cognipeer-console';
const SECRET = 'a-shared-secret-of-at-least-32-characters-ok';
const TOKEN_ID = 'app-token-1';
const enc = new TextEncoder();

describeForEachProvider('acting for a user: the project of the token', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  let defaultProject: string;
  let projectTwo: string;
  const users: Record<string, IUser> = {};
  const run = <T,>(fn: () => Promise<T>): Promise<T> => db.runWithTenant!(tenantDbName, fn);

  const statement = (sub: string, groups?: string[]) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...(groups ? { groups } : {}) })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(enc.encode(SECRET));
  };
  const actFor = async (sub: string, projectId: string, groups?: string[]) => {
    const caller = await resolveDelegatedCaller({ headerValue: await statement(sub, groups), tokenId: TOKEN_ID, tenantDbName, tenantId, projectId });
    if (!caller) throw new Error('the call carried a user token and was not for a person');
    return caller;
  };
  const refusal = async (promise: Promise<unknown>): Promise<DelegationError> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DelegationError);
      return error as DelegationError;
    }
    throw new Error('the call was let in');
  };
  const refusedAsNoProject = async (promise: Promise<unknown>) => {
    const error = await refusal(promise);
    expect(error).toMatchObject({ code: 'project_not_accessible', status: 403, decisionId: expect.any(String) });
    return error;
  };

  const mkUser = (key: string, role: 'owner' | 'admin' | 'user', extra: Partial<IUser> = {}) =>
    run(async () => {
      users[key] = await db.createUser({
        tenantId, email: `${key}@acme.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [],
        externalIds: { [ISSUER]: `sub-${key}` }, ...extra,
      });
    });

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `deleg-proj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    tenantDbName = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'Acme', slug, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending' }))._id);
    await run(async () => {
      defaultProject = String((await db.createProject({ tenantId, key: 'default', name: 'Default', createdBy: 't' }))._id);
      projectTwo = String((await db.createProject({ tenantId, key: 'p2', name: 'P2', createdBy: 't' }))._id);
    });
    await mkUser('owner', 'owner');
    await mkUser('admin', 'admin');
    await mkUser('member', 'user');
    await mkUser('p2member', 'user');
    // the legacy project list of the account (what accounts had before project memberships were rows)
    await mkUser('legacy', 'user', { projectIds: [projectTwo] });
    await mkUser('nobody', 'user');
    await mkUser('groupadmin', 'user');
    await run(async () => {
      for (const key of ['member', 'p2member', 'groupadmin']) {
        await db.upsertUserProject({ tenantId, userId: String(users[key]._id), projectId: defaultProject, role: 'member' });
      }
      await db.upsertUserProject({ tenantId, userId: String(users.p2member._id), projectId: projectTwo, role: 'member' });
      // an administrator only through a group
      const admins = await db.createGroup({ tenantId, name: 'admins', tenantRole: 'admin', createdBy: 't', source: 'local' } as never);
      await db.addGroupMember({ tenantId, groupId: String(admins._id), userId: String(users.groupadmin._id), role: 'member' });
    });
    await putTokenDelegation(tenantDbName, TOKEN_ID, {
      enabled: true,
      trust: { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'], keys: { hsSecrets: [{ kid: 'k1', secret: SECRET }] }, requireSingleUse: false },
      mapping: { matchBy: ['externalId'], jit: 'external', groupMap: [{ idpGroup: 'partners', consoleGroupName: 'Partners' }] },
      allowPrivileged: true,
    }, 'test');
  });
  afterAll(async () => {
    await drainPendingTasks(); // (the audit rows of the accounts and groups made above, before the store is closed)
    hoisted.getDatabase.mockReset();
  });
  beforeEach(() => {
    resetPrincipalCacheForTests();
    resetProjectNarrowingCachesForTests();
    resetIdentityAssertionCachesForTests();
    resetDelegatedIdentityCachesForTests();
    resetDelegatedGroupsForTests();
    resetTokenDelegationCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a project the person is a member of, by a row of their own or by the legacy project list', async () => {
    expect((await actFor('sub-member', defaultProject)).user).toMatchObject({ _id: users.member._id });
    expect((await actFor('sub-p2member', projectTwo)).user).toMatchObject({ _id: users.p2member._id });
    expect((await actFor('sub-legacy', projectTwo)).user).toMatchObject({ _id: users.legacy._id });
  });

  it('refuses a person who cannot open it: a member of other projects only, and a person with no project at all', async () => {
    // a dashboard session would move this member to the default project; a call does not run there instead
    await refusedAsNoProject(actFor('sub-member', projectTwo));
    await refusedAsNoProject(actFor('sub-nobody', defaultProject));
    await refusedAsNoProject(actFor('sub-nobody', projectTwo));
    // the same people, in their own projects
    expect((await actFor('sub-p2member', defaultProject)).user).toMatchObject({ _id: users.p2member._id });
  });

  it('opens every project for an administrator (where the setup admits them), not for one only through a group', async () => {
    expect((await actFor('sub-admin', projectTwo)).user).toMatchObject({ _id: users.admin._id });
    expect((await actFor('sub-admin', defaultProject)).user).toMatchObject({ _id: users.admin._id });
    // an administrator through a group is in the projects the group and the account are assigned to, like anybody
    expect((await actFor('sub-groupadmin', defaultProject)).user).toMatchObject({ _id: users.groupadmin._id });
    await refusedAsNoProject(actFor('sub-groupadmin', projectTwo));
    // the owner is never acted for, whatever the project
    expect(await refusal(actFor('sub-owner', projectTwo))).toMatchObject({ code: 'delegation_refused', status: 403 });
  });

  it('closes at once when the membership is taken away', async () => {
    await run(() => db.upsertUserProject({ tenantId, userId: String(users.member._id), projectId: projectTwo, role: 'member' }));
    expect((await actFor('sub-member', projectTwo)).user).toMatchObject({ _id: users.member._id });
    await run(() => db.deleteUserProject(String(users.member._id), projectTwo));
    await refusedAsNoProject(actFor('sub-member', projectTwo));
  });

  it('opens a project for an external account only through a delegated group that was given it', async () => {
    // the first arrival creates the account and the issuer's group - and the group has no project yet
    await refusedAsNoProject(actFor('sub-ext', projectTwo, ['partners']));
    const group = await run(() => db.findGroupByExternalId(delegatedGroupExternalId(ISSUER, 'Partners')));
    expect(group).toMatchObject({ source: 'delegated' });
    const external = (await run(() => db.findUsersByExternalIdentity(ISSUER, 'sub-ext')))[0];
    expect(external).toMatchObject({ kind: 'external', role: 'user' });

    await run(() => db.upsertGroupProject({ tenantId, groupId: String(group!._id), projectId: projectTwo, role: 'member' }));
    const caller = await actFor('sub-ext', projectTwo, ['partners']);
    expect(caller).toMatchObject({ kind: 'external' });
    expect(String(caller.user._id)).toBe(String(external._id));
    // that project and no other
    await refusedAsNoProject(actFor('sub-ext', defaultProject, ['partners']));
    // leaving the claim takes the membership, and the access, away
    await refusedAsNoProject(actFor('sub-ext', projectTwo, []));
    // and so does taking the project away from the group
    expect((await actFor('sub-ext', projectTwo, ['partners'])).user).toMatchObject({ _id: external._id });
    await run(() => db.removeGroupProject(String(group!._id), projectTwo));
    await refusedAsNoProject(actFor('sub-ext', projectTwo, ['partners']));
  });

  it('is not a project the person can open when it no longer exists', async () => {
    const gone = await run(() => db.createProject({ tenantId, key: 'p-gone', name: 'Gone', createdBy: 't' }));
    await run(() => db.upsertUserProject({ tenantId, userId: String(users.member._id), projectId: String(gone._id), role: 'member' }));
    expect((await actFor('sub-member', String(gone._id))).user).toMatchObject({ _id: users.member._id });
    await run(() => db.deleteProject(String(gone._id)));
    await refusedAsNoProject(actFor('sub-member', String(gone._id)));
    await refusedAsNoProject(actFor('sub-admin', String(gone._id)));
  });

  it('fails closed when the lookup fails: delegation_unavailable (503), never an allow', async () => {
    vi.spyOn(db, 'listUserProjectsByUser').mockRejectedValue(new Error('project store down'));
    const error = await refusal(actFor('sub-member', defaultProject));
    expect(error).toMatchObject({ code: 'delegation_unavailable', status: 503, decisionId: expect.any(String) });
  });
});
