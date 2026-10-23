/**
 * The messaging channel of the engine (Slack / Microsoft Teams): the ACCESS LIST of an agent's deployment on a
 * connection is its built-in policy (managed:messaging:*), exactly like a portal's. Through the REAL engine, with
 * request validation on (so the schema delta - ChannelDeployment, Agent in ChannelDeployment - is exercised), and
 * through the real `authorizeResourceAccess` helper and audit trail over SQLite.
 *
 *   who runs the agent    the list: people, groups, "everyone"; never a role (owners included), never a token
 *   a custom rule         forbids restrict on top, allows cannot widen
 *   a decision            without a deployment it is refused, and answered 503, never decided
 *   a refusal             is audited under the channels service with the deployment, and reads in words in the feed
 *   the seam              the channel exists only where the overlay registered its resolver
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
import {
  hasIamMessagingResolver,
  registerIamMessagingResolver,
  resolveIamMessagingDeployment,
  type IamMessagingDeploymentFacts,
} from '@/enterprise/iam-messaging';
import { registerIamPortalResolver } from '@/enterprise/iam-portal';
import { RUNTIME_ENFORCED_ACTIONS } from '@/lib/iam/actions';
import { listAuditFeed } from '@/lib/iam/auditFeed';
import { IAM_CHANNELS, RUNTIME_IAM_CHANNELS, isIamChannel } from '@/lib/iam/context';
import { auditServiceOf } from '@/lib/iam/denialAudit';
import { getDecision } from '@/lib/iam/decisions';
import { authorize, configureIamEngine, resetIamEngineForTests, type AuthorizeResult } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { invalidateTenantPolicies } from '@/lib/iam/events';
import {
  ALL_MANAGED_POLICIES,
  MANAGED_FORBID_IDS,
  MESSAGING_POLICIES,
  MESSAGING_POLICY_IDS,
  listManagedPolicies,
} from '@/lib/iam/managedPolicies';
import {
  messagingAgentResource,
  messagingDeploymentEntity,
  type MessagingDeploymentSubject,
} from '@/lib/iam/messagingEntities';
import { PORTAL_ENTITY_SLICE_THRESHOLD, portalAgentResource } from '@/lib/iam/portalEntities';
import { describeManagedPolicy } from '@/lib/iam/policyRows';
import { currentCatalogView, gateReach, parsePolicySpec, type PolicySpec } from '@/lib/iam/policySpec';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { authorizeResourceAccess, authorizeResourceForPrincipal, resetResourceAuthzThrottleForTests, type ResourceAuthzInput } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { engineSelfTest } from '@/lib/iam/selfTest';
import { SimulateInputError, simulate } from '@/lib/iam/simulate';
import { deletePolicy } from '@/lib/iam/store';
import { enforcedChannelsOf, isRuntimeEnforced } from '@/lib/iam/runtimeEnforced';
import { IAM_CHANNELS as UI_CHANNELS } from '@/components/iam/api';
import { parseBuiltInReason, reasonLink } from '@/components/iam/check/reasonModel';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_messaging_channel');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  registerIamMessagingResolver(null);
  registerIamPortalResolver(null);
  configureIamEngine({ validateRequests: false, versionCheckMs: 5_000 });
  await drainPendingTasks();
  await env.cleanup();
});
beforeEach(() => {
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
  resetIamEngineForTests();
  resetPrincipalCacheForTests();
  resetEnforceStatsForTests();
  resetResourceAuthzThrottleForTests();
  resetResourceAuthzStatsForTests();
});
afterEach(async () => {
  registerIamMessagingResolver(null);
  registerIamPortalResolver(null);
  await drainPendingTasks();
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

const person = (id: string, groups: string[] = [], role = 'user'): IamPrincipal =>
  userPrincipal({ userId: id, user: { role }, groupIds: groups });

const DEPLOYMENT: MessagingDeploymentSubject = { id: 'D1', access: { mode: 'selected', userIds: ['u-direct'], groupIds: ['g1'] } };
const OPEN: MessagingDeploymentSubject = { id: 'DALL', access: { mode: 'all', userIds: [], groupIds: [] } };
const NOBODY: MessagingDeploymentSubject = { id: 'DNO', access: { mode: 'selected', userIds: [], groupIds: [] } };

const run = (
  principal: IamPrincipal,
  deployment: MessagingDeploymentSubject = DEPLOYMENT,
  channel = 'messaging',
  agentId = 'agent-1',
): Promise<AuthorizeResult> =>
  authorize({
    tenant: tenant(),
    principal,
    action: 'agent.invoke',
    resource: messagingAgentResource({ id: agentId, key: agentId, projectId: 'proj-1' }, deployment),
    context: { channel },
  });

describe('the managed messaging policies', () => {
  it('are two, grouped under managed:messaging, one permit and one forbid, and valid against the generated schema', async () => {
    expect(Object.keys(MESSAGING_POLICIES).sort()).toEqual(Object.values(MESSAGING_POLICY_IDS).sort());
    for (const [id, text] of Object.entries(MESSAGING_POLICIES)) {
      expect(id.startsWith('managed:messaging:')).toBe(true);
      expect(text.startsWith('@managed("messaging")')).toBe(true);
      expect(ALL_MANAGED_POLICIES[id]).toBe(text);
      // a deployment has no embed: its list is the three attributes and nothing else
      expect(text).not.toContain('embedAccess');
    }
    const listed = listManagedPolicies().filter((p) => p.group === 'messaging');
    expect(listed.map((p) => [p.id, p.effect]).sort()).toEqual([
      [MESSAGING_POLICY_IDS.agent, 'permit'],
      [MESSAGING_POLICY_IDS.agentBoundary, 'forbid'],
    ].sort());
    // a forbid that errors must fail the decision, never be skipped
    expect(MANAGED_FORBID_IDS.has(MESSAGING_POLICY_IDS.agentBoundary)).toBe(true);
    expect(MANAGED_FORBID_IDS.has(MESSAGING_POLICY_IDS.agent)).toBe(false);
    // the first decision of the file builds the schema and loads the set under request validation
    expect((await run(person('u-direct'))).failed).toBeUndefined();
  });

  it('are described in plain language for the policy list', () => {
    expect(describeManagedPolicy(MESSAGING_POLICY_IDS.agent)).toMatchObject({
      group: 'messaging', effect: 'permit', nameKey: 'iamApi.managed.messaging-agent.name',
    });
    expect(describeManagedPolicy(MESSAGING_POLICY_IDS.agentBoundary)).toMatchObject({ group: 'messaging', effect: 'forbid' });
    expect(describeManagedPolicy(MESSAGING_POLICY_IDS.agentBoundary).description).not.toBe('');
  });

  it('pass the engine self-test (canned allow, deny, owner-not-listed and token cases included)', () => {
    const result = engineSelfTest();
    expect(result).toMatchObject({ ok: true });
  });
});

describe('running an agent from Slack or Teams (agent.invoke, channel messaging)', () => {
  it('admits a person the list names, and a member of a group it names, naming the list as the reason', async () => {
    const direct = await run(person('u-direct'));
    expect(direct).toMatchObject({ allowed: true, errors: [] });
    expect(direct.reasons).toContain(MESSAGING_POLICY_IDS.agent);
    expect((await run(person('u-group', ['g1']))).allowed).toBe(true);
  });

  it('admits anyone in the workspace when the deployment is open to everyone', async () => {
    expect((await run(person('u-other'), OPEN)).allowed).toBe(true);
  });

  it('refuses everybody else, naming the access list boundary', async () => {
    expect(await run(person('u-other', ['g9']))).toMatchObject({
      allowed: false, reasons: [MESSAGING_POLICY_IDS.agentBoundary], errors: [],
    });
  });

  it('admits nobody when the list is selected and empty', async () => {
    expect((await run(person('u-group', ['g1']), NOBODY)).allowed).toBe(false);
  });

  it('does not let a workspace role in: an owner or admin who is not on the list is refused (RBAC writers included)', async () => {
    expect(await run(person('u-owner', [], 'owner'))).toMatchObject({ allowed: false, reasons: [MESSAGING_POLICY_IDS.agentBoundary] });
    expect((await run(person('u-admin', [], 'admin'))).allowed).toBe(false);
    expect((await run(person('u-writer', [], 'user'))).allowed).toBe(false);
    // ...and the same owner is let in by the list like anybody else
    expect((await run(person('u-direct', [], 'owner'))).allowed).toBe(true);
  });

  it('never admits an API token, whoever owns it and however the list reads', async () => {
    const owner = person('u-direct', [], 'owner');
    expect((await run(tokenPrincipal({ tokenId: 't1', owner, scope: null }))).allowed).toBe(false);
    expect((await run(tokenPrincipal({ tokenId: 't2', owner, scope: null }), OPEN)).allowed).toBe(false);
  });

  it('refuses an agent that names no deployment in the messaging channel (fail closed), even for an owner', async () => {
    const result = await authorize({
      tenant: tenant(),
      principal: person('u-direct', [], 'owner'),
      action: 'agent.invoke',
      resource: { kind: 'resource', type: 'agent', id: 'agent-9', service: 'agents', projectId: 'proj-1' },
      context: { channel: 'messaging' },
    });
    expect(result).toMatchObject({ allowed: false, reasons: [MESSAGING_POLICY_IDS.agentBoundary] });
  });

  it('refuses a deployment without an access list (fail closed), even for an owner', async () => {
    const ref = { type: 'ChannelDeployment', id: 'DBARE' };
    const result = await authorize({
      tenant: tenant(),
      principal: person('u-direct', [], 'owner'),
      action: 'agent.invoke',
      resource: {
        kind: 'resource', type: 'agent', id: 'agent-1', service: 'agents', projectId: 'proj-1',
        parents: [ref], attrs: { channelDeployment: { __entity: ref } },
        extra: [{ uid: ref, parents: [], attrs: { service: 'channels', adminService: true } }],
      },
      context: { channel: 'messaging' },
    });
    expect(result).toMatchObject({ allowed: false, reasons: [MESSAGING_POLICY_IDS.agentBoundary] });
  });

  it('is governed by the workspace role in any other channel (the dashboard playground is unchanged), and the portal list does not open it', async () => {
    expect((await run(person('u-owner', [], 'owner'), DEPLOYMENT, 'dashboard')).allowed).toBe(true);
    expect((await run(person('u-other', ['g9']), DEPLOYMENT, 'dashboard')).allowed).toBe(true);
    // a deployment's list opens nothing in the portal channel: that channel asks a portal's list, which this agent does not name
    expect((await run(person('u-direct'), DEPLOYMENT, 'portal')).allowed).toBe(false);
  });

  it('is not opened by a portal list either: a portal agent in the messaging channel names no deployment', async () => {
    const result = await authorize({
      tenant: tenant(),
      principal: person('u-direct'),
      action: 'agent.invoke',
      resource: portalAgentResource({ id: 'agent-1', projectId: 'proj-1' }, { id: 'P1', access: { mode: 'all', userIds: [], groupIds: [] } }),
      context: { channel: 'messaging' },
    });
    expect(result).toMatchObject({ allowed: false, reasons: [MESSAGING_POLICY_IDS.agentBoundary] });
  });

  it('cuts a long list down to the requester\'s slice and decides the same', async () => {
    const userIds = Array.from({ length: PORTAL_ENTITY_SLICE_THRESHOLD + 50 }, (_, i) => `bulk-${i}`);
    const big: MessagingDeploymentSubject = { id: 'DBIG', access: { mode: 'selected', userIds: [...userIds, 'u-direct'], groupIds: ['g1'] } };
    const ask = (id: string, groups: string[]) => authorize({
      tenant: tenant(),
      principal: person(id, groups),
      action: 'agent.invoke',
      resource: messagingAgentResource({ id: 'agent-1', projectId: 'proj-1' }, big, { userId: id, groupIds: groups }),
      context: { channel: 'messaging' },
    });
    expect((await ask('u-direct', [])).allowed).toBe(true);
    expect((await ask('u-group', ['g1'])).allowed).toBe(true);
    expect((await ask('u-other', ['g9'])).allowed).toBe(false);
    const entity = messagingDeploymentEntity(big, { userId: 'u-direct', groupIds: [] });
    expect((entity.attrs.allowedUsers as unknown[]).length).toBe(1);
  });
});

describe('custom rules on top of the list', () => {
  it('an allow rule cannot widen it: not a Write-level allow, not an explicit agent.invoke allow', async () => {
    await putPolicy('write-for-g9', 'permit (principal in Group::"g9", action in Action::"Write", resource);');
    await putPolicy('run-for-other', 'permit (principal == User::"u-other", action == Action::"agent.invoke", resource);');
    const stranger = person('u-other', ['g9']);
    expect((await run(stranger)).allowed).toBe(false);
    for (const id of ['write-for-g9', 'run-for-other']) await deletePolicy(tenant(), id);
  });

  it('a deny rule blocks a person who is on the list, and names the rule', async () => {
    await putPolicy('no-u-group', 'forbid (principal == User::"u-group", action == Action::"agent.invoke", resource);');
    expect(await run(person('u-group', ['g1']))).toMatchObject({ allowed: false, reasons: ['custom:no-u-group'] });
    expect((await run(person('u-direct'))).allowed).toBe(true);
    await deletePolicy(tenant(), 'no-u-group');
    expect((await run(person('u-group', ['g1']))).allowed).toBe(true);
  });

  it('`resource in ChannelDeployment` covers every agent run through that deployment, and no other', async () => {
    await putPolicy('freeze-d1', 'forbid (principal, action == Action::"agent.invoke", resource in ChannelDeployment::"D1");');
    expect((await run(person('u-direct'))).allowed).toBe(false);
    expect((await run(person('u-other'), OPEN)).allowed).toBe(true);
    await deletePolicy(tenant(), 'freeze-d1');
  });

  it('a deny rule scoped to the messaging channel leaves the dashboard alone', async () => {
    await putPolicy(
      'no-agent-1',
      'forbid (principal, action == Action::"agent.invoke", resource == Agent::"agent-1") when { context has channel && context.channel == "messaging" };',
    );
    expect((await run(person('u-direct'), DEPLOYMENT, 'messaging', 'agent-1')).allowed).toBe(false);
    expect((await run(person('u-direct'), DEPLOYMENT, 'messaging', 'agent-2')).allowed).toBe(true);
    expect((await run(person('u-owner', [], 'owner'), DEPLOYMENT, 'dashboard', 'agent-1')).allowed).toBe(true);
    await deletePolicy(tenant(), 'no-agent-1');
  });
});

describe('the channel, the seam and what is enforced', () => {
  const facts: IamMessagingDeploymentFacts = {
    id: 'D1', connectionId: 'C1', name: 'Support bot', status: 'enabled',
    agent: { id: 'agent-1', key: 'support', projectId: 'proj-1' },
    access: { mode: 'selected', userIds: ['u1'], groupIds: [] },
  };
  const t = { tenantDbName: 'tenant_x', tenantId: 't1' };

  it('is a channel of the engine, a runtime one, and agent.invoke is decided in it', () => {
    expect(isIamChannel('messaging')).toBe(true);
    expect(RUNTIME_IAM_CHANNELS).toEqual(['portal', 'messaging']);
    expect(RUNTIME_ENFORCED_ACTIONS['agent.invoke']).toEqual(['portal', 'messaging']);
    // only agent.invoke is asked in it: approvals and the rest are not (yet)
    expect(Object.entries(RUNTIME_ENFORCED_ACTIONS).filter(([, c]) => c.includes('messaging')).map(([id]) => id)).toEqual(['agent.invoke']);
    expect(auditServiceOf('messaging', 'agent.invoke')).toBe('channels');
    expect(auditServiceOf('portal', 'agent.invoke')).toBe('portals');
    expect(auditServiceOf('dashboard', 'agent.invoke')).toBe('agents');
  });

  it('knows nothing until the overlay registers a resolver, and the messaging rules are not enforced then', async () => {
    expect(hasIamMessagingResolver()).toBe(false);
    expect(await resolveIamMessagingDeployment(t, 'D1')).toBeNull();
    expect(isRuntimeEnforced('agent.invoke')).toBe(false);
    expect(isRuntimeEnforced('agent.invoke', 'messaging')).toBe(false);
    expect(enforcedChannelsOf('agent.invoke')).toEqual([]);
  });

  it('enforces agent.invoke in the messaging channel once registered, independently of the portal channel', async () => {
    const seen: unknown[] = [];
    registerIamMessagingResolver(async (tenantArg, id) => {
      seen.push([tenantArg, id]);
      return id === 'D1' ? facts : null;
    });
    expect(hasIamMessagingResolver()).toBe(true);
    expect(await resolveIamMessagingDeployment(t, 'D1')).toEqual(facts);
    expect(await resolveIamMessagingDeployment(t, 'nope')).toBeNull();
    expect(seen).toEqual([[t, 'D1'], [t, 'nope']]);

    expect(enforcedChannelsOf('agent.invoke')).toEqual(['messaging']);
    expect(isRuntimeEnforced('agent.invoke', 'messaging')).toBe(true);
    expect(isRuntimeEnforced('agent.invoke', 'portal')).toBe(false);
    expect(isRuntimeEnforced('agent.invoke', 'dashboard')).toBe(false);
    expect(enforcedChannelsOf('portal.use')).toEqual([]);

    registerIamPortalResolver(async () => null);
    expect(enforcedChannelsOf('agent.invoke')).toEqual(['portal', 'messaging']);
    // an action the messaging runtime does not ask keeps its own channels
    expect(enforcedChannelsOf('agent.approve')).toEqual(['dashboard', 'api', 'portal']);
  });

  it('answers null for a resolver that throws or answers nothing - it never guesses a deployment', async () => {
    registerIamMessagingResolver(async () => {
      throw new Error('database down');
    });
    expect(await resolveIamMessagingDeployment(t, 'D1')).toBeNull();
    registerIamMessagingResolver(async () => undefined as never);
    expect(await resolveIamMessagingDeployment(t, 'D1')).toBeNull();
    registerIamMessagingResolver(async () => ({ ...facts, name: 'first' }));
    registerIamMessagingResolver(async () => ({ ...facts, name: 'second' }));
    expect((await resolveIamMessagingDeployment(t, 'D1'))?.name).toBe('second');
  });
});

describe('policy rules about the messaging channel', () => {
  const spec = (over: Partial<PolicySpec> = {}): PolicySpec => {
    const parsed = parsePolicySpec({ effect: 'forbid', principals: { any: true }, actions: ['agent.invoke'], resources: { any: true }, ...over });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    return parsed.spec;
  };
  const reach = (s: PolicySpec) => gateReach(s, currentCatalogView());

  it('accepts messaging as a channel condition', () => {
    expect(spec({ conditions: { channels: ['messaging'] } }).conditions?.channels).toEqual(['messaging']);
  });

  it('a rule limited to the messaging channel reaches the runtime where it exists, and is "not enforced" where it does not', () => {
    const rule = spec({ conditions: { channels: ['messaging'] } });
    expect(reach(rule)).toMatchObject({ portalOnly: true, hasPortal: true, portalPlane: false, portalCovered: false, sessionCovered: false });

    registerIamMessagingResolver(async () => null);
    const where = reach(rule);
    expect(where).toMatchObject({ portalOnly: true, portalCovered: true, portalPlane: true, sessionPlane: false, sessionCovered: false });
    // agent.invoke is no session action just because it is also asked in another channel
    expect(reach(spec({ conditions: { channels: ['dashboard'] } }))).toMatchObject({ portalPlane: false, sessionPlane: false });
  });

  it('a rule that names a deployment resource is a runtime rule, not an unenforced one', () => {
    registerIamMessagingResolver(async () => null);
    const rule = spec({ resources: { resources: [{ type: 'channel-deployment', id: 'D1' }] } });
    expect(reach(rule)).toMatchObject({ portalPlane: true, unenforcedSpecific: 0, portalExplicit: true });
  });
});

describe('the policy center UI', () => {
  it('mirrors the channels of the engine (the client keeps its own copy)', () => {
    expect([...UI_CHANNELS]).toEqual([...IAM_CHANNELS]);
  });

  it('knows the two messaging rules as the deployment\'s access list, with no level and no link to change them', () => {
    expect(parseBuiltInReason(MESSAGING_POLICY_IDS.agent)).toEqual({ kind: 'messagingList', level: null });
    expect(parseBuiltInReason(MESSAGING_POLICY_IDS.agentBoundary)).toEqual({ kind: 'messagingBoundary', level: null });
    expect(reasonLink('messagingList', { type: 'user', id: 'u1' }, null)).toBeNull();
    expect(parseBuiltInReason('managed:messaging:other').kind).toBe('other');
  });
});

describe('the Access check', () => {
  it('does not simulate the messaging channel (it cannot rebuild a deployment\'s list) and says so', async () => {
    const attempt = simulate(
      { tenantDbName: tenant(), tenantId: env.tenantId },
      { principal: { type: 'user', id: 'u1' }, action: 'agent.invoke', resource: { kind: 'resource', type: 'agent', id: 'a1' }, context: { channel: 'messaging' } },
    );
    await expect(attempt).rejects.toBeInstanceOf(SimulateInputError);
    await expect(attempt).rejects.toMatchObject({ code: 'validation', details: [expect.objectContaining({ field: 'context.channel' })] });
  });
});

describe('authorizeResourceAccess in the messaging channel (real helper, engine and audit trail)', () => {
  let tenantId: string;
  let ids: Record<string, string>;
  let groupId: string;

  const facts = (): IamMessagingDeploymentFacts => ({
    id: 'dep-1', connectionId: 'conn-1', name: 'Support bot', status: 'enabled',
    agent: { id: 'agent-1', key: 'support', projectId: 'proj-1' },
    access: { mode: 'selected', userIds: [ids.listed], groupIds: [groupId] },
  });

  const ask = (who: string, over: Partial<ResourceAuthzInput> = {}, f = facts()): ResourceAuthzInput => ({
    tenantDbName: tenant(),
    tenantId,
    userId: ids[who],
    channel: 'messaging',
    action: 'agent.invoke',
    resource: (requester) => messagingAgentResource({ id: f.agent.id, key: f.agent.key, projectId: f.agent.projectId }, { id: f.id, access: f.access }, requester),
    subject: { deploymentId: f.id, connectionId: f.connectionId, resourceName: 'Support bot' },
    client: { requestId: 'req-1', userAgent: 'channels', method: 'POST', path: '/channels/slack' },
    ...over,
  } as ResourceAuthzInput);

  async function denialRows(extra: Record<string, unknown> = {}) {
    await drainPendingTasks();
    return env.db.runWithTenant(tenant(), () => env.db.iamListAuditEvents({ tenantId, service: 'channels', outcome: 'denied', limit: 50, ...extra }));
  }

  beforeAll(async () => {
    ids = {};
    await env.db.runWithTenant(tenant(), async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user') => {
        const user = await env.db.createUser({ tenantId: env.tenantId, email: `${key}@messaging.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [] });
        ids[key] = String(user._id);
      };
      await mk('owner', 'owner');
      await mk('listed', 'user');
      await mk('grouped', 'user');
      await mk('stranger', 'user');
      const group = await env.db.createGroup({ tenantId: env.tenantId, name: 'Retail', tenantRole: 'user', createdBy: 't', source: 'local' } as never);
      groupId = String(group._id);
      await env.db.addGroupMember({ groupId, userId: ids.grouped, tenantId: env.tenantId, role: 'member' });
    });
    tenantId = env.tenantId;
  });

  it('admits the person the list names and a member of a listed group, and writes nothing for an allow', async () => {
    expect(await authorizeResourceAccess(ask('listed'))).toEqual({ allowed: true, source: 'engine', reasons: [], policyIds: [] });
    expect((await authorizeResourceAccess(ask('grouped'))).allowed).toBe(true);
    expect((await denialRows()).items).toHaveLength(0);
  });

  it('refuses a stranger and the workspace owner who is not on the list, and says the access list is why', async () => {
    for (const who of ['stranger', 'owner']) {
      const result = await authorizeResourceAccess(ask(who));
      expect(result).toMatchObject({ allowed: false, source: 'engine', reasons: [MESSAGING_POLICY_IDS.agentBoundary], policyIds: [] });
      expect(result.unavailable).toBeUndefined();
      expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('sees an access-list edit on the very next request', async () => {
    expect((await authorizeResourceAccess(ask('stranger'))).allowed).toBe(false);
    const widened = { ...facts(), access: { mode: 'selected' as const, userIds: [ids.listed, ids.stranger], groupIds: [groupId] } };
    expect((await authorizeResourceAccess(ask('stranger', {}, widened))).allowed).toBe(true);
  });

  it('audits a refusal under the channels service with the deployment and connection, and the decision id finds it', async () => {
    const result = await authorizeResourceAccess(ask('stranger'));
    const rows = (await denialRows({ metadata: { key: 'decisionId', value: result.decisionId! } })).items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      service: 'channels', action: 'write', event: 'agent.invoke', outcome: 'denied', statusCode: 403,
      actorType: 'user', actorUserId: ids.stranger, method: 'POST', path: '/channels/slack',
      resourceType: 'agent', resourceId: 'agent-1',
    });
    expect(rows[0].metadata).toMatchObject({
      iamEnforce: true, code: 'forbidden', decisionId: result.decisionId, action: 'agent.invoke', channel: 'messaging',
      resourceName: 'Support bot', deploymentId: 'dep-1', connectionId: 'conn-1', source: 'engine', reasons: [MESSAGING_POLICY_IDS.agentBoundary],
    });
    expect(rows[0].metadata).not.toHaveProperty('portalId');
  });

  it('gives a repeat inside the minute the same id, and a new person a new one', async () => {
    const first = await authorizeResourceAccess(ask('stranger'));
    expect((await authorizeResourceAccess(ask('stranger'))).decisionId).toBe(first.decisionId);
    expect((await authorizeResourceAccess(ask('owner'))).decisionId).not.toBe(first.decisionId);
  });

  it('reads in words in the denials feed, and the lookup names the resource without replaying it', async () => {
    const result = await authorizeResourceAccess(ask('stranger'));
    await drainPendingTasks();
    const feed = await listAuditFeed({ tenantDbName: tenant(), tenantId }, { kind: 'denials', limit: 50, offset: 0 });
    const item = feed.items.find((i) => i.decisionId === result.decisionId)!;
    expect(item).toMatchObject({
      service: 'channels', action: 'agent.invoke',
      summary: 'Denied stranger running agent "Support bot" from Slack or Teams because they are not on its access list',
      text: { key: 'denied.messagingInvoke', params: { who: 'stranger', resource: 'Support bot', policies: '' } },
    });

    const decision = (await getDecision({ tenantDbName: tenant(), tenantId }, result.decisionId!))!;
    expect(decision).toMatchObject({ channel: 'messaging', code: 'forbidden', resource: { type: 'agent', id: 'agent-1', label: 'Support bot' }, simulateInput: null });
  });

  it('names a custom deny rule in the refusal and its feed text', async () => {
    await putPolicy('no-listed', `forbid (principal == User::"${ids.listed}", action == Action::"agent.invoke", resource);`);
    try {
      const result = await authorizeResourceAccess(ask('listed'));
      expect(result).toMatchObject({ allowed: false, reasons: ['custom:no-listed'], policyIds: ['no-listed'] });
      await drainPendingTasks();
      const feed = await listAuditFeed({ tenantDbName: tenant(), tenantId }, { kind: 'denials', limit: 50, offset: 0 });
      expect(feed.items.find((i) => i.decisionId === result.decisionId)?.text).toMatchObject({ key: 'denied.messagingInvokePolicy' });
    } finally {
      await deletePolicy(tenant(), 'no-listed');
    }
  });

  describe('refuses to decide when it is not usable (503, a decision id, never an allow)', () => {
    const unusable = (result: Awaited<ReturnType<typeof authorizeResourceAccess>>) => {
      expect(result).toMatchObject({ allowed: false, unavailable: true, source: 'unavailable' });
      expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    };

    it('a messaging decision without a deployment id - for a listed person and an owner alike', async () => {
      for (const who of ['listed', 'owner']) {
        unusable(await authorizeResourceAccess(ask(who, { subject: { connectionId: 'conn-1', resourceName: 'Support bot' } } as never)));
        unusable(await authorizeResourceAccess(ask(who, { subject: { deploymentId: '' } } as never)));
        unusable(await authorizeResourceAccess(ask(who, { subject: undefined } as never)));
      }
    });

    it('a portal id does not stand in for a deployment id', async () => {
      unusable(await authorizeResourceAccess(ask('listed', { subject: { portalId: 'portal-1' } } as never)));
    });

    it('an action the messaging runtime does not ask, and a prebuilt principal', async () => {
      unusable(await authorizeResourceAccess(ask('listed', { action: 'agent.approve' } as never)));
      // the dashboard/API twin takes a prebuilt principal; a messaging decision never does (a token could not speak for a person)
      unusable(await authorizeResourceForPrincipal({
        tenantDbName: tenant(), tenantId, userId: ids.listed, channel: 'messaging' as never, action: 'agent.invoke',
        principal: person(ids.listed), subject: { deploymentId: 'dep-1' },
        resource: messagingAgentResource({ id: 'agent-1', projectId: 'proj-1' }, { id: 'dep-1', access: { mode: 'all', userIds: [], groupIds: [] } }),
      }));
    });
  });
});
