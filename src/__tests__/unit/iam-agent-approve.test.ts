/**
 * `agent.approve` in the engine: who may answer a pending request of an agent session.
 *
 * The managed rule (`managed:agent:*`) reads the session's owners and the agent's own
 * "who can approve" setting. `agent.approve` sits in the Write level, but the generic RBAC
 * Write permits leave it out: it is APPOINTED, so holding `agents:write` alone approves
 * nothing. The table below is the acceptance table: three settings x nine kinds of caller,
 * as the old `mayResolve` decided (plus what a token owned by a project admin newly gets).
 * Then the rest of the contract: a custom allow rule appoints more approvers (a compliance
 * group), custom deny rules narrow, the token and project limits and the portal's list
 * apply on top, the session actions of "somebody else's session" default to today's
 * behaviour, and the compiler tells an administrator the truth about what a rule can do.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { registerIamPortalResolver } from '@/enterprise/iam-portal';
import { agentSessionResource, portalAgentSessionResource, type AgentApprovers } from '@/lib/iam/agentEntities';
import { authorize, configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { tokenPrincipal, userPrincipal, type IamPrincipal, type IamResource } from '@/lib/iam/entities';
import { compileSpec, type PolicySpec } from '@/lib/iam/policySpec';
import { validateCustomPolicyText } from '@/lib/iam/policyText';
import { AGENT_POLICIES, MANAGED_POLICIES } from '@/lib/iam/managedPolicies';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

beforeAll(async () => {
  env = await createIamTestDb('tenant_agent_approve');
  hoisted.getDatabase.mockResolvedValue(env.db);
});
afterAll(async () => {
  registerIamPortalResolver(null);
  configureIamEngine({ validateRequests: false });
  await env.cleanup();
});
beforeEach(async () => {
  registerIamPortalResolver(null);
  // Every request is validated against the generated schema: an attribute the schema does not declare would fail here.
  configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
  resetIamEngineForTests();
  for (const p of await listPolicies(tenant())) await deletePolicy(tenant(), p.policyId);
});

const P1 = 'p1';
const P2 = 'p2';

/** The session: started by `starter`, in project p1. */
const session = (approvers: AgentApprovers, extra: { owners?: string[]; id?: string } = {}): IamResource => agentSessionResource({
  id: extra.id ?? 'a1', key: 'support', projectId: P1, ownerIds: extra.owners ?? ['starter'], approvers,
});

const person = (userId: string, over: Partial<Parameters<typeof userPrincipal>[0]> = {}) =>
  userPrincipal({ userId, user: { role: 'user' }, projects: [P1], adminProjects: [], ...over });

const decide = async (principal: IamPrincipal, resource: IamResource, action = 'agent.approve', channel = 'dashboard') =>
  authorize({ tenant: tenant(), principal, action, resource, context: { channel, projectId: P1 } });

/** The nine kinds of caller of the acceptance table. */
const CALLERS: Record<string, () => IamPrincipal> = {
  'the person who started the session': () => person('starter'),
  'another member of the project': () => person('other'),
  'an admin of that project': () => person('padmin', { adminProjects: [P1] }),
  'a member / admin of another project only': () => person('elsewhere', { projects: [P2], adminProjects: [P2] }),
  'a workspace admin': () => person('wsadmin', { user: { role: 'admin' }, projects: [P1, P2], adminProjects: [P1, P2] }),
  'the starter\'s unscoped token': () => tokenPrincipal({ tokenId: 't-starter', owner: person('starter'), scope: null }),
  'the starter\'s token scoped to read agents': () => tokenPrincipal({ tokenId: 't-read', owner: person('starter'), scope: { agents: 'read' } }),
  'another member\'s token': () => tokenPrincipal({ tokenId: 't-other', owner: person('other'), scope: null }),
  'a project admin\'s token': () => tokenPrincipal({ tokenId: 't-padmin', owner: person('padmin', { adminProjects: [P1] }), scope: null }),
};

