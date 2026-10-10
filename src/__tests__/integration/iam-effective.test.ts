/**
 * The levels of the signed-in user (src/lib/iam/effective.ts
 * computeSessionEffectivePermissions) - the data behind project-aware navigation
 * and `GET /api/auth/session` -> effectivePermissions, on BOTH backends.
 *
 * Built the way the session gate builds the principal, from the cached principal
 * context: the cookie's project when the user can open it, else the one the gate
 * would pick; owners and admins in the default project; the project's own levels
 * narrow, group grants raise, custom policies apply, and a warm call reads
 * nothing from the database.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { EFFECTIVE_SERVICES, computeSessionEffectivePermissions, resetEffectiveLevelsForTests } from '@/lib/iam/effective';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { primeProjectLevelsForTests, resetProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { createPolicy } from '@/lib/iam/store';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Effective permissions of the signed-in user', (getDb) => {
  let db: DatabaseProvider;
  let tenant: string;
  let tenantId: string;
  let seq = 0;

  const mkUser = async (role: 'owner' | 'admin' | 'user' | 'project_admin', extra: Record<string, unknown> = {}) => {
    seq++;
    return (await db.createUser({
      tenantId, email: `e${seq}-${Math.random().toString(36).slice(2, 7)}@x.io`, name: `e${seq}`, password: '$2b$10$x',
      role, licenseId: 'FREE', features: [], ...extra,
    })) as IUser;
  };
  const mkProject = async (key: string) => String((await db.createProject({ tenantId, key, name: key, createdBy: 'x' }))._id);
  const mkGroup = async (name: string, extra: Record<string, unknown> = {}) =>
    String((await db.createGroup({ tenantId, name, createdBy: 't', source: 'local', ...extra } as never))._id);
  const effective = (user: IUser, activeProjectId?: string | null) =>
    computeSessionEffectivePermissions({ tenantDbName: tenant, tenantId, user, activeProjectId });

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `eff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenant = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'E', slug, dbName: tenant, licenseType: 'FREE', ownerId: 'pending' }))._id);
    await db.switchToTenant(tenant);
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    resetEffectiveLevelsForTests();
    resetProjectNarrowingCachesForTests();
    resetProjectLevelsForTests();
    primeProjectLevelsForTests(tenant, 0); // every project row counts in full
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a plain member: the levels of their role, in no project, computed from the principal alone', async () => {
    const user = await mkUser('user', { servicePermissions: { agents: 'read', prompts: 'none' } });
    const out = await effective(user);
    expect(out).toMatchObject({ projectId: null, source: 'managed' });
    expect(Object.keys(out.levels).sort()).toEqual([...EFFECTIVE_SERVICES].sort());
    expect(out.levels).toMatchObject({ agents: 'read', prompts: 'none', models: 'write', members: 'none', iam: 'none' });
  });

  it('owners and admins: admin everywhere (an administration service included), in the default project', async () => {
    const defaultId = await mkProject('default');
    for (const role of ['owner', 'admin'] as const) {
      const out = await effective(await mkUser(role));
      expect(out.projectId, role).toBe(defaultId);
      for (const service of EFFECTIVE_SERVICES) expect(out.levels[service], `${role} ${service}`).toBe('admin');
    }
    // their own cookie wins over the default project
    const other = await mkProject('other');
    expect((await effective(await mkUser('admin'), other)).projectId).toBe(other);
  });

  it('an owner or admin of a workspace without a default project is in none', async () => {
    expect((await effective(await mkUser('admin'))).projectId).toBeNull();
  });

  it('the project the user is in narrows: the cookie\'s when they can open it, else their first accessible one', async () => {
    const readOnly = await mkProject('p-ro');
    const writable = await mkProject('p-rw');
    const foreign = await mkProject('p-foreign');
    const user = await mkUser('user');
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: readOnly, role: 'member', servicePermissions: { agents: 'read', prompts: 'none' } });
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: writable, role: 'member', servicePermissions: { agents: 'write' } });

    const inReadOnly = await effective(user, readOnly);
    expect(inReadOnly.projectId).toBe(readOnly);
    expect(inReadOnly.levels).toMatchObject({ agents: 'read', prompts: 'none', models: 'write' });

    const inWritable = await effective(user, writable);
    expect(inWritable.projectId).toBe(writable);
    expect(inWritable.levels).toMatchObject({ agents: 'write', prompts: 'write' });

    // a project they cannot open, or none at all: the project they can open decides (here the only one)
    const solo = await mkUser('user');
    await db.upsertUserProject({ tenantId, userId: String(solo._id), projectId: readOnly, role: 'member', servicePermissions: { agents: 'read' } });
    for (const cookie of [foreign, null, undefined, 'x'.repeat(300)]) {
      const out = await effective(solo, cookie);
      expect(out.projectId, String(cookie)).toBe(readOnly);
      expect(out.levels.agents).toBe('read');
    }
    // with several to choose from it is one of theirs, never the foreign one
    expect([readOnly, writable]).toContain((await effective(user, foreign)).projectId);
  });

  it('a project can only lower a level, and one the project does not mention stays as the workspace has it', async () => {
    const pid = await mkProject('p-lower');
    const user = await mkUser('user', { servicePermissions: { agents: 'read' } });
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'admin', models: 'read' } });
    const out = await effective(user, pid);
    expect(out.levels.agents).toBe('read'); // the project does not lift the user's own cap
    expect(out.levels.models).toBe('read');
    expect(out.levels.tools).toBe('write');
  });

  it('a group raises the workspace level, and a group assignment narrows inside its project', async () => {
    const pid = await mkProject('p-group');
    const user = await mkUser('user', { servicePermissions: { agents: 'none' } });
    const raising = await mkGroup('raisers', { tenantRole: 'user' });
    const team = await mkGroup('team');
    for (const g of [raising, team]) await db.addGroupMember({ groupId: g, userId: String(user._id), tenantId, role: 'member' });
    await db.upsertGroupProject({ tenantId, groupId: team, projectId: pid, role: 'member', servicePermissions: { models: 'read' } });
    const out = await effective(user, pid);
    expect(out.projectId).toBe(pid);
    expect(out.levels.agents).toBe('write'); // raised by the group's tenant role
    expect(out.levels.models).toBe('read'); // narrowed by the group's project assignment
  });

  it('the explicit `none` of a project row counts only for rows saved after the workspace\'s first evaluation', async () => {
    const pid = await mkProject('p-gf');
    const user = await mkUser('user');
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'none', prompts: 'read' } });
    resetProjectLevelsForTests();
    primeProjectLevelsForTests(tenant, Date.now() + 60_000); // the workspace "started" after the row was saved
    resetPrincipalCacheForTests();
    const out = await effective(user, pid);
    expect(out.levels.agents).toBe('write'); // old `none`: not set
    expect(out.levels.prompts).toBe('read'); // old `read`: honoured
  });

  it('custom policies apply: the answer comes from the engine and the policy shows', async () => {
    const pid = await mkProject('p-policy');
    const user = await mkUser('user');
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: {} });
    await createPolicy(tenant, { policyId: 'freeze', name: 'freeze', cedar: `forbid(principal, action in Action::"Write", resource) when { context has projectId && context.projectId == "${pid}" };` }, 'u');
    const inProject = await effective(user, pid);
    expect(inProject.source).toBe('engine');
    expect(inProject.levels.agents).toBe('read');
    expect(inProject.levels.models).toBe('read');
    // an admin in the default project is not in that project: the rule does not touch them
    const defaultId = await mkProject('default');
    const admin = await effective(await mkUser('admin'));
    expect(admin.projectId).toBe(defaultId);
    expect(admin.levels.agents).toBe('admin');
  });

  it('a policy that names no project applies to a user who is in none', async () => {
    const user = await mkUser('user');
    await createPolicy(tenant, { policyId: 'freeze-models', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 'u');
    const out = await effective(user);
    expect(out).toMatchObject({ projectId: null, source: 'engine' });
    expect(out.levels.models).toBe('read');
    expect(out.levels.agents).toBe('write');
  });

  // The gates and the access check let the owner's own session reach `iam` whatever a policy says (owner safety, enforce.ts),
  // so the menu must not hide the Authorization center from the owner a rule has locked out of it.
  it('the owner\'s own session reports admin on iam even when a custom rule forbids writing it (owner safety)', async () => {
    await createPolicy(tenant, {
      policyId: 'freeze-iam-models', name: 'freeze',
      cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "iam" || resource.service == "models" };',
    }, 'u');
    const owner = await effective(await mkUser('owner'));
    expect(owner.source).toBe('engine');
    expect(owner.levels.iam).toBe('admin');
    // the promise is about `iam` only: every other level still comes from the rules
    expect(owner.levels.models).toBe('read');
    expect(owner.levels.agents).toBe('admin');
    // an admin (and so a delegated Authorization center admin) is an ordinary principal
    const admin = await effective(await mkUser('admin'));
    expect(admin.levels).toMatchObject({ iam: 'read', models: 'read', agents: 'admin' });
  });

  it('a warm call reads nothing from the database - not the user, the groups, the projects, the policies', async () => {
    const pid = await mkProject('p-warm');
    const user = await mkUser('user');
    const g = await mkGroup('warm-team', { tenantRole: 'user' });
    await db.addGroupMember({ groupId: g, userId: String(user._id), tenantId, role: 'member' });
    await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });
    await createPolicy(tenant, { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 'u');

    const first = await effective(user, pid);
    const spies = [
      vi.spyOn(db, 'findUserById'), vi.spyOn(db, 'listGroupMembersByUser'), vi.spyOn(db, 'iamListGroups'), vi.spyOn(db, 'listUserProjectsByUser'),
      vi.spyOn(db, 'listGroupProjectsByGroup'), vi.spyOn(db, 'listProjects'), vi.spyOn(db, 'findProjectByKey'), vi.spyOn(db, 'iamDocGet'), vi.spyOn(db, 'iamDocList'),
    ];
    const second = await effective(user, pid);
    expect(second).toEqual(first);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('an engine that cannot decide is an error, not a made-up answer', async () => {
    const user = await mkUser('user');
    await createPolicy(tenant, { policyId: 'freeze', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 'u');
    resetIamEngineForTests();
    resetEffectiveLevelsForTests();
    // the policy store cannot be read by the engine (the principal itself loads fine: it is cached)
    await effective(user);
    resetIamEngineForTests();
    resetEffectiveLevelsForTests();
    vi.spyOn(db, 'iamDocGet').mockRejectedValue(new Error('store down'));
    await expect(effective(user)).rejects.toThrow();
    vi.restoreAllMocks();
    expect((await effective(user)).levels.models).toBe('read');
  });
});
