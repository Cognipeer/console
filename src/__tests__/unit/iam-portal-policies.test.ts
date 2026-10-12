/**
 * The portal rules of the engine: a portal's ACCESS LIST is its built-in policy
 * (managed:portal:*), custom deny rules restrict on top, and nothing else - no RBAC
 * level, no workspace role, no custom allow rule - can open a portal the list does
 * not name. Everything runs through the real engine with request validation on, so
 * the schema delta (Portal attributes, Agent in Portal) is exercised too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { authorize, configureIamEngine, resetIamEngineForTests, type AuthorizeResult } from '@/lib/iam/engine';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { invalidateTenantPolicies } from '@/lib/iam/events';
import { MANAGED_POLICIES, PORTAL_POLICIES, PORTAL_POLICY_IDS } from '@/lib/iam/managedPolicies';
import { portalAgentResource, portalResource, type PortalSubject } from '@/lib/iam/portalEntities';
import { deletePolicy } from '@/lib/iam/store';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_portal_policies');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  configureIamEngine({ validateRequests: false, versionCheckMs: 5_000 });
  await env.cleanup();
});
beforeEach(() => {
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
  resetIamEngineForTests();
});

/** A custom policy stored the way another node's write arrives (the store checks reachability against registered runtimes). */
async function putPolicy(policyId: string, cedar: string): Promise<void> {
  const now = new Date().toISOString();
  await env.db.runWithTenant(tenant(), async () => {
    await env.db.iamDocPut('iam_policies', policyId, {
      _id: policyId, policyId, name: policyId, cedar, spec: null, enabled: true,
      createdBy: 'tester', updatedBy: 'tester', createdAt: now, updatedAt: now,
    });
    await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
  });
  invalidateTenantPolicies(tenant());
}

const member = (id: string, groups: string[] = [], role = 'user'): IamPrincipal =>
  userPrincipal({ userId: id, user: { role }, groupIds: groups });

const PORTAL: PortalSubject = { id: 'P1', key: 'branch-assistant', access: { mode: 'selected', userIds: ['u-direct'], groupIds: ['g1'] } };
const OPEN: PortalSubject = { id: 'PALL', key: 'open', access: { mode: 'all', userIds: [], groupIds: [] } };
const NOBODY: PortalSubject = { id: 'PNO', key: 'nobody', access: { mode: 'selected', userIds: [], groupIds: [] } };

const enter = (principal: IamPrincipal, portal = PORTAL, channel = 'portal'): Promise<AuthorizeResult> =>
  authorize({ tenant: tenant(), principal, action: 'portal.use', resource: portalResource(portal), context: { channel } });

const run = (principal: IamPrincipal, agentId = 'agent-1', portal = PORTAL, channel = 'portal'): Promise<AuthorizeResult> =>
  authorize({
    tenant: tenant(),
    principal,
    action: 'agent.invoke',
    resource: portalAgentResource({ id: agentId, key: agentId, projectId: 'proj-1' }, portal),
    context: { channel },
  });

describe('the managed portal policies', () => {
  it('are eight, grouped under managed:portal, and valid against the generated schema', async () => {
    expect(Object.keys(PORTAL_POLICIES).sort()).toEqual(Object.values(PORTAL_POLICY_IDS).sort());
    expect(Object.keys(MANAGED_POLICIES)).toHaveLength(6);
    for (const [id, text] of Object.entries(PORTAL_POLICIES)) {
      expect(id.startsWith('managed:portal:')).toBe(true);
      expect(text.startsWith('@managed("portal")')).toBe(true);
    }
    // the first decision of the file builds the schema and loads the set under request validation
    expect((await enter(member('u-direct'))).failed).toBeUndefined();
  });
});