/** [owner, owner_or_admin, project_members] per caller - the acceptance table. */
const TABLE: Record<string, [boolean, boolean, boolean]> = {
  'the person who started the session': [true, true, true],
  'another member of the project': [false, false, true],
  'an admin of that project': [false, true, true],
  'a member / admin of another project only': [false, false, false],
  'a workspace admin': [false, true, true],
  'the starter\'s unscoped token': [true, true, true],
  'the starter\'s token scoped to read agents': [false, false, false],
  'another member\'s token': [false, false, true],
  'a project admin\'s token': [false, true, true],
};

describe('the managed approval rule', () => {
  const MODES: AgentApprovers[] = ['owner', 'owner_or_admin', 'project_members'];

  for (const [caller, make] of Object.entries(CALLERS)) {
    it.each(MODES.map((mode, i) => [mode, TABLE[caller][i]] as const))(`${caller}, under "%s": %s`, async (mode, expected) => {
      const result = await decide(make(), session(mode));
      expect(result.errors).toEqual([]);
      expect(result.allowed).toBe(expected);
    });
  }

  it('a plain agents writer is NOT let in by the Write level (the generic Write permits leave agent.approve out)', async () => {
    const stranger = person('stranger');
    const generic = await authorize({
      tenant: tenant(), principal: stranger, action: 'agents.write', resource: { kind: 'service', service: 'agents' }, context: { channel: 'dashboard' },
    });
    expect(generic.allowed).toBe(true); // they may write agents...
    const result = await decide(stranger, session('owner'));
    expect(result.allowed).toBe(false); // ...and still cannot answer somebody else's request
    expect(result.errors).toEqual([]);
    expect(result.reasons).toEqual([]); // nothing forbids them: nothing appoints them (a default deny)
    // the same for a token of such a person
    const strangersToken = tokenPrincipal({ tokenId: 't-stranger', owner: stranger, scope: null });
    expect((await decide(strangersToken, session('owner'))).allowed).toBe(false);
  });

  it('the managed set has no boundary on the action: three agent rules less one, two permits', () => {
    expect(Object.keys(AGENT_POLICIES)).toEqual(['managed:agent:approve', 'managed:agent:approve-token']);
    expect(MANAGED_POLICIES['managed:rbac:user-write']).toContain('action != Action::"agent.approve"');
    expect(MANAGED_POLICIES['managed:rbac:token-write']).toContain('action != Action::"agent.approve"');
  });

  it('a session nobody started (a2a-public, a schedule) is somebody else\'s: only the agent\'s setting lets anyone in', async () => {
    const owners = ['a2a-public', 'system:agent-scheduler'];
    expect((await decide(person('starter'), session('owner', { owners }))).allowed).toBe(false);
    expect((await decide(person('padmin', { adminProjects: [P1] }), session('owner_or_admin', { owners }))).allowed).toBe(true);
    expect((await decide(person('other'), session('project_members', { owners }))).allowed).toBe(true);
  });

  it('either person who started the turn counts: the session\'s creator and whoever raised the request', async () => {
    const resource = session('owner', { owners: ['starter', 'continued-it'] });
    expect((await decide(person('continued-it'), resource)).allowed).toBe(true);
    expect((await decide(person('starter'), resource)).allowed).toBe(true);
    expect((await decide(person('other'), resource)).allowed).toBe(false);
  });

  it('the legacy workspace role project_admin counts as an admin inside the projects the person belongs to, and nowhere else', async () => {
    const legacy = person('legacy', { user: { role: 'project_admin' } });
    expect((await decide(legacy, session('owner_or_admin'))).allowed).toBe(true);
    expect((await decide(person('legacy2', { user: { role: 'project_admin' }, projects: [P2] }), session('owner_or_admin'))).allowed).toBe(false);
    expect((await decide(legacy, session('owner'))).allowed).toBe(false);
  });

  it('an agent asked about without the session\'s attributes is refused for everybody (nothing to read the rule from)', async () => {
    const bare: IamResource = { kind: 'resource', type: 'agent', id: 'a1', service: 'agents', projectId: P1 };
    for (const make of Object.values(CALLERS)) expect((await decide(make(), bare)).allowed).toBe(false);
  });

  it('the project the session is in decides project_members: the agent row\'s project is not used', async () => {
    const elsewhere = agentSessionResource({ id: 'a1', projectId: P2, ownerIds: ['starter'], approvers: 'project_members' });
    expect((await decide(person('other'), elsewhere)).allowed).toBe(false);
    expect((await decide(person('other', { projects: [P2] }), elsewhere)).allowed).toBe(true);
  });
});

