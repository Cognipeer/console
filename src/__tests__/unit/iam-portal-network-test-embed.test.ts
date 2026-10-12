/**
 * Three opt-in settings of a portal, decided by the real engine (request validation on, so the
 * schema delta is exercised too):
 *
 *  - the NETWORK BOUNDARY (`access.networks`): the managed forbids compare `context.ip` with the
 *    portal's listed ranges for opening it, running its agents and answering its approvals;
 *  - the TEST SESSION: a workspace owner or admin opens the portal and runs its agents although the
 *    access list does not name them, only when the runtime marks the request `context.test`;
 *  - the EMBED setting (`access.embedded: 'any_verified'`): a person the host application vouched for
 *    is admitted when the runtime marks the request `context.embedded`.
 *
 * Portals that never turned any of them on behave exactly as before (the other test files cover that).
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
import { userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { ALL_MANAGED_POLICIES, PORTAL_POLICIES, PORTAL_POLICY_IDS } from '@/lib/iam/managedPolicies';
import { portalAgentResource, portalResource, type PortalSubject } from '@/lib/iam/portalEntities';
import { agentSessionResource, portalAgentSessionResource } from '@/lib/iam/agentEntities';
import { PORTAL_MAX_NETWORKS } from '@/lib/iam/portalNetworks';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_portal_network_test_embed');
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

const person = (id: string, role = 'user', groups: string[] = []): IamPrincipal => userPrincipal({ userId: id, user: { role }, groupIds: groups });

const listed = person('u-listed');
const stranger = person('u-stranger');
const admin = person('u-admin', 'admin');
const owner = person('u-owner', 'owner');

const base: PortalSubject = { id: 'P1', key: 'p1', access: { mode: 'selected', userIds: ['u-listed'], groupIds: [] } };
const withNetworks = (cidrs: string[], mode: 'any' | 'allow_list' = 'allow_list'): PortalSubject => ({
  ...base,
  access: { ...base.access, networks: { mode, cidrs } },
});
const embeddedOpen: PortalSubject = { ...base, access: { ...base.access, embedded: 'any_verified' } };

interface Ctx { ip?: string; test?: boolean; embedded?: boolean }
const enter = (principal: IamPrincipal, portal: PortalSubject, ctx: Ctx = {}): Promise<AuthorizeResult> =>
  authorize({ tenant: tenant(), principal, action: 'portal.use', resource: portalResource(portal), context: { channel: 'portal', ...ctx } });
const run = (principal: IamPrincipal, portal: PortalSubject, ctx: Ctx = {}): Promise<AuthorizeResult> =>
  authorize({
    tenant: tenant(),
    principal,
    action: 'agent.invoke',
    resource: portalAgentResource({ id: 'agent-1', key: 'agent-1', projectId: 'proj-1' }, portal),
    context: { channel: 'portal', ...ctx },
  });
const approve = (principal: IamPrincipal, portal: PortalSubject, ctx: Ctx = {}): Promise<AuthorizeResult> =>
  authorize({
    tenant: tenant(),
    principal,
    action: 'agent.approve',
    resource: portalAgentSessionResource(
      { id: 'agent-1', key: 'agent-1', projectId: 'proj-1', ownerIds: [principal.userId], approvers: 'owner' },
      portal,
    ),
    context: { channel: 'portal', ...ctx },
  });

describe('the managed portal rules are well formed', () => {
  it('has the new rules, and all of them type-check against the schema (no evaluation error anywhere)', async () => {
    expect(Object.keys(PORTAL_POLICIES)).toEqual(expect.arrayContaining([
      PORTAL_POLICY_IDS.networkBoundary,
      PORTAL_POLICY_IDS.agentNetworkBoundary,
      PORTAL_POLICY_IDS.testUse,
      PORTAL_POLICY_IDS.testAgent,
    ]));
    expect(Object.keys(ALL_MANAGED_POLICIES)).toHaveLength(23);
    const result = await enter(listed, base);
    expect(result.failed).toBeFalsy();
    expect(result.errors).toEqual([]);
  });

  it('writes the slots out in the rule text, one range per line', () => {
    const text = PORTAL_POLICIES[PORTAL_POLICY_IDS.networkBoundary];
    expect(text).toContain('resource.networkMode == "allow_list"');
    expect(text).toContain('context.ip.isInRange(resource.net0)');
    expect(text).toContain(`context.ip.isInRange(resource.net${PORTAL_MAX_NETWORKS - 1})`);
    expect(text).not.toContain(`net${PORTAL_MAX_NETWORKS})`);
  });
});

describe('the network boundary', () => {
  const office = withNetworks(['10.0.0.0/8', '203.0.113.7', '2001:db8::/32']);

  it('is not there for a portal that never listed networks, or lists them as "any"', async () => {
    expect((await enter(listed, base, { ip: '8.8.8.8' })).allowed).toBe(true);
    expect((await enter(listed, withNetworks(['10.0.0.0/8'], 'any'), { ip: '8.8.8.8' })).allowed).toBe(true);
    expect((await run(listed, withNetworks(['10.0.0.0/8'], 'any'), { ip: '8.8.8.8' })).allowed).toBe(true);
  });

  it('admits a listed person from a listed range, for opening, running and answering', async () => {
    for (const ip of ['10.1.2.3', '203.0.113.7', '2001:db8:1::5']) {
      expect((await enter(listed, office, { ip })).allowed, `open ${ip}`).toBe(true);
      expect((await run(listed, office, { ip })).allowed, `run ${ip}`).toBe(true);
      expect((await approve(listed, office, { ip })).allowed, `approve ${ip}`).toBe(true);
    }
  });

  it('refuses from anywhere else, and says which rule did it', async () => {
    for (const ip of ['8.8.8.8', '203.0.113.8', '2001:db9::1', '192.0.2.1']) {
      const opened = await enter(listed, office, { ip });
      expect(opened.allowed, `open ${ip}`).toBe(false);
      expect(opened.reasons).toContain(PORTAL_POLICY_IDS.networkBoundary);
      const ran = await run(listed, office, { ip });
      expect(ran.allowed, `run ${ip}`).toBe(false);
      expect(ran.reasons).toContain(PORTAL_POLICY_IDS.agentNetworkBoundary);
      const answered = await approve(listed, office, { ip });
      expect(answered.allowed, `approve ${ip}`).toBe(false);
      expect(answered.reasons).toContain(PORTAL_POLICY_IDS.agentNetworkBoundary);
    }
  });

  it('refuses a request without a usable address (fail closed)', async () => {
    expect((await enter(listed, office, {})).allowed).toBe(false);
    expect((await enter(listed, office, { ip: 'unknown' })).allowed).toBe(false);
    expect((await run(listed, office, { ip: 'not-an-address' })).allowed).toBe(false);
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 one', async () => {
    expect((await enter(listed, office, { ip: '::ffff:10.9.9.9' })).allowed).toBe(true);
    expect((await enter(listed, office, { ip: '::ffff:8.8.8.8' })).allowed).toBe(false);
  });

  it('an allow list with no usable range admits nobody', async () => {
    const empty = withNetworks([]);
    expect((await enter(listed, empty, { ip: '10.0.0.1' })).allowed).toBe(false);
    const junk = withNetworks(['not a range']);
    expect((await enter(listed, junk, { ip: '10.0.0.1' })).allowed).toBe(false);
  });

  it('does not make the access list wider: a stranger from a listed range is still refused', async () => {
    const result = await enter(stranger, office, { ip: '10.1.2.3' });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain(PORTAL_POLICY_IDS.useBoundary);
  });

  it('holds the last slot too, and nothing beyond the slots is read', async () => {
    const cidrs = Array.from({ length: PORTAL_MAX_NETWORKS }, (_, i) => `172.16.${i}.0/24`);
    const full = withNetworks(cidrs);
    expect((await enter(listed, full, { ip: `172.16.${PORTAL_MAX_NETWORKS - 1}.9` })).allowed).toBe(true);
    expect((await enter(listed, full, { ip: `172.16.${PORTAL_MAX_NETWORKS}.9` })).allowed).toBe(false);
    const tooMany = withNetworks([...cidrs, '198.51.100.0/24']);
    expect((await enter(listed, tooMany, { ip: '198.51.100.4' })).allowed).toBe(false);
  });

  it('applies to an agent that is not run through a portal only when its portal lists networks', async () => {
    // A dashboard request about the same agent has no portal; the boundary is not about it.
    const result = await authorize({
      tenant: tenant(),
      principal: admin,
      action: 'agent.invoke',
      resource: agentSessionResource({ id: 'agent-1', projectId: 'proj-1', ownerIds: [admin.userId], approvers: 'owner_or_admin' }),
      context: { channel: 'dashboard', ip: '8.8.8.8' },
    });
    expect(result.reasons).not.toContain(PORTAL_POLICY_IDS.agentNetworkBoundary);
  });
});

describe('the test session', () => {
  it('lets a workspace owner or admin open the portal and run its agents although they are not on the list', async () => {
    for (const who of [admin, owner]) {
      const opened = await enter(who, base, { test: true });
      expect(opened.allowed, `${who.userId} opens`).toBe(true);
      expect(opened.reasons).toContain(PORTAL_POLICY_IDS.testUse);
      const ran = await run(who, base, { test: true });
      expect(ran.allowed, `${who.userId} runs`).toBe(true);
      expect(ran.reasons).toContain(PORTAL_POLICY_IDS.testAgent);
      expect((await approve(who, base, { test: true })).allowed, `${who.userId} answers`).toBe(true);
    }
  });

  it('does nothing without the flag, in the other channels, or for anybody who is not an owner or admin', async () => {
    expect((await enter(admin, base)).allowed).toBe(false);
    expect((await enter(admin, base, { test: false })).allowed).toBe(false);
    expect((await run(admin, base)).allowed).toBe(false);
    expect((await enter(stranger, base, { test: true })).allowed).toBe(false);
    expect((await run(stranger, base, { test: true })).allowed).toBe(false);
    expect((await approve(stranger, base, { test: true })).allowed).toBe(false);
    const projectAdmin = person('u-pa', 'project_admin');
    expect((await enter(projectAdmin, base, { test: true })).allowed).toBe(false);
    const dashboard = await authorize({
      tenant: tenant(), principal: admin, action: 'portal.use', resource: portalResource(base), context: { channel: 'dashboard', test: true },
    });
    expect(dashboard.allowed).toBe(false);
  });

  it('is still refused by the network boundary: the test shows what people would meet', async () => {
    const office = withNetworks(['10.0.0.0/8']);
    expect((await enter(admin, office, { test: true, ip: '10.1.1.1' })).allowed).toBe(true);
    const outside = await enter(admin, office, { test: true, ip: '8.8.8.8' });
    expect(outside.allowed).toBe(false);
    expect(outside.reasons).toContain(PORTAL_POLICY_IDS.networkBoundary);
    expect((await run(admin, office, { test: true, ip: '8.8.8.8' })).allowed).toBe(false);
  });

  it('does not give a token anything (tokens never use portals)', async () => {
    const { tokenPrincipal } = await import('@/lib/iam/entities');
    const token = tokenPrincipal({ tokenId: 't1', owner: admin, scope: null });
    expect((await enter(token, base, { test: true })).allowed).toBe(false);
  });
});

describe('embedded people', () => {
  it('are admitted by a portal that takes every verified person, only when the runtime marks the request', async () => {
    const opened = await enter(stranger, embeddedOpen, { embedded: true });
    expect(opened.allowed).toBe(true);
    expect((await run(stranger, embeddedOpen, { embedded: true })).allowed).toBe(true);
    expect((await approve(stranger, embeddedOpen, { embedded: true })).allowed).toBe(true);
    expect((await enter(stranger, embeddedOpen)).allowed).toBe(false);
    expect((await enter(stranger, embeddedOpen, { embedded: false })).allowed).toBe(false);
  });

  it('are held to the access list by a portal that keeps the default', async () => {
    expect((await enter(stranger, base, { embedded: true })).allowed).toBe(false);
    const explicit: PortalSubject = { ...base, access: { ...base.access, embedded: 'access_list' } };
    expect((await enter(stranger, explicit, { embedded: true })).allowed).toBe(false);
    expect((await run(stranger, explicit, { embedded: true })).allowed).toBe(false);
    expect((await enter(listed, explicit, { embedded: true })).allowed).toBe(true);
  });

  it('are still subject to the network boundary', async () => {
    const strict: PortalSubject = { ...embeddedOpen, access: { ...embeddedOpen.access, networks: { mode: 'allow_list', cidrs: ['10.0.0.0/8'] } } };
    expect((await enter(stranger, strict, { embedded: true, ip: '10.2.2.2' })).allowed).toBe(true);
    expect((await enter(stranger, strict, { embedded: true, ip: '8.8.8.8' })).allowed).toBe(false);
  });

  it('do not reach another portal, nor a request outside the portal channel', async () => {
    const other: PortalSubject = { id: 'P2', key: 'p2', access: { mode: 'selected', userIds: [], groupIds: [] } };
    expect((await enter(stranger, other, { embedded: true })).allowed).toBe(false);
    const dashboard = await authorize({
      tenant: tenant(), principal: stranger, action: 'agent.invoke', resource: portalAgentResource({ id: 'agent-1', projectId: 'proj-1' }, embeddedOpen), context: { channel: 'dashboard', embedded: true },
    });
    // (The dashboard's generic Write permit may allow this agent; the portal's embed rule must not be what does.)
    expect(dashboard.reasons).not.toContain(PORTAL_POLICY_IDS.agent);
    const dashboardOpen = await authorize({
      tenant: tenant(), principal: stranger, action: 'portal.use', resource: portalResource(embeddedOpen), context: { channel: 'dashboard', embedded: true },
    });
    expect(dashboardOpen.allowed).toBe(false);
  });
});