describe('opening a portal (portal.use)', () => {
  it('admits a person the list names, and a member of a group it names', async () => {
    const direct = await enter(member('u-direct'));
    expect(direct).toMatchObject({ allowed: true, errors: [] });
    expect(direct.reasons).toContain(PORTAL_POLICY_IDS.use);
    expect((await enter(member('u-group', ['g1']))).allowed).toBe(true);
  });

  it('refuses everybody else, naming the list as the reason', async () => {
    const stranger = await enter(member('u-other', ['g9']));
    expect(stranger).toMatchObject({ allowed: false, reasons: [PORTAL_POLICY_IDS.useBoundary], errors: [] });
  });

  it('admits anyone in the workspace when the portal is open to all', async () => {
    expect((await enter(member('u-other'), OPEN)).allowed).toBe(true);
  });

  it('admits nobody when the list is selected and empty - not even a member of a group that is named elsewhere', async () => {
    expect((await enter(member('u-group', ['g1']), NOBODY)).allowed).toBe(false);
  });

  it('does not let a workspace role open a portal: an owner who is not on the list is refused too', async () => {
    const owner = await enter(member('u-owner', [], 'owner'));
    expect(owner).toMatchObject({ allowed: false, reasons: [PORTAL_POLICY_IDS.useBoundary] });
    expect((await enter(member('u-direct', [], 'owner'))).allowed).toBe(true);
  });

  it('never admits an API token, whoever owns it', async () => {
    const token = tokenPrincipal({ tokenId: 't1', owner: member('u-direct', [], 'owner'), scope: null });
    expect((await enter(token)).allowed).toBe(false);
  });

  it('refuses a portal entity without an access list, even for an owner (fail closed)', async () => {
    const bare = authorize({
      tenant: tenant(),
      principal: member('u-owner', [], 'owner'),
      action: 'portal.use',
      resource: { kind: 'resource', type: 'portal', id: 'BARE', service: 'portals' },
      context: { channel: 'portal' },
    });
    expect(await bare).toMatchObject({ allowed: false, reasons: [PORTAL_POLICY_IDS.useBoundary] });
  });

  it('decides the same in any channel: the list is the rule, the channel only selects custom rules', async () => {
    expect((await enter(member('u-direct'), PORTAL, 'dashboard')).allowed).toBe(true);
    expect((await enter(member('u-other'), PORTAL, 'dashboard')).allowed).toBe(false);
  });
});

describe('running an agent through a portal (agent.invoke, channel portal)', () => {
  it('admits who the portal list admits, refuses everybody else, owners included', async () => {
    expect((await run(member('u-group', ['g1']))).allowed).toBe(true);
    expect(await run(member('u-other', ['g9']))).toMatchObject({ allowed: false, reasons: [PORTAL_POLICY_IDS.agentBoundary] });
    expect((await run(member('u-owner', [], 'owner'))).allowed).toBe(false);
  });

  it('is governed by the workspace role in any other channel (the dashboard playground is unchanged)', async () => {
    expect((await run(member('u-owner', [], 'owner'), 'agent-1', PORTAL, 'dashboard')).allowed).toBe(true);
    expect((await run(member('u-other', ['g9']), 'agent-1', PORTAL, 'dashboard')).allowed).toBe(true);
  });

  it('refuses an agent that does not name its portal in the portal channel', async () => {
    const result = await authorize({
      tenant: tenant(),
      principal: member('u-owner', [], 'owner'),
      action: 'agent.invoke',
      resource: { kind: 'resource', type: 'agent', id: 'agent-9', service: 'agents', projectId: 'proj-1' },
      context: { channel: 'portal' },
    });
    expect(result).toMatchObject({ allowed: false, reasons: [PORTAL_POLICY_IDS.agentBoundary] });
  });
});