describe('custom rules on top', () => {
  const forbidUser = (userId: string): PolicySpec => ({
    effect: 'forbid', principals: { users: [userId] }, actions: ['agent.approve'], resources: { any: true },
  });

  it('a deny names a person and wins over everything - the person who started the session included', async () => {
    const compiled = await compileSpec(forbidUser('starter'));
    expect(compiled.errors).toEqual([]);
    expect(compiled.ok).toBe(true); // the agent routes ask about it in this build, so a deny about it is not a false assurance
    await createPolicy(tenant(), { policyId: 'no-starter', name: 'Starter may not approve', cedar: compiled.cedar, spec: compiled.spec }, 't');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

    const denied = await decide(person('starter'), session('owner'));
    expect(denied.allowed).toBe(false);
    expect(denied.reasons).toContain('custom:no-starter');
    // everybody else is unaffected
    expect((await decide(person('padmin', { adminProjects: [P1] }), session('owner_or_admin'))).allowed).toBe(true);
    // ...and the person's token cannot walk around it
    const viaToken = tokenPrincipal({ tokenId: 't', owner: person('starter'), scope: null });
    expect((await decide(viaToken, session('owner'))).allowed).toBe(false);
  });

  it('a deny can be written for one agent, a group or a channel in the visual editor (no raw Cedar)', async () => {
    const oneAgent = await compileSpec({ effect: 'forbid', principals: { anyUser: true }, actions: ['agent.approve'], resources: { resources: [{ type: 'agent', id: 'a-frozen' }] } });
    expect(oneAgent.ok).toBe(true);
    await createPolicy(tenant(), { policyId: 'freeze', name: 'Freeze a-frozen', cedar: oneAgent.cedar, spec: oneAgent.spec }, 't');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    expect((await decide(person('starter'), session('owner', { id: 'a-frozen' }))).allowed).toBe(false);
    expect((await decide(person('starter'), session('owner', { id: 'a-open' }))).allowed).toBe(true);
  });

  it('a custom allow rule APPOINTS approvers: a compliance group answers across agents, for people and for their tokens', async () => {
    const compiled = await compileSpec({
      effect: 'permit', principals: { groups: ['compliance'] }, actions: ['agent.approve'], resources: { any: true },
    });
    expect(compiled.errors).toEqual([]);
    expect(compiled.ok).toBe(true);
    await createPolicy(tenant(), { policyId: 'compliance-approvers', name: 'Compliance approves', cedar: compiled.cedar, spec: compiled.spec }, 't');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });

    const auditor = person('auditor', { groupIds: ['compliance'], projects: [] });
    const allowed = await decide(auditor, session('owner'));
    expect(allowed.errors).toEqual([]);
    expect(allowed.allowed).toBe(true);
    expect(allowed.reasons).toContain('custom:compliance-approvers');
    // ...in every agent and every setting, the group is not tied to a project
    expect((await decide(auditor, session('owner', { id: 'a2' }))).allowed).toBe(true);
    // their token approves too, unless it is scoped away from agents
    expect((await decide(tokenPrincipal({ tokenId: 't-aud', owner: auditor, scope: null }), session('owner'))).allowed).toBe(true);
    expect((await decide(tokenPrincipal({ tokenId: 't-aud-r', owner: auditor, scope: { agents: 'read' } }), session('owner'))).allowed).toBe(false);
    // somebody who is not in the group is where they were
    expect((await decide(person('other'), session('owner'))).allowed).toBe(false);
  });

  it('a custom deny narrows an appointment and the managed rule alike', async () => {
    const allow = await compileSpec({ effect: 'permit', principals: { groups: ['compliance'] }, actions: ['agent.approve'], resources: { any: true } });
    const deny = await compileSpec({ effect: 'forbid', principals: { groups: ['compliance'] }, actions: ['agent.approve'], resources: { resources: [{ type: 'agent', id: 'a-secret' }] } });
    await createPolicy(tenant(), { policyId: 'appoint', name: 'appoint', cedar: allow.cedar, spec: allow.spec }, 't');
    await createPolicy(tenant(), { policyId: 'keep-out', name: 'keep out', cedar: deny.cedar, spec: deny.spec }, 't');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    const auditor = person('auditor', { groupIds: ['compliance'], projects: [] });
    expect((await decide(auditor, session('owner', { id: 'a-open' }))).allowed).toBe(true);
    const refused = await decide(auditor, session('owner', { id: 'a-secret' }));
    expect(refused.allowed).toBe(false);
    expect(refused.reasons).toContain('custom:keep-out');
  });

  it('an appointment does not get round the limits of the request: a token scope and a project\'s own limit still forbid', async () => {
    const allow = await compileSpec({ effect: 'permit', principals: { anyUser: true }, actions: ['agent.approve'], resources: { any: true } });
    await createPolicy(tenant(), { policyId: 'everyone', name: 'everyone approves', cedar: allow.cedar, spec: allow.spec }, 't');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    // project narrowing: the project's own limit for this member is below Write on agents
    const limited = { ...person('limited'), projDeny: { read: [], write: ['agents'], admin: [] } };
    const result = await decide(limited, session('owner'));
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('managed:boundary:project-write');
    // a token scoped to reading agents: the scope forbids
    const scoped = await decide(tokenPrincipal({ tokenId: 't-scoped', owner: person('other'), scope: { agents: 'read' } }), session('owner'));
    expect(scoped.allowed).toBe(false);
    expect(scoped.reasons).toContain('managed:boundary:token-cap-write');
  });

  it('the compiler says so: an allow rule about agent.approve appoints approvers - and reminds that they need Write on Agents', async () => {
    const only = await compileSpec({ effect: 'permit', principals: { anyUser: true }, actions: ['agent.approve'], resources: { any: true } });
    expect(only.ok).toBe(true);
    expect(only.warnings.map((w) => w.code)).toEqual(['approval_needs_agents_write']);
    // ...a rule that also hands out Write on agents needs no reminder
    const withWrite = await compileSpec({ effect: 'permit', principals: { anyUser: true }, actions: ['agent.approve', 'agents.write'], resources: { any: true } });
    expect(withWrite.warnings.map((w) => w.code)).toEqual([]);
    // an allow rule the routes can never meet is still told so (here: resources of another kind)
    const nowhere = await compileSpec({ effect: 'permit', principals: { anyUser: true }, actions: ['agent.approve'], resources: { services: ['models'] } });
    expect(nowhere.warnings.map((w) => w.code)).not.toContain('approval_needs_agents_write');
    expect(nowhere.warnings.map((w) => w.code)).toContain('session_wrong_scope');
    // a deny says nothing of the kind
    expect((await compileSpec(forbidUser('starter'))).warnings.map((w) => w.code)).toEqual([]);
  });

  it('the compiler says when an allow rule appoints approvers only through the Write level, which its author may not have meant', async () => {
    const write = await compileSpec({ effect: 'permit', principals: { groups: ['editors'] }, actions: ['Write'], resources: { services: ['agents'] } });
    expect(write.ok).toBe(true);
    expect(write.warnings.map((w) => w.code)).toContain('write_includes_approval');
    // naming the action, or a rule whose resources never reach an agent, says something else or nothing
    const specific = await compileSpec({ effect: 'permit', principals: { groups: ['editors'] }, actions: ['agents.write'], resources: { services: ['agents'] } });
    expect(specific.warnings.map((w) => w.code)).not.toContain('write_includes_approval');
    const elsewhere = await compileSpec({ effect: 'permit', principals: { groups: ['editors'] }, actions: ['Write'], resources: { services: ['models'] } });
    expect(elsewhere.warnings.map((w) => w.code)).not.toContain('write_includes_approval');
    // a deny that covers the Write level narrows, it appoints nobody
    const deny = await compileSpec({ effect: 'forbid', principals: { groups: ['editors'] }, actions: ['Write'], resources: { services: ['agents'] } });
    expect(deny.warnings.map((w) => w.code)).not.toContain('write_includes_approval');
  });

  it('and a Write-level allow rule really does appoint them (the engine agrees with the warning)', async () => {
    const write = await compileSpec({ effect: 'permit', principals: { groups: ['editors'] }, actions: ['Write'], resources: { services: ['agents'] } });
    await createPolicy(tenant(), { policyId: 'editors-write', name: 'editors write', cedar: write.cedar, spec: write.spec }, 't');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    const editor = person('editor', { groupIds: ['editors'], projects: [] });
    expect((await decide(editor, session('owner'))).allowed).toBe(true);
    expect((await decide(person('stranger'), session('owner'))).allowed).toBe(false);
  });

  it('raw Cedar about the session attributes validates against the schema (`resource.owners`, `resource.approvers`)', () => {
    expect(validateCustomPolicyText(
      'forbid (principal is User, action == Action::"agent.approve", resource is Agent) when { resource has owners && !resource.owners.contains(principal) };',
    )).toMatchObject({ valid: true, errors: [] });
    expect(validateCustomPolicyText(
      'forbid (principal, action == Action::"agent.approve", resource is Agent) when { resource has approvers && resource.approvers == "project_members" };',
    ).valid).toBe(true);
    // an attribute the schema does not declare is refused
    expect(validateCustomPolicyText(
      'forbid (principal, action == Action::"agent.approve", resource is Agent) when { resource.nope == "x" };',
    ).valid).toBe(false);
  });
});

