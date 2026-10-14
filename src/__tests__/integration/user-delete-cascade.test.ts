/**
 * Deleting a person takes their API tokens, group memberships and project
 * memberships with it - through the real data layer of BOTH providers, so no
 * orphan row is left behind to be counted as a member of a group or project.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const dbRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: vi.fn(async () => dbRef.current),
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = dbRef.current as any;
      return db.runWithTenant ? db.runWithTenant(tenantDbName, () => fn(db)) : fn(db);
    },
  };
});

import { cleanupDeletedUser } from '@/lib/services/users/userLifecycle';

describeForEachProvider('Deleting a person', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  let tenantDbName: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    db = getDb();
    dbRef.current = db;
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tenantDbName = `tenant_cascade_${suffix}`;
    tenantId = String((await db.createTenant({
      companyName: 'Acme', slug: `acme-${suffix}`, dbName: tenantDbName, licenseType: 'FREE', ownerId: 'pending',
    }))._id);
    const inTenant = <T>(fn: () => Promise<T>): Promise<T> => (db.runWithTenant ? db.runWithTenant(tenantDbName, fn) : fn());

    await inTenant(async () => {
      for (const name of ['leaver', 'stayer']) {
        ids[name] = String((await db.createUser({
          tenantId, email: `${name}@example.test`, name, password: 'h', role: 'user', licenseId: 'FREE', features: [],
        }))._id);
      }
      for (const name of ['alpha', 'beta', 'gamma']) {
        ids[`group-${name}`] = String((await db.createGroup({ tenantId, name, createdBy: 't', source: 'local' } as never))._id);
      }
      for (const name of ['one', 'two']) {
        ids[`project-${name}`] = String((await db.createProject({ tenantId, key: `p-${name}`, name, createdBy: 'x' }))._id);
      }
      // the leaver is in two groups and two projects; the stayer in one group and one project
      await db.addGroupMember({ groupId: ids['group-alpha'], userId: ids.leaver, tenantId, role: 'member' });
      await db.addGroupMember({ groupId: ids['group-beta'], userId: ids.leaver, tenantId, role: 'member' });
      await db.addGroupMember({ groupId: ids['group-alpha'], userId: ids.stayer, tenantId, role: 'member' });
      await db.upsertUserProject({ tenantId, userId: ids.leaver, projectId: ids['project-one'], role: 'member' });
      await db.upsertUserProject({ tenantId, userId: ids.leaver, projectId: ids['project-two'], role: 'project_admin' });
      await db.upsertUserProject({ tenantId, userId: ids.stayer, projectId: ids['project-one'], role: 'member' });
    });
    for (const [owner, label] of [['leaver', 'ci'], ['leaver', 'notebook'], ['stayer', 'batch']] as const) {
      await db.createApiToken({
        tenantId, userId: ids[owner], label, tokenHash: `${suffix}-${label}`, tokenPrefix: `cp_${label}`, createdBy: ids[owner],
      } as never);
    }
  });

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => (db.runWithTenant ? db.runWithTenant(tenantDbName, fn) : fn());

  it('leaves no token, group membership or project membership of the deleted person - and touches nobody else\'s', async () => {
    expect(await inTenant(() => db.deleteUser(ids.leaver))).toBe(true);
    const cleanup = await cleanupDeletedUser(tenantDbName, ids.leaver, tenantId);

    expect(cleanup).toEqual({ revokedTokens: 2, failedTokens: 0, removedGroupMemberships: 2, removedProjectMemberships: 2 });

    expect(await db.listApiTokens(ids.leaver)).toEqual([]);
    expect(await inTenant(() => db.listGroupMembersByUser(ids.leaver))).toEqual([]);
    expect(await inTenant(() => db.listUserProjectsByUser(ids.leaver))).toEqual([]);
    // the member counts of the groups no longer include the person who is gone
    expect(await inTenant(() => db.iamCountGroupMembers([ids['group-alpha'], ids['group-beta']]))).toEqual({
      [ids['group-alpha']]: 1,
      [ids['group-beta']]: 0,
    });

    // the person who stays keeps everything
    expect((await db.listApiTokens(ids.stayer)).map((token) => token.label)).toEqual(['batch']);
    expect((await inTenant(() => db.listGroupMembersByUser(ids.stayer))).map((m) => m.groupId)).toEqual([ids['group-alpha']]);
    expect((await inTenant(() => db.listUserProjectsByUser(ids.stayer))).map((m) => m.projectId)).toEqual([ids['project-one']]);
  });

  it('is harmless for a person with nothing attached, and when run twice', async () => {
    const lonely = await inTenant(() => db.createUser({
      tenantId, email: 'lonely@example.test', name: 'lonely', password: 'h', role: 'user', licenseId: 'FREE', features: [],
    }));
    await inTenant(() => db.deleteUser(String(lonely._id)));
    const empty = { revokedTokens: 0, failedTokens: 0, removedGroupMemberships: 0, removedProjectMemberships: 0 };
    expect(await cleanupDeletedUser(tenantDbName, String(lonely._id), tenantId)).toEqual(empty);
    expect(await cleanupDeletedUser(tenantDbName, String(lonely._id), tenantId)).toEqual(empty);
  });
});