describe('custom rules on top of the list', () => {
  it('an allow rule cannot widen it: not a Read-level allow, not an explicit portal.use allow', async () => {
    await putPolicy('read-for-g9', 'permit (principal in Group::"g9", action in Action::"Read", resource);');
    await putPolicy('use-for-other', 'permit (principal == User::"u-other", action == Action::"portal.use", resource == Portal::"P1");');
    await putPolicy('run-for-other', 'permit (principal == User::"u-other", action == Action::"agent.invoke", resource);');
    const stranger = member('u-other', ['g9']);
    expect((await enter(stranger)).allowed).toBe(false);
    expect((await run(stranger)).allowed).toBe(false);
    // ...while the same Read allow still grants what it always did: the dashboard
    const svc = await authorize({
      tenant: tenant(),
      principal: stranger,
      action: 'portals.read',
      resource: { kind: 'service', service: 'portals' },
      context: { channel: 'dashboard' },
    });
    expect(svc.allowed).toBe(true);
    for (const id of ['read-for-g9', 'use-for-other', 'run-for-other']) await deletePolicy(tenant(), id);
  });

  it('a deny rule blocks a person who is on the list, and it names the rule', async () => {
    await putPolicy('no-u-group', 'forbid (principal == User::"u-group", action == Action::"portal.use", resource == Portal::"P1");');
    expect(await enter(member('u-group', ['g1']))).toMatchObject({ allowed: false, reasons: ['custom:no-u-group'] });
    expect((await enter(member('u-direct'))).allowed).toBe(true);
    await deletePolicy(tenant(), 'no-u-group');
    expect((await enter(member('u-group', ['g1']))).allowed).toBe(true);
  });

  it('`resource in Portal` covers opening the portal and running its agents', async () => {
    await putPolicy('freeze-p1', 'forbid (principal, action in [Action::"portal.use", Action::"agent.invoke"], resource in Portal::"P1");');
    expect((await enter(member('u-direct'))).allowed).toBe(false);
    expect((await run(member('u-direct'))).allowed).toBe(false);
    expect((await enter(member('u-other'), OPEN)).allowed).toBe(true);
    expect((await run(member('u-other'), 'agent-1', OPEN)).allowed).toBe(true);
    await deletePolicy(tenant(), 'freeze-p1');
  });

  it('a deny rule on one agent in the portal channel stops that agent only - and only in portals', async () => {
    await putPolicy(
      'no-agent-1',
      'forbid (principal, action == Action::"agent.invoke", resource == Agent::"agent-1") when { context has channel && context.channel == "portal" };',
    );
    const person = member('u-direct');
    expect((await enter(person)).allowed).toBe(true);
    expect((await run(person, 'agent-1')).allowed).toBe(false);
    expect((await run(person, 'agent-2')).allowed).toBe(true);
    expect((await run(member('u-owner', [], 'owner'), 'agent-1', PORTAL, 'dashboard')).allowed).toBe(true);
    await deletePolicy(tenant(), 'no-agent-1');
  });

  it('a Read deny in the portal channel blocks entry; a Write deny blocks running only', async () => {
    const person = member('u-direct');
    await putPolicy('no-read', 'forbid (principal == User::"u-direct", action in Action::"Read", resource) when { context has channel && context.channel == "portal" };');
    expect((await enter(person)).allowed).toBe(false);
    await deletePolicy(tenant(), 'no-read');

    await putPolicy('no-write', 'forbid (principal == User::"u-direct", action in Action::"Write", resource) when { context has channel && context.channel == "portal" };');
    expect((await enter(person)).allowed).toBe(true);
    expect((await run(person)).allowed).toBe(false);
    await deletePolicy(tenant(), 'no-write');
  });
});

describe('an access list the engine cannot read', () => {
  it('fails the decision instead of letting a skipped boundary through (a managed forbid that errors)', async () => {
    // Request validation would already reject this entity; with it off (as in production) the managed rules meet the bad data.
    configureIamEngine({ validateRequests: false });
    resetIamEngineForTests();
    const result = await authorize({
      tenant: tenant(),
      principal: member('u-owner', [], 'owner'),
      action: 'portal.use',
      resource: {
        kind: 'resource', type: 'portal', id: 'BAD', service: 'portals',
        attrs: { mode: 'selected', allowedUsers: ['u-owner'], allowedGroups: [] },
      },
      context: { channel: 'portal' },
    });
    expect(result.allowed).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.errors.join(' ')).toContain(PORTAL_POLICY_IDS.useBoundary);
  });

  it('rejects the same entity when requests are validated against the schema', async () => {
    const result = await authorize({
      tenant: tenant(),
      principal: member('u-owner', [], 'owner'),
      action: 'portal.use',
      resource: {
        kind: 'resource', type: 'portal', id: 'BAD', service: 'portals',
        attrs: { mode: 'selected', allowedUsers: ['u-owner'], allowedGroups: [] },
      },
      context: { channel: 'portal' },
    });
    expect(result).toMatchObject({ allowed: false, failed: true });
  });
});