describe('what the compiler says about a rule on the session actions', () => {
  const spec = (over: Partial<PolicySpec>): PolicySpec => ({
    effect: 'forbid', principals: { anyUser: true }, actions: ['agent.approve'], resources: { any: true }, ...over,
  });
  const codes = (issues: Array<{ code?: string }>) => issues.map((i) => i.code).sort();

  it('accepts a deny that the agent routes can meet: any channel of the dashboard / API, an agent, a project, the agents service', async () => {
    for (const over of [
      {},
      { conditions: { channels: ['api' as const] } },
      { actions: ['agent.session_view_others'], resources: { services: ['agents'] } },
      { actions: ['agent.session_manage_others'], resources: { projects: [P1] } },
      { resources: { resources: [{ type: 'agent', id: 'a1' }] } },
      { actions: ['Write'], resources: { any: true } },
    ]) {
      const out = await compileSpec(spec(over));
      expect(out.errors, JSON.stringify(over)).toEqual([]);
      expect(out.ok).toBe(true);
    }
  });

  it('refuses a deny that none of them can meet - and says why', async () => {
    // resources of another kind
    const wrongScope = await compileSpec(spec({ resources: { services: ['models'] } }));
    expect(wrongScope.ok).toBe(false);
    expect(codes(wrongScope.errors)).toEqual(['session_wrong_scope']);
    const wrongResource = await compileSpec(spec({ actions: ['agent.session_view_others'], resources: { resources: [{ type: 'tool', id: 't1' }] } }));
    expect(codes(wrongResource.errors)).toContain('session_wrong_scope');
    // the portal channel alone, in a build without portals (and for the two session views, which no portal asks)
    const portalOnly = await compileSpec(spec({ conditions: { channels: ['portal'] } }));
    expect(codes(portalOnly.errors)).toEqual(['not_enforced_channel']);
    const viewInPortal = await compileSpec(spec({ actions: ['agent.session_view_others'], conditions: { channels: ['portal'] } }));
    expect(codes(viewInPortal.errors)).toEqual(['not_enforced_channel']);
    // ...which a portal makes true for approvals
    registerIamPortalResolver(async () => null);
    expect((await compileSpec(spec({ conditions: { channels: ['portal'] } }))).ok).toBe(true);
    expect(codes((await compileSpec(spec({ actions: ['agent.session_view_others'], conditions: { channels: ['portal'] } }))).errors)).toEqual(['not_enforced_channel']);
  });

  it('judges raw Cedar the same way', () => {
    expect(validateCustomPolicyText('forbid (principal, action == Action::"agent.approve", resource is Agent);').valid).toBe(true);
    expect(validateCustomPolicyText('forbid (principal, action == Action::"agent.approve", resource in Project::"p1");').valid).toBe(true);
    expect(validateCustomPolicyText('forbid (principal, action == Action::"agent.approve", resource == Tool::"t1");').valid).toBe(false);
    expect(validateCustomPolicyText('forbid (principal, action == Action::"agent.update", resource is Agent);').valid).toBe(false); // nothing asks it
  });
});

