/**
 * The principal pages of the Authorization center (src/lib/iam/principals.ts) on
 * BOTH backends: the lists, and the detail of a person, a token or a group with
 * the levels the ENGINE gives them and where each level comes from (role, direct
 * grant, group, project, token scope, custom policy). The table is probed with the
 * same engine and the same principal the gates use, so it cannot disagree with
 * enforcement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { PrincipalError, getPrincipalDetail, listPrincipals, type EffectiveService } from '@/lib/iam/principals';
import { primeProjectLevelsForTests, resetProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { resetProjectNarrowingCachesForTests } from '@/lib/iam/projectNarrowing';
import { compileSpec } from '@/lib/iam/policySpec';
import { createPolicy } from '@/lib/iam/store';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Principal pages', (getDb) => {
  let db: DatabaseProvider;
  let tenant: string;
  let tenantId: string;
  let seq = 0;
  const tenantRef = () => ({ tenantDbName: tenant, tenantId });

  const mkUser = async (role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
    seq++;
    return (await db.createUser({
      tenantId, email: `pd${seq}-${Math.random().toString(36).slice(2, 7)}@x.io`, name: `Person ${String(seq).padStart(2, '0')}`, password: '$2b$10$x',
      role, licenseId: 'FREE', features: [], ...extra,
    })) as IUser;
  };
  const mkProject = async (key: string, name = key) => String((await db.createProject({ tenantId, key, name, createdBy: 'x' }))._id);
  const mkGroup = async (name: string, extra: Record<string, unknown> = {}) =>
    String((await db.createGroup({ tenantId, name, createdBy: 't', source: 'local', ...extra } as never))._id);
  const join = (groupId: string, user: IUser) => db.addGroupMember({ groupId, userId: String(user._id), tenantId, role: 'member' });
  const mkToken = async (user: IUser, extra: Record<string, unknown> = {}) =>
    String((await db.createApiToken({
      tenantId, userId: String(user._id), label: `token-${++seq}`, tokenHash: `h-${Math.random()}`, tokenPrefix: 'cp_pd', createdBy: String(user._id), ...extra,
    } as never))._id);
  const row = (effective: EffectiveService[], service: string) => effective.find((e) => e.service === service)!;

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `pd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tenant = `tenant_${slug}`;
    tenantId = String((await db.createTenant({ companyName: 'PD', slug, dbName: tenant, licenseType: 'FREE', ownerId: 'pending' }))._id);
    await db.switchToTenant(tenant);
    resetPrincipalCacheForTests();
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: false });
    resetProjectNarrowingCachesForTests();
    resetProjectLevelsForTests();
    primeProjectLevelsForTests(tenant, 0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a person', () => {
    it('is described with the levels the engine gives them, the groups, the projects and their tokens', async () => {
      const pid = await mkProject('alpha', 'Alpha');
      const user = await mkUser('user', { servicePermissions: { prompts: 'read' } });
      const g = await mkGroup('Raisers', { tenantRole: 'user' });
      await join(g, user);
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: {} });
      const tokenId = await mkToken(user);

      const detail = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(user._id) });
      expect(detail.principal).toMatchObject({ type: 'user', id: String(user._id), role: 'user', status: 'active', email: user.email });
      expect(detail.groups).toEqual([{ id: g, name: 'Raisers' }]);
      expect(detail.projects).toEqual([{ id: pid, name: 'Alpha', role: 'member', via: 'direct' }]);
      expect(detail.tokens?.map((t) => t.id)).toEqual([tokenId]);
      expect(detail.effective.map((e) => e.service)).not.toContain('aegis');

      // role default + direct grant (read) lowered below the role's write; the group's tenant role raises it back
      const prompts = row(detail.effective, 'prompts');
      expect(prompts.level).toBe('write');
      expect(prompts.sources.map((s) => s.kind)).toEqual(['role', 'direct', 'group']);
      expect(row(detail.effective, 'members').level).toBe('none');
      expect(row(detail.effective, 'members').sources).toEqual([{ kind: 'role', label: 'user', level: 'none' }]);
    });

    it('names the policies that apply to them - by name, through a group, or to everyone - and no longer has a mode', async () => {
      const user = await mkUser('user');
      const g = await mkGroup('Team');
      await join(g, user);
      await createPolicy(tenant, { policyId: 'by-name', name: 'By name', cedar: `forbid(principal == User::"${String(user._id)}", action == Action::"models.write", resource is Service);` }, 'u');
      await createPolicy(tenant, { policyId: 'by-group', name: 'By group', cedar: `forbid(principal in Group::"${g}", action == Action::"agents.write", resource is Service);` }, 'u');
      await createPolicy(tenant, { policyId: 'everyone', name: 'Everyone', cedar: 'forbid(principal, action == Action::"tools.write", resource is Service);' }, 'u');
      await createPolicy(tenant, { policyId: 'elsewhere', name: 'Elsewhere', cedar: 'forbid(principal == User::"someone-else", action == Action::"rag.write", resource is Service);' }, 'u');

      const detail = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(user._id) });
      expect(detail.policies.map((p) => p.policyId).sort()).toEqual(['by-group', 'by-name', 'everyone']);
      for (const policy of detail.policies) {
        expect(policy).not.toHaveProperty('mode');
        expect(policy).not.toHaveProperty('monitorStats');
        expect(policy.enabled).toBe(true);
      }
      // ... and the levels show the policies that moved them
      expect(row(detail.effective, 'models')).toMatchObject({ level: 'read' });
      expect(row(detail.effective, 'models').sources.at(-1)).toEqual({ kind: 'policy', label: 'by-name', level: 'read' });
      expect(row(detail.effective, 'agents').sources.at(-1)).toMatchObject({ kind: 'policy', label: 'by-group', level: 'read' });
      expect(row(detail.effective, 'rag').sources.some((s) => s.kind === 'policy')).toBe(false);
    });

    it('a disabled policy applies to nobody: it is listed, and moves no level', async () => {
      const user = await mkUser('user');
      await createPolicy(tenant, { policyId: 'off', name: 'Off', cedar: 'forbid(principal, action == Action::"models.write", resource is Service);', enabled: false }, 'u');
      const detail = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(user._id) });
      expect(detail.policies.map((p) => ({ id: p.policyId, enabled: p.enabled }))).toEqual([{ id: 'off', enabled: false }]);
      expect(row(detail.effective, 'models').level).toBe('write');
      expect(row(detail.effective, 'models').sources.some((s) => s.kind === 'policy')).toBe(false);
    });

    it('the workspace owner keeps the Authorization Engine in the table whatever a rule says; their API token and an admin do not (owner safety)', async () => {
      const owner = await mkUser('owner');
      const admin = await mkUser('admin');
      const tokenId = await mkToken(owner);
      await createPolicy(tenant, {
        policyId: 'lock-iam', name: 'Lock iam',
        cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "iam" || resource.service == "models" };',
      }, 'u');

      const ownerRows = (await getPrincipalDetail(tenantRef(), { type: 'user', id: String(owner._id) })).effective;
      expect(row(ownerRows, 'iam').level).toBe('admin');
      expect(row(ownerRows, 'iam').sources.some((s) => s.kind === 'policy')).toBe(false);
      // only that promise: every other service is still what the rules leave
      expect(row(ownerRows, 'models')).toMatchObject({ level: 'read' });
      expect(row(ownerRows, 'models').sources.at(-1)).toMatchObject({ kind: 'policy', label: 'lock-iam', level: 'read' });

      // an API token that belongs to the owner is an ordinary principal
      const tokenRows = (await getPrincipalDetail(tenantRef(), { type: 'token', id: tokenId })).effective;
      expect(row(tokenRows, 'iam')).toMatchObject({ level: 'read' });
      expect(row(tokenRows, 'iam').sources.at(-1)).toMatchObject({ kind: 'policy', label: 'lock-iam', level: 'read' });
      // so is an admin
      const adminRows = (await getPrincipalDetail(tenantRef(), { type: 'user', id: String(admin._id) })).effective;
      expect(row(adminRows, 'iam').level).toBe('read');
    });

    it('shows the workspace-level view by default, and the project\'s narrowing - as a source of its own - when a project is asked for', async () => {
      const pid = await mkProject('beta', 'Beta');
      const user = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(user._id), projectId: pid, role: 'member', servicePermissions: { agents: 'read' } });

      const workspace = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(user._id) });
      expect(row(workspace.effective, 'agents').level).toBe('write');
      expect(row(workspace.effective, 'agents').sources.some((s) => s.kind === 'project')).toBe(false);

      const inProject = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(user._id), projectId: pid });
      expect(row(inProject.effective, 'agents').level).toBe('read');
      expect(row(inProject.effective, 'agents').sources.at(-1)).toEqual({ kind: 'project', label: 'Beta', level: 'read' });
      expect(row(inProject.effective, 'models').level).toBe('write'); // a service the project does not mention
    });

    it('an administration service reads "read" for an explicit write (a change needs admin), without inventing a policy source for it', async () => {
      const user = await mkUser('user', { servicePermissions: { members: 'write' } });
      const detail = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(user._id) });
      expect(row(detail.effective, 'members').level).toBe('read');
      expect(row(detail.effective, 'members').sources.some((s) => s.kind === 'policy')).toBe(false);
    });

    it('owners and admins are in every project (implicit); legacy and group paths are told apart', async () => {
      const a = await mkProject('a', 'A');
      const b = await mkProject('b', 'B');
      const c = await mkProject('c', 'C');
      const owner = await mkUser('owner');
      const ownerDetail = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(owner._id) });
      expect(ownerDetail.projects.map((p) => [p.id, p.via, p.role]).sort()).toEqual([[a, 'implicit', 'project_admin'], [b, 'implicit', 'project_admin'], [c, 'implicit', 'project_admin']].sort());

      const member = await mkUser('user', { projectIds: [a] });
      const g = await mkGroup('Gp');
      await join(g, member);
      await db.upsertUserProject({ tenantId, userId: String(member._id), projectId: b, role: 'member', servicePermissions: {} });
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: c, role: 'project_admin', servicePermissions: {} });
      const detail = await getPrincipalDetail(tenantRef(), { type: 'user', id: String(member._id) });
      const via = Object.fromEntries(detail.projects.map((p) => [p.id, p.via]));
      expect(via).toEqual({ [a]: 'legacy', [b]: 'direct', [c]: 'group' });
      expect(detail.projects.find((p) => p.id === c)).toMatchObject({ role: 'project_admin', groupName: 'Gp' });
    });

    it('reads the groups once for the whole page', async () => {
      const user = await mkUser('user');
      for (let i = 0; i < 3; i++) await join(await mkGroup(`G${i}`), user);
      const batch = vi.spyOn(db, 'iamListGroups');
      const memberships = vi.spyOn(db, 'listGroupMembersByUser');
      await getPrincipalDetail(tenantRef(), { type: 'user', id: String(user._id) });
      expect(memberships).toHaveBeenCalledTimes(1);
      expect(batch).toHaveBeenCalledTimes(1);
    });
  });

  describe('a token', () => {
    it('is capped by its scope, which shows as a source, and carries its owner and project', async () => {
      const pid = await mkProject('gamma', 'Gamma');
      const owner = await mkUser('admin');
      const tokenId = await mkToken(owner, { servicePermissions: { agents: 'read', models: 'write' }, projectId: pid });
      const detail = await getPrincipalDetail(tenantRef(), { type: 'token', id: tokenId });
      expect(detail.principal).toMatchObject({
        type: 'token', id: tokenId, ownerId: String(owner._id), ownerLabel: owner.name, projectId: pid, scope: { agents: 'read', models: 'write' }, status: 'active',
      });
      expect(detail.tokens).toBeNull();
      expect(row(detail.effective, 'agents').level).toBe('read');
      expect(row(detail.effective, 'agents').sources.at(-1)).toEqual({ kind: 'token-scope', label: 'Token scope', level: 'read' });
      expect(row(detail.effective, 'models').level).toBe('write');
      expect(row(detail.effective, 'prompts').level).toBe('none'); // absent from the scope
    });

    it('acts as its owner, groups included', async () => {
      const owner = await mkUser('user', { servicePermissions: { agents: 'none' } });
      await join(await mkGroup('Raising', { tenantRole: 'user' }), owner);
      const tokenId = await mkToken(owner);
      const detail = await getPrincipalDetail(tenantRef(), { type: 'token', id: tokenId });
      expect(row(detail.effective, 'agents').level).toBe('write');
      expect(detail.groups.map((g) => g.name)).toEqual(['Raising']);
    });

    it('a token without a project is checked in the workspace\'s default project, like its gate', async () => {
      const defaultId = await mkProject('default', 'Default');
      const owner = await mkUser('user');
      await db.upsertUserProject({ tenantId, userId: String(owner._id), projectId: defaultId, role: 'member', servicePermissions: { agents: 'read' } });
      const tokenId = await mkToken(owner);
      const detail = await getPrincipalDetail(tenantRef(), { type: 'token', id: tokenId });
      expect(row(detail.effective, 'agents').level).toBe('read');
      expect(row(detail.effective, 'agents').sources.at(-1)).toMatchObject({ kind: 'project', label: 'Default' });
    });

    it('a rule written about its owner (in the editor) reaches it too - the compiler adds the ownership', async () => {
      const owner = await mkUser('user');
      const tokenId = await mkToken(owner);
      const compiled = await compileSpec(
        { effect: 'forbid', principals: { users: [String(owner._id)] }, actions: ['models.write'], resources: { any: true } },
        { tenantDbName: tenant, tenantId },
      );
      expect(compiled.ok, JSON.stringify(compiled.errors)).toBe(true);
      await createPolicy(tenant, { policyId: 'owner-rule', name: 'Owner rule', cedar: compiled.cedar, spec: compiled.spec! }, 'u');
      const detail = await getPrincipalDetail(tenantRef(), { type: 'token', id: tokenId });
      expect(detail.policies.map((p) => p.policyId)).toEqual(['owner-rule']);
      expect(row(detail.effective, 'models').level).toBe('read');
      expect(row(detail.effective, 'models').sources.at(-1)).toMatchObject({ kind: 'policy', label: 'owner-rule' });
    });
  });

  describe('a group', () => {
    it('is described by its own grant, its members and its projects', async () => {
      const pid = await mkProject('delta', 'Delta');
      const g = await mkGroup('Admins', { tenantRole: 'admin', description: 'The admins' });
      for (let i = 0; i < 3; i++) await join(g, await mkUser('user'));
      await db.upsertGroupProject({ tenantId, groupId: g, projectId: pid, role: 'project_admin', servicePermissions: {} });
      const detail = await getPrincipalDetail(tenantRef(), { type: 'group', id: g });
      expect(detail.principal).toMatchObject({ type: 'group', id: g, label: 'Admins', sublabel: 'The admins', memberCount: 3, source: 'local', tenantRole: 'admin' });
      expect(detail.projects).toEqual([{ id: pid, name: 'Delta', role: 'project_admin', via: 'group', groupName: 'Admins' }]);
      expect(row(detail.effective, 'agents')).toMatchObject({ level: 'admin', sources: [{ kind: 'group', label: 'Admins', level: 'admin' }] });
      const plain = await mkGroup('Plain');
      expect(row((await getPrincipalDetail(tenantRef(), { type: 'group', id: plain })).effective, 'agents')).toEqual({ service: 'agents', level: 'none', sources: [] });
    });
  });

  describe('what is not there', () => {
    it('is "not found", also for something that belongs to another workspace', async () => {
      const slug = `pd-o-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const otherDb = `tenant_${slug}`;
      const otherId = String((await db.createTenant({ companyName: 'O', slug, dbName: otherDb, licenseType: 'FREE', ownerId: 'x' }))._id);
      const foreign = await db.runWithTenant!(otherDb, () => db.createUser({ tenantId: otherId, email: 'f@x.io', name: 'F', password: 'h', role: 'user', licenseId: 'FREE', features: [] }));
      const foreignGroup = await db.runWithTenant!(otherDb, () => db.createGroup({ tenantId: otherId, name: 'FG', createdBy: 't', source: 'local' } as never));
      for (const [type, id] of [['user', 'nobody'], ['token', 'nobody'], ['group', 'nobody'], ['user', String(foreign._id)], ['group', String(foreignGroup._id)]] as const) {
        const error = await getPrincipalDetail(tenantRef(), { type, id }).catch((e: unknown) => e);
        expect(error, `${type} ${id}`).toBeInstanceOf(PrincipalError);
        expect((error as PrincipalError).code).toBe('principal_not_found');
      }
    });
  });

  describe('the lists', () => {
    it('page users, groups and tokens with the number of policies that name each directly', async () => {
      const alice = await mkUser('user', { name: 'Alice Doe' });
      await mkUser('user', { name: 'Bob Roe' });
      const g = await mkGroup('Engineering');
      await join(g, alice);
      const tokenId = await mkToken(alice);
      await createPolicy(tenant, { policyId: 'p1', name: 'p1', cedar: `forbid(principal == User::"${String(alice._id)}", action == Action::"models.write", resource is Service);` }, 'u');
      await createPolicy(tenant, { policyId: 'p2', name: 'p2', cedar: `forbid(principal in Group::"${g}", action == Action::"agents.write", resource is Service);` }, 'u');

      const users = await listPrincipals(tenantRef(), { type: 'user', limit: 10, offset: 0 });
      expect(users.hasMore).toBe(false);
      expect(users.items.find((u) => u.id === String(alice._id))).toMatchObject({ label: 'Alice Doe', role: 'user', status: 'active', policyCount: 1 });
      expect((await listPrincipals(tenantRef(), { type: 'user', q: 'bob', limit: 10, offset: 0 })).items.map((u) => u.label)).toEqual(['Bob Roe']);
      expect((await listPrincipals(tenantRef(), { type: 'user', limit: 1, offset: 0 })).hasMore).toBe(true);

      const groups = await listPrincipals(tenantRef(), { type: 'group', limit: 10, offset: 0 });
      expect(groups.items).toEqual([expect.objectContaining({ id: g, label: 'Engineering', memberCount: 1, policyCount: 1 })]);

      const tokens = await listPrincipals(tenantRef(), { type: 'token', limit: 10, offset: 0 });
      expect(tokens.items).toEqual([expect.objectContaining({ id: tokenId, status: 'active', sublabel: expect.stringContaining('Alice Doe') })]);
    });
  });
});
