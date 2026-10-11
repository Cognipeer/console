/**
 * The Access check, the impact preview and the catalog about portals - on BOTH
 * SQLite and MongoDB, with the portal seam standing in for the enterprise overlay.
 *
 *   portal.use      checked on the portal, in the portal channel, against its access list
 *   agent.invoke    checked on an agent run THROUGH a portal (the portal must offer it)
 *   the person      built the way the portal runtime builds them: no project narrowing
 *   without portals the enterprise overlay absent: there is no such portal, and nothing is "enforced"
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
import { registerIamPortalResolver, type IamPortalFacts } from '@/enterprise/iam-portal';
import { registerEnterpriseResources } from '@/enterprise/resource-providers';
import { clearResourceCache } from '@/lib/resources/service';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { buildCatalog } from '@/lib/iam/catalog';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { previewPolicy, PreviewInputError } from '@/lib/iam/preview';
import { listPoliciesForResource, PolicyFilterError } from '@/lib/iam/policiesForResource';
import { SimulateInputError, simulate } from '@/lib/iam/simulate';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  groupId: string;
  projectId: string;
  agentId: string;
  tokenId: string;
}

describeForEachProvider('Access check and preview about portals', (getDb) => {
  let db: DatabaseProvider;
  let T: Tenant;
  let facts: IamPortalFacts;
  let stored: IamPortalFacts;
  const tenant = () => ({ tenantDbName: T.dbName, tenantId: T.id });
  const idOf = (key: string) => String(T.users[key]._id);

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `sim-portal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Portal sim', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    T = { dbName, id: String(row._id), users: {}, groupId: '', projectId: '', agentId: '', tokenId: '' };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        T.users[key] = await db.createUser({ tenantId: T.id, email: `${key}@portal.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra });
      };
      await mk('owner', 'owner');
      await mk('listed', 'user');
      await mk('grouped', 'user');
      await mk('stranger', 'user');
      // a member the project itself limits: portals do not run in a project, so this must not matter
      await mk('limited', 'user');
      const group = await db.createGroup({ tenantId: T.id, name: 'Retail', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      T.groupId = String(group._id);
      await db.addGroupMember({ groupId: T.groupId, userId: String(T.users.grouped._id), tenantId: T.id, role: 'member' });
      await db.addGroupMember({ groupId: T.groupId, userId: String(T.users.limited._id), tenantId: T.id, role: 'member' });
      const project = await db.createProject({ tenantId: T.id, key: 'pj1', name: 'Project One', createdBy: 'x' });
      T.projectId = String(project._id);
      await db.upsertUserProject({ tenantId: T.id, userId: String(T.users.limited._id), projectId: T.projectId, role: 'member', servicePermissions: { portals: 'none', agents: 'none' } });
      const agent = await db.createAgent({ tenantId: T.id, projectId: T.projectId, key: 'support-bot', name: 'Support Bot', config: { modelKey: 'm1' }, status: 'draft', createdBy: 'x' } as never);
      T.agentId = String(agent._id);
      const token = await db.createApiToken({ tenantId: T.id, userId: String(T.users.listed._id), label: 'listed-ci', tokenHash: `h-${slug}`, tokenPrefix: 'cp_listed', createdBy: String(T.users.listed._id) } as never);
      T.tokenId = String(token._id);
    });
    stored = {
      id: 'portal-1', key: 'branch', name: 'Branch assistant', status: 'enabled',
      access: { mode: 'selected', userIds: [idOf('listed')], groupIds: [T.groupId] },
      agentIds: [T.agentId],
    };
  });
  afterAll(async () => {
    registerIamPortalResolver(null);
    configureIamEngine({ validateRequests: false });
    await drainPendingTasks();
  });
  beforeEach(() => {
    facts = { ...stored, access: { ...stored.access } }; // a test that edits the portal edits its own copy
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    registerIamPortalResolver(async (t, id) => (t.tenantDbName === T.dbName && id === facts.id ? facts : null));
  });
  afterEach(async () => {
    for (const p of await listPolicies(T.dbName)) await deletePolicy(T.dbName, p.policyId);
  });

  const openReq = (who: string, over: Record<string, unknown> = {}) => ({
    principal: { type: 'user', id: idOf(who) },
    action: 'portal.use',
    resource: { kind: 'resource', type: 'portal', id: 'portal-1' },
    ...over,
  });
  const runReq = (who: string, context: Record<string, unknown> = { channel: 'portal', portalId: 'portal-1' }, over: Record<string, unknown> = {}) => ({
    principal: { type: 'user', id: idOf(who) },
    action: 'agent.invoke',
    resource: { kind: 'resource', type: 'agent', id: T.agentId },
    context,
    ...over,
  });
  const invalid = async (input: unknown, status = 400) => {
    const error = await simulate(tenant(), input).then(() => null, (e: unknown) => e as SimulateInputError);
    expect(error, JSON.stringify(input)).toBeInstanceOf(SimulateInputError);
    expect(error!.status).toBe(status);
    return error!;
  };

  describe('opening a portal', () => {
    it('allows a listed person and a member of a listed group - in the portal channel, without being told to', async () => {
      for (const who of ['listed', 'grouped']) {
        const result = await simulate(tenant(), openReq(who));
        expect(result).toMatchObject({ allowed: true, defaultDeny: false, enforcedAtGate: true, projectId: null });
        expect(result.reasons.map((r) => r.cedarId)).toContain('managed:portal:use');
      }
    });

    it('denies everybody else - an owner too - and names the access list as the reason', async () => {
      for (const who of ['stranger', 'owner']) {
        const result = await simulate(tenant(), openReq(who));
        expect(result).toMatchObject({
          allowed: false, defaultDeny: false, enforcedAtGate: true,
          reasons: [expect.objectContaining({ cedarId: 'managed:portal:use-boundary', managed: true, effect: 'forbid' })],
        });
        expect(result.reasons[0].name).toBe('Only the access list opens a portal');
      }
    });

    it('tells the facts of the portal - counts, never the names on the list', async () => {
      const result = await simulate(tenant(), openReq('listed'));
      expect(result.portal).toEqual({
        id: 'portal-1', key: 'branch', name: 'Branch assistant', status: 'enabled', mode: 'selected', userCount: 1, groupCount: 1,
        networks: { mode: 'any', count: 0 }, embedded: 'access_list',
      });
      expect(JSON.stringify(result)).not.toContain(idOf('listed') + '"]'); // the list itself is not in the answer
      facts = { ...facts, status: 'disabled', access: { mode: 'all', userIds: [], groupIds: [] } };
      const open = await simulate(tenant(), openReq('stranger'));
      expect(open).toMatchObject({ allowed: true, portal: { mode: 'all', status: 'disabled', userCount: 0, groupCount: 0 } });
    });

    it('does not apply any project narrowing: a member the project limits is judged by the list alone', async () => {
      const result = await simulate(tenant(), openReq('limited', { context: { channel: 'portal', projectId: T.projectId } }));
      expect(result).toMatchObject({ allowed: true, projectId: null }); // 'limited' is in the listed group
    });

    it('is a different answer for a token: it never opens a portal (and the check refuses to ask in the portal channel)', async () => {
      const asked = await simulate(tenant(), { ...openReq('listed'), principal: { type: 'token', id: T.tokenId } });
      expect(asked).toMatchObject({ allowed: false, reasons: [expect.objectContaining({ cedarId: 'managed:portal:use-boundary' })] });
      const error = await invalid({ ...openReq('listed'), principal: { type: 'token', id: T.tokenId }, context: { channel: 'portal' } });
      expect(error.message).toContain('API tokens cannot open portals');
    });

    it('answers for a portal that does not exist, and for one that belongs to another workspace', async () => {
      const gone = await invalid(openReq('listed', { resource: { kind: 'resource', type: 'portal', id: 'nope' } }), 404);
      expect(gone.code).toBe('resource_not_found');
      registerIamPortalResolver(async () => null);
      expect((await invalid(openReq('listed'), 404)).code).toBe('resource_not_found');
    });
  });

  describe('running an agent through a portal', () => {
    it('is judged on the agent, run through that portal, against its list', async () => {
      const listed = await simulate(tenant(), runReq('listed'));
      expect(listed).toMatchObject({ allowed: true, enforcedAtGate: true, projectId: null, portal: { id: 'portal-1' } });
      expect(listed.reasons.map((r) => r.cedarId)).toContain('managed:portal:agent');
      const stranger = await simulate(tenant(), runReq('stranger'));
      expect(stranger).toMatchObject({ allowed: false, reasons: [expect.objectContaining({ cedarId: 'managed:portal:agent-boundary' })] });
    });

    it('needs the portal, and the portal must offer the agent', async () => {
      expect((await invalid(runReq('listed', { channel: 'portal' }))).message).toContain('Choose the portal');
      facts = { ...facts, agentIds: ['some-other-agent'] };
      expect((await invalid(runReq('listed'))).message).toContain('does not offer this agent');
      facts = { ...facts, agentIds: [T.agentId] };
      expect((await invalid(runReq('listed', { channel: 'portal', portalId: 'nope' }), 404)).code).toBe('resource_not_found');
    });

    it('takes a portal only for this action, in this channel', async () => {
      expect((await invalid(runReq('listed', { channel: 'dashboard', portalId: 'portal-1' }))).message).toContain('portal channel only');
      expect((await invalid(runReq('listed', { channel: 'portal', portalId: 'portal-1' }, { action: 'agent.get' }))).message).toContain('portal channel only');
      expect((await invalid(runReq('listed', { channel: 'portal', portalId: 'bad id!' }))).message).toContain('not a valid portal id');
    });

    it('is the ordinary check, on the agent alone, in the dashboard channel - and is not "enforced" there', async () => {
      const result = await simulate(tenant(), runReq('stranger', { channel: 'dashboard' }));
      expect(result).toMatchObject({ allowed: true, enforcedAtGate: false });
      expect(result.portal).toBeUndefined();
    });

    it('is refused for a token', async () => {
      const error = await invalid(runReq('listed', { channel: 'portal', portalId: 'portal-1' }, { principal: { type: 'token', id: T.tokenId } }));
      expect(error.message).toContain('API tokens cannot');
    });
  });

  describe('custom rules', () => {
    it('a deny rule is named as the reason (a rule about the portal is accepted where portals exist)', async () => {
      await createPolicy(T.dbName, {
        policyId: 'no-grouped', name: 'Retail cannot open it',
        cedar: `forbid (principal in Group::"${T.groupId}", action == Action::"portal.use", resource == Portal::"portal-1");`,
      }, 'tester');
      const blocked = await simulate(tenant(), openReq('grouped'));
      expect(blocked).toMatchObject({
        allowed: false,
        reasons: [{ cedarId: 'custom:no-grouped', policyId: 'no-grouped', managed: false, name: 'Retail cannot open it', effect: 'forbid' }],
      });
      expect((await simulate(tenant(), openReq('listed'))).allowed).toBe(true); // not in the group
    });

    it('an allow rule changes nothing for a portal', async () => {
      await createPolicy(T.dbName, { policyId: 'let-all-in', name: 'Let everybody in', cedar: 'permit (principal, action in Action::"Read", resource);' }, 'tester');
      const result = await simulate(tenant(), openReq('stranger'));
      expect(result).toMatchObject({ allowed: false, reasons: [expect.objectContaining({ cedarId: 'managed:portal:use-boundary' })] });
    });

    it('a deny rule that cannot be evaluated is a deny, and the problem is shown', async () => {
      const now = new Date().toISOString();
      await db.runWithTenant!(T.dbName, async () => {
        await db.iamDocPut('iam_policies', 'erroring', {
          _id: 'erroring', policyId: 'erroring', name: 'Erroring rule', spec: null, enabled: true, createdBy: 't', updatedBy: 't', createdAt: now, updatedAt: now,
          cedar: 'forbid (principal, action == Action::"portal.use", resource is Portal) when { resource.tags.contains("x") };',
        });
        await db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
      });
      const { invalidateTenantPolicies } = await import('@/lib/iam/events');
      invalidateTenantPolicies(T.dbName);
      configureIamEngine({ validateRequests: false });
      const result = await simulate(tenant(), openReq('listed'));
      expect(result.allowed).toBe(false);
      expect(result.reasons.map((r) => r.cedarId)).toEqual(['custom:erroring']);
      expect(result.errors?.join(' ')).toContain('counts as a deny');
    });
  });

  describe('without portals (the enterprise overlay is absent)', () => {
    beforeEach(() => registerIamPortalResolver(null));

    it('there is no such portal, and the portal actions are not enforced anywhere', async () => {
      expect((await invalid(openReq('listed'), 404)).code).toBe('resource_not_found');
      const catalog = buildCatalog();
      expect(catalog.actions.find((a) => a.id === 'portal.use')?.enforcedIn).toBeUndefined();
      expect(catalog.actions.find((a) => a.id === 'agent.invoke')?.enforcedIn).toBeUndefined();
    });
  });

  describe('the policies that also apply to a portal', () => {
    it('lists the custom rules that name it or apply to every portal, with which, and the built-in ones', async () => {
      const make = (policyId: string, name: string, cedar: string) => createPolicy(T.dbName, { policyId, name, cedar }, 'tester');
      await make('this-one', 'Block it', 'forbid (principal, action == Action::"portal.use", resource == Portal::"portal-1");');
      await make('other-one', 'Block another', 'forbid (principal, action == Action::"portal.use", resource == Portal::"portal-2");');
      await make('all-read', 'No reading in portals', 'forbid (principal, action in Action::"Read", resource) when { context has channel && context.channel == "portal" };');
      await make('models', 'No models', 'forbid (principal, action == Action::"models.write", resource is Service);');
      const out = await listPoliciesForResource(tenant(), { resourceType: 'portal', resourceId: 'portal-1' });
      expect(out.custom.map((p) => [p.policyId, p.scope]).sort()).toEqual([['all-read', 'all'], ['this-one', 'this']]);
      expect(out.custom.find((p) => p.policyId === 'this-one')).toMatchObject({ name: 'Block it', effect: 'forbid', enabled: true });
      expect(out.managed.filter((m) => m.group === 'portal')).toHaveLength(8);
    });

    it('asks for both halves of the filter, a real resource type and a safe id', async () => {
      for (const bad of [{}, { resourceType: 'portal' }, { resourceId: 'x' }, { resourceType: 'nonsense', resourceId: 'x' }, { resourceType: 'portal', resourceId: 'a b"c' }]) {
        await expect(listPoliciesForResource(tenant(), bad)).rejects.toBeInstanceOf(PolicyFilterError);
      }
    });
  });

  describe('the catalog', () => {
    it('says where each action is decided: the gates for services, the portal runtime for its two actions', () => {
      const catalog = buildCatalog();
      const by = (id: string) => catalog.actions.find((a) => a.id === id)!;
      expect(by('agents.write').enforcedIn).toEqual(['dashboard', 'api']);
      expect(by('portals.read').enforcedIn).toEqual(['dashboard', 'api']);
      expect(by('portal.use').enforcedIn).toEqual(['portal']);
      expect(by('agent.invoke').enforcedIn).toEqual(['portal']);
      expect(by('agent.delete').enforcedIn).toBeUndefined(); // evaluated by the Access check only
      expect(by('Read').enforcedIn).toBeUndefined(); // a level group is not an action anything asks
      // the portal belongs to the portals service whatever the registry says
      expect(catalog.resourceTypes.find((t) => t.type === 'portal')).toMatchObject({ service: 'portals' });
      expect(by('portal.use').service).toBe('portals');
    });
  });

  describe('the impact preview', () => {
    // The overlay adds the portal to the resource registry (the preview picks a few portals from it when the draft names none).
    beforeAll(() => {
      registerEnterpriseResources({
        types: [{
          type: 'portal', service: 'portals', category: 'agents', scope: 'tenant', edition: 'enterprise',
          list: async () => [{
            type: 'portal', id: 'portal-1', key: 'branch', name: 'Branch assistant', description: null, projectId: null,
            status: 'enabled', statusTone: 'ok', createdBy: null, updatedBy: null, createdAt: null, updatedAt: null, attributes: [],
          }],
        }],
      });
      clearResourceCache();
    });

    const spec = (over: Record<string, unknown> = {}) => ({
      effect: 'forbid',
      principals: { groups: [T.groupId] },
      actions: ['portal.use'],
      resources: { any: true },
      ...over,
    });

    it('shows who would lose the portal: the listed members of the group it blocks', async () => {
      const result = await previewPolicy(tenant(), { spec: spec() });
      expect(result.flips.allowToDeny).toBeGreaterThanOrEqual(2); // grouped and limited
      expect(result.flips.denyToAllow).toBe(0);
      expect(result.samples.length).toBeGreaterThan(0);
      for (const sample of result.samples) {
        expect(sample).toMatchObject({ action: 'portal.use', before: true, after: false, resource: { kind: 'resource', type: 'portal', id: 'portal-1' } });
      }
      // nobody outside the group is touched
      expect(result.samples.some((s) => s.principal.id === idOf('listed') && s.principal.type === 'user')).toBe(false);
    });

    it('previews a rule about the agents of a portal in the portal channel only', async () => {
      const result = await previewPolicy(tenant(), {
        spec: spec({ actions: ['agent.invoke'], conditions: { channels: ['portal'] } }),
      });
      expect(result.flips.allowToDeny).toBeGreaterThanOrEqual(2);
      expect(result.samples[0]).toMatchObject({ action: 'agent.invoke', resource: { kind: 'resource', type: 'agent', id: T.agentId } });
    });

    it('names one portal when the draft does', async () => {
      const result = await previewPolicy(tenant(), { spec: spec({ resources: { resources: [{ type: 'portal', id: 'portal-1' }] } }) });
      expect(result.flips.allowToDeny).toBeGreaterThanOrEqual(2);
    });

    it('refuses to preview a deny rule about portals where there are none (it could not block anything)', async () => {
      registerIamPortalResolver(null);
      const error = await previewPolicy(tenant(), { spec: spec() }).then(() => null, (e: unknown) => e as PreviewInputError);
      expect(error).toBeInstanceOf(PreviewInputError);
      expect(error!.status).toBe(400);
    });
  });
});