describe('in a portal (the channel of the enterprise portal runtime)', () => {
  const access = { mode: 'selected' as const, userIds: ['listed-owner'], groupIds: [] };
  const portal = { id: 'portal-1', access };
  const inPortal = (approvers: AgentApprovers, owners: string[]) => portalAgentSessionResource(
    { id: 'a1', projectId: P1, ownerIds: owners, approvers }, portal,
  );
  const ask = (principal: IamPrincipal, resource: IamResource) => authorize({
    tenant: tenant(), principal, action: 'agent.approve', resource, context: { channel: 'portal' },
  });

  it('answers only for people on the portal\'s access list, on top of the approval rule', async () => {
    // the person who started it AND is on the list
    expect((await ask(person('listed-owner'), inPortal('owner_or_admin', ['listed-owner']))).allowed).toBe(true);
    // ...started it but is not (or no longer) on the list
    const left = await ask(person('former-user'), inPortal('owner_or_admin', ['former-user']));
    expect(left.allowed).toBe(false);
    expect(left.reasons).toContain('managed:portal:agent-boundary');
    // a workspace admin the approval rule accepts is still not on the list
    expect((await ask(person('wsadmin', { user: { role: 'admin' } }), inPortal('owner_or_admin', ['listed-owner']))).allowed).toBe(false);
  });

  it('a token never answers through a portal', async () => {
    const token = tokenPrincipal({ tokenId: 't', owner: person('listed-owner'), scope: null });
    expect((await ask(token, inPortal('owner', ['listed-owner']))).allowed).toBe(false);
  });
});

describe('looking at and acting on somebody else\'s session', () => {
  const resource = () => session('owner_or_admin');
  const ask = (principal: IamPrincipal, action: string) => decide(principal, resource(), action);

  it('are in the Read and Write levels: today\'s behaviour, nothing narrower, until a rule says so', async () => {
    const reader = person('reader', { user: { role: 'user', servicePermissions: { agents: 'read' } } });
    expect((await ask(reader, 'agent.session_view_others')).allowed).toBe(true);
    expect((await ask(reader, 'agent.session_manage_others')).allowed).toBe(false); // read only
    expect((await ask(person('writer'), 'agent.session_manage_others')).allowed).toBe(true);
    const none = person('none', { user: { role: 'user', servicePermissions: { agents: 'none' } } });
    expect((await ask(none, 'agent.session_view_others')).allowed).toBe(false);
    // a scoped token is capped by its scope, as for any Read / Write action
    const scoped = tokenPrincipal({ tokenId: 't', owner: person('writer'), scope: { agents: 'read' } });
    expect((await ask(scoped, 'agent.session_view_others')).allowed).toBe(true);
    expect((await ask(scoped, 'agent.session_manage_others')).allowed).toBe(false);
  });

  it('a deny restricts them, with no raw Cedar - for a group, a person or a project', async () => {
    const compiled = await compileSpec({
      effect: 'forbid', principals: { users: ['contractor'] }, actions: ['agent.session_view_others'], resources: { projects: [P1] },
    });
    expect(compiled.errors).toEqual([]);
    expect(compiled.ok).toBe(true);
    await createPolicy(tenant(), { policyId: 'own-only', name: 'Contractors see their own sessions', cedar: compiled.cedar, spec: compiled.spec }, 't');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    expect((await ask(person('contractor'), 'agent.session_view_others')).allowed).toBe(false);
    expect((await ask(person('employee'), 'agent.session_view_others')).allowed).toBe(true);
    // managing is a separate action: the rule above does not touch it
    expect((await ask(person('contractor'), 'agent.session_manage_others')).allowed).toBe(true);
  });

  it('are asked in the dashboard and API channels only: no portal runtime asks them', async () => {
    const { isRuntimeEnforced } = await import('@/lib/iam/runtimeEnforced');
    for (const id of ['agent.session_view_others', 'agent.session_manage_others']) {
      expect(isRuntimeEnforced(id, 'dashboard'), id).toBe(true);
      expect(isRuntimeEnforced(id, 'api'), id).toBe(true);
      expect(isRuntimeEnforced(id, 'portal'), id).toBe(false);
    }
  });
});

describe('the Agent entity of a session (agentEntities.ts)', () => {
  const owners = (resource: IamResource) => (resource.kind === 'resource' ? (resource.attrs?.owners as Array<{ __entity: { type: string; id: string } }>) : []);

  it('lists the people who started it once each, without empty entries, as User references', () => {
    const resource = agentSessionResource({ id: 'a1', projectId: P1, ownerIds: ['u1', '', ' u2 ', 'u1', null, undefined, 'a2a-public'], approvers: 'owner' });
    expect(owners(resource)).toEqual([
      { __entity: { type: 'User', id: 'u1' } }, { __entity: { type: 'User', id: 'u2' } }, { __entity: { type: 'User', id: 'a2a-public' } },
    ]);
    expect(resource).toMatchObject({ kind: 'resource', type: 'agent', service: 'agents', projectId: P1, attrs: { approvers: 'owner' } });
  });

  it('reads an unknown or missing setting as the default (workspace and project admins)', () => {
    const approversOf = (approvers: unknown) => (agentSessionResource({ id: 'a1', ownerIds: [], approvers: approvers as string }) as { attrs: Record<string, unknown> }).attrs.approvers;
    for (const approvers of [undefined, null, '', 'everyone', 7]) expect(approversOf(approvers)).toBe('owner_or_admin');
    for (const approvers of ['owner', 'owner_or_admin', 'project_members']) expect(approversOf(approvers)).toBe(approvers);
  });

  it('cannot be made to claim another service: the protected attributes win', () => {
    const resource = agentSessionResource({ id: 'a1', ownerIds: ['u1'] });
    expect(resource).toMatchObject({ service: 'agents' });
    expect((resource as { attrs: Record<string, unknown> }).attrs).not.toHaveProperty('service');
  });

  it('keeps the list short: a session has one or two owners, never a thousand', () => {
    const many = agentSessionResource({ id: 'a1', ownerIds: Array.from({ length: 500 }, (_, i) => `u${i}`) });
    expect(owners(many).length).toBeLessThanOrEqual(20);
  });
});
