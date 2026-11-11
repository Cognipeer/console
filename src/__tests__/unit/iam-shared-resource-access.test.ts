/**
 * Who may use a shared resource of a project (an MCP server's tools, a skill) in an agent run: the record's ACCESS LIST
 * is its built-in policy (managed:access:*), asked for the person the run is made for. Through the REAL engine with
 * request validation on (so the schema delta - McpServer / Skill with mode, allowedUsers, allowedGroups - is exercised),
 * through `authorizeResourceForPerson` with people stored in SQLite, and through the runtime gate the agent uses.
 *
 *   the list       people, groups or everyone; never a role (owners included), never a token
 *   custom rules   a forbid takes an open resource away too; an allow cannot widen a list
 *   the runtime    no person / an anonymous reader: open only; an outage keeps open ones and leaves restricted ones out
 *   storage        the list survives a round trip, and a damaged one reads as closed, never open
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
import type { IResourceAccessList } from '@/lib/database';
import {
  MAX_ACCESS_LIST_ENTRIES,
  accessListResource,
  iamChannelOfRunSource,
  isOpenAccessList,
  parseAccessListInput,
  readAccessList,
} from '@/lib/iam/accessList';
import { ACCESS_LIST_ACTIONS, ACCESS_LIST_RESOURCES, isAccessListAction } from '@/lib/iam/accessListCatalog';
import { RUNTIME_ENFORCED_ACTIONS } from '@/lib/iam/actions';
import { authorize, configureIamEngine, resetIamEngineForTests, type AuthorizeResult } from '@/lib/iam/engine';
import { resetEnforceStatsForTests } from '@/lib/iam/enforce';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { invalidateTenantPolicies } from '@/lib/iam/events';
import { ACCESS_POLICIES, ACCESS_POLICY_IDS, ALL_MANAGED_POLICIES, MANAGED_FORBID_IDS, listManagedPolicies } from '@/lib/iam/managedPolicies';
import { describeManagedPolicy } from '@/lib/iam/policyRows';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { authorizeResourceForPerson, resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { engineSelfTest } from '@/lib/iam/selfTest';
import { buildAgentSkills } from '@/lib/services/agents/agentSkillService';
import { mayUseSharedResource } from '@/lib/services/agents/sharedResourceAccess';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;
const people: Record<string, string> = {};

beforeAll(async () => {
  env = await createIamTestDb('tenant_shared_resource_access');
  hoisted.getDatabase.mockResolvedValue(env.db);
  await env.db.runWithTenant(tenant(), async () => {
    for (const [key, role] of [['listed', 'user'], ['other', 'user'], ['owner', 'owner']] as const) {
      const user = await env.db.createUser({
        tenantId: env.tenantId, email: `${key}@shared.example`, name: key, password: '$2b$10$x', role, licenseId: 'FREE', features: [],
      } as never);
      people[key] = String(user._id);
    }
  });
});
afterAll(async () => {
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
  await drainPendingTasks();
});

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
async function dropPolicy(policyId: string): Promise<void> {
  await env.db.runWithTenant(tenant(), async () => {
    await env.db.iamDocDelete('iam_policies', policyId);
    await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
  });
  invalidateTenantPolicies(tenant());
}

const person = (id: string, groups: string[] = [], role = 'user'): IamPrincipal =>
  userPrincipal({ userId: id, user: { role }, groupIds: groups });

const SELECTED: IResourceAccessList = { mode: 'selected', userIds: ['u-direct'], groupIds: ['g1'] };
const OPEN: IResourceAccessList = { mode: 'all', userIds: [], groupIds: [] };
const NOBODY: IResourceAccessList = { mode: 'selected', userIds: [], groupIds: [] };

/** `null`: a record saved without a list. */
const use = (
  principal: IamPrincipal,
  access: IResourceAccessList | null = SELECTED,
  type: 'mcp-server' | 'skill' = 'mcp-server',
  channel = 'dashboard',
): Promise<AuthorizeResult> =>
  authorize({
    tenant: tenant(),
    principal,
    action: ACCESS_LIST_RESOURCES[type].action,
    resource: accessListResource({ type, id: `${type}-1`, key: `${type}-key`, projectId: 'proj-1', access: access ?? undefined }),
    context: { channel },
  });

describe('the access list as data', () => {
  it('reads a missing list as open and anything malformed as closed, never as open', () => {
    expect(readAccessList(undefined)).toEqual(OPEN);
    expect(readAccessList(null)).toEqual(OPEN);
    expect(readAccessList('all')).toEqual(NOBODY);
    expect(readAccessList({ mode: 'everyone' })).toEqual(NOBODY);
    expect(readAccessList({ mode: 'selected', userIds: ['a', 'a', 7, ''], groupIds: 'g1' })).toEqual({ mode: 'selected', userIds: ['a'], groupIds: [] });
    expect(isOpenAccessList(undefined)).toBe(true);
    expect(isOpenAccessList(NOBODY)).toBe(false);
  });

  it('accepts only a well-formed list from a request', () => {
    expect(parseAccessListInput({ mode: 'selected', userIds: ['u1', 'u1'], groupIds: ['g1'] })).toEqual({
      ok: true, access: { mode: 'selected', userIds: ['u1'], groupIds: ['g1'] },
    });
    expect(parseAccessListInput({ mode: 'all' })).toEqual({ ok: true, access: OPEN });
    for (const bad of [null, 'all', [], { mode: 'everyone' }, { mode: 'selected', userIds: 'u1' }, { mode: 'selected', groupIds: [''] }, { mode: 'selected', userIds: ['x'.repeat(129)] }]) {
      expect(parseAccessListInput(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    const crowd = Array.from({ length: MAX_ACCESS_LIST_ENTRIES + 1 }, (_, i) => `u${i}`);
    expect(parseAccessListInput({ mode: 'selected', userIds: crowd }).ok).toBe(false);
  });

  it('names the channel of a run the way the engine knows it', () => {
    expect(iamChannelOfRunSource('portal')).toBe('portal');
    expect(iamChannelOfRunSource('messaging')).toBe('messaging');
    for (const source of ['api', 'a2a', 'mcp', 'realtime']) expect(iamChannelOfRunSource(source)).toBe('api');
    expect(iamChannelOfRunSource(undefined)).toBe('dashboard');
    expect(iamChannelOfRunSource('studio')).toBe('dashboard');
  });

  it('is one catalog of resource types and their use actions, enforced on every channel a run comes from', () => {
    expect(ACCESS_LIST_ACTIONS).toEqual(['mcp-server.use', 'skill.use']);
    expect(isAccessListAction('skill.use')).toBe(true);
    expect(isAccessListAction('agent.invoke')).toBe(false);
    for (const action of ACCESS_LIST_ACTIONS) {
      expect(RUNTIME_ENFORCED_ACTIONS[action]).toEqual(['dashboard', 'api', 'portal', 'messaging']);
    }
  });
});

describe('the managed access policies', () => {
  it('are two, a permit and a forbid under managed:access, valid against the generated schema', async () => {
    expect(Object.keys(ACCESS_POLICIES).sort()).toEqual(Object.values(ACCESS_POLICY_IDS).sort());
    for (const [id, text] of Object.entries(ACCESS_POLICIES)) {
      expect(text.startsWith('@managed("access")')).toBe(true);
      expect(ALL_MANAGED_POLICIES[id]).toBe(text);
    }
    expect(listManagedPolicies().filter((p) => p.group === 'access').map((p) => [p.id, p.effect]).sort()).toEqual([
      [ACCESS_POLICY_IDS.use, 'permit'],
      [ACCESS_POLICY_IDS.useBoundary, 'forbid'],
    ].sort());
    expect(MANAGED_FORBID_IDS.has(ACCESS_POLICY_IDS.useBoundary)).toBe(true);
    expect(describeManagedPolicy(ACCESS_POLICY_IDS.use)).toMatchObject({ group: 'access', nameKey: 'iamApi.managed.access-use.name' });
    expect(describeManagedPolicy(ACCESS_POLICY_IDS.useBoundary).description).not.toBe('');
    // the first decision builds the schema and loads the set under request validation
    expect((await use(person('u-direct'))).errors).toEqual([]);
    expect(engineSelfTest()).toMatchObject({ ok: true });
  });
});

describe('using an MCP server or a skill in a run (mcp-server.use, skill.use)', () => {
  it('admits a person the list names and a member of a group it names, naming the list', async () => {
    for (const type of ['mcp-server', 'skill'] as const) {
      const direct = await use(person('u-direct'), SELECTED, type);
      expect(direct).toMatchObject({ allowed: true, errors: [] });
      expect(direct.reasons).toContain(ACCESS_POLICY_IDS.use);
      expect((await use(person('u-group', ['g1']), SELECTED, type)).allowed).toBe(true);
    }
  });

  it('admits everyone when the list is open, and a record without a list is open', async () => {
    expect((await use(person('u-other'), OPEN)).allowed).toBe(true);
    expect((await use(person('u-other'), null, 'skill')).allowed).toBe(true);
  });

  it('refuses anybody else, owners included, naming the boundary; an empty selected list admits nobody', async () => {
    expect(await use(person('u-other', ['g9']))).toMatchObject({ allowed: false, reasons: [ACCESS_POLICY_IDS.useBoundary], errors: [] });
    expect((await use(person('u-owner', [], 'owner'))).allowed).toBe(false);
    expect((await use(person('u-direct', [], 'owner'))).allowed).toBe(true);
    expect((await use(person('u-direct'), NOBODY)).allowed).toBe(false);
  });

  it('is the same on every channel a run comes from', async () => {
    for (const channel of ['dashboard', 'api', 'portal', 'messaging']) {
      expect((await use(person('u-direct'), SELECTED, 'skill', channel)).allowed, channel).toBe(true);
      expect((await use(person('u-other'), SELECTED, 'skill', channel)).allowed, channel).toBe(false);
    }
  });

  it('never admits a token: a list names people', async () => {
    const owner = person('u-direct');
    expect((await use(tokenPrincipal({ tokenId: 't1', owner, scope: null }), OPEN)).allowed).toBe(false);
    expect((await use(tokenPrincipal({ tokenId: 't1', owner, scope: null }))).allowed).toBe(false);
  });

  it('lets a custom forbid take an open resource away, and a custom allow cannot widen a list', async () => {
    await putPolicy('custom-forbid', 'forbid (principal == User::"u-other", action == Action::"mcp-server.use", resource);');
    try {
      expect((await use(person('u-other'), OPEN)).allowed).toBe(false);
      expect((await use(person('u-direct'), OPEN)).allowed).toBe(true);
    } finally {
      await dropPolicy('custom-forbid');
    }
    await putPolicy('custom-allow', 'permit (principal, action == Action::"skill.use", resource);');
    try {
      expect((await use(person('u-other'), SELECTED, 'skill')).allowed).toBe(false);
    } finally {
      await dropPolicy('custom-allow');
    }
  });
});

describe('the decision for the person a run is made for (authorizeResourceForPerson)', () => {
  const ask = (userId: string, access: IResourceAccessList | undefined, channel: 'dashboard' | 'api' = 'dashboard') =>
    authorizeResourceForPerson({
      tenantDbName: tenant(),
      tenantId: env.tenantId,
      userId,
      channel,
      action: 'mcp-server.use',
      resource: (requester) => accessListResource({ type: 'mcp-server', id: 'srv-1', key: 'crm', projectId: 'proj-1', access }, requester),
      subject: { resourceName: 'crm' },
    });

  it('loads the stored person and answers from the list', async () => {
    const list: IResourceAccessList = { mode: 'selected', userIds: [people.listed], groupIds: [] };
    expect(await ask(people.listed, list)).toMatchObject({ allowed: true });
    const refused = await ask(people.other, list, 'api');
    expect(refused.allowed).toBe(false);
    expect(refused.unavailable).toBeFalsy();
    expect(refused.reasons).toContain('managed:access:use-boundary');
    expect(await ask(people.owner, list)).toMatchObject({ allowed: false });
    expect(await ask(people.other, undefined)).toMatchObject({ allowed: true });
  });

  it('answers "unavailable" for an action that is not an access-list action, instead of deciding it', async () => {
    const result = await authorizeResourceForPerson({
      tenantDbName: tenant(), tenantId: env.tenantId, userId: people.listed, channel: 'dashboard',
      action: 'agent.invoke' as never,
      resource: accessListResource({ type: 'skill', id: 's1', access: OPEN }),
    });
    expect(result).toMatchObject({ allowed: false, unavailable: true });
  });
});

describe('the runtime gate (mayUseSharedResource)', () => {
  const run = (caller?: Record<string, unknown>, source?: string) => ({
    tenantDbName: tenant(), tenantId: env.tenantId, caller: caller as never, source,
  });
  const record = (access?: IResourceAccessList) => ({ type: 'skill' as const, id: 'sk-1', key: 'triage', projectId: 'proj-1', access });
  const restricted = () => record({ mode: 'selected', userIds: [people.listed], groupIds: [] });

  it('gives a listed person a restricted resource and keeps it from anybody else', async () => {
    expect(await mayUseSharedResource(run({ userId: people.listed, source: 'dashboard' }), restricted())).toBe(true);
    expect(await mayUseSharedResource(run({ userId: people.other }), restricted())).toBe(false);
    expect(await mayUseSharedResource(run({ userId: people.other }, 'api'), restricted())).toBe(false);
  });

  it('gives a run made for no person, or read by anyone, the open resources only', async () => {
    for (const caller of [undefined, { userId: 'system:flow' }, { userId: people.listed, kbReader: 'anonymous' }, {}]) {
      expect(await mayUseSharedResource(run(caller), record()), JSON.stringify(caller)).toBe(true);
      expect(await mayUseSharedResource(run(caller), restricted()), JSON.stringify(caller)).toBe(false);
    }
  });

  it('applies custom deny rules to an open resource when the run is made for a person', async () => {
    await putPolicy('custom-skill-forbid', `forbid (principal == User::"${people.other}", action == Action::"skill.use", resource);`);
    try {
      expect(await mayUseSharedResource(run({ userId: people.other }), record())).toBe(false);
      expect(await mayUseSharedResource(run({ userId: people.listed }), record())).toBe(true);
    } finally {
      await dropPolicy('custom-skill-forbid');
    }
  });

  it('keeps open resources and leaves restricted ones out when the person cannot be loaded', async () => {
    const missing = run({ userId: 'no-such-person' });
    const open = await mayUseSharedResource(missing, record());
    const closed = await mayUseSharedResource(missing, restricted());
    expect(closed).toBe(false);
    // an unknown person is either refused by the list or not decidable; an open resource is never taken away by it
    expect(open).toBe(true);
  });
});

describe('the list in storage (SQLite)', () => {
  it('survives a round trip on an MCP server and a skill, and an update replaces it', async () => {
    await env.db.runWithTenant(tenant(), async () => {
      const server = await env.db.createMcpServer({
        tenantId: env.tenantId, projectId: 'proj-1', key: 'crm', name: 'CRM', sourceType: 'remote', tools: [],
        upstreamAuth: { type: 'none' }, exposure: { protocols: ['streamable-http'], accessMode: 'token' },
        status: 'active', endpointSlug: 'crm-slug', totalRequests: 0, createdBy: 'tester', access: SELECTED,
      } as never);
      expect((await env.db.findMcpServerById(String(server._id)))?.access).toEqual(SELECTED);
      await env.db.updateMcpServer(String(server._id), { access: OPEN } as never);
      expect((await env.db.findMcpServerById(String(server._id)))?.access).toEqual(OPEN);

      const plain = await env.db.createMcpServer({
        tenantId: env.tenantId, projectId: 'proj-1', key: 'plain', name: 'Plain', sourceType: 'remote', tools: [],
        upstreamAuth: { type: 'none' }, exposure: { protocols: ['streamable-http'], accessMode: 'token' },
        status: 'active', endpointSlug: 'plain-slug', totalRequests: 0, createdBy: 'tester',
      } as never);
      expect((await env.db.findMcpServerById(String(plain._id)))?.access).toBeUndefined();

      const skill = await env.db.createSkill({
        tenantId: env.tenantId, projectId: 'proj-1', key: 'triage', title: 'Triage', header: 'h', body: 'b',
        status: 'active', createdBy: 'tester', access: NOBODY,
      });
      expect((await env.db.findSkillById(String(skill._id)))?.access).toEqual(NOBODY);
      await env.db.updateSkill(String(skill._id), { access: SELECTED });
      expect((await env.db.findSkillById(String(skill._id)))?.access).toEqual(SELECTED);
    });
  });

  it('reads a damaged list as closed, never as open', async () => {
    await env.db.runWithTenant(tenant(), async () => {
      const skill = await env.db.createSkill({
        tenantId: env.tenantId, projectId: 'proj-1', key: 'damaged', title: 'Damaged', header: 'h', body: 'b',
        status: 'active', createdBy: 'tester', access: SELECTED,
      });
      const raw = (env.db as unknown as { getTenantDb(): { prepare(sql: string): { run(...args: unknown[]): unknown } } }).getTenantDb();
      raw.prepare('UPDATE agent_skills SET access = ? WHERE id = ?').run('{not json', String(skill._id));
      expect((await env.db.findSkillById(String(skill._id)))?.access).toEqual(NOBODY);
    });
  });
});

describe('the skills an agent run gets (buildAgentSkills)', () => {
  it('leaves a restricted skill out of the run of anybody the list does not name, and of a run made for no one', async () => {
    await env.db.runWithTenant(tenant(), async () => {
      const base = { tenantId: env.tenantId, projectId: 'proj-run', header: 'h', body: 'b', status: 'active' as const, createdBy: 'tester' };
      await env.db.createSkill({ ...base, key: 'open-skill', title: 'Open' });
      await env.db.createSkill({ ...base, key: 'listed-skill', title: 'Listed', access: { mode: 'selected', userIds: [people.listed], groupIds: [] } });
    });
    const keys = async (caller?: Record<string, unknown>) =>
      (await buildAgentSkills(tenant(), 'proj-run', ['open-skill', 'listed-skill'], {
        tenantDbName: tenant(), tenantId: env.tenantId, caller: caller as never, source: 'dashboard',
      })).map((skill) => skill.key);

    expect(await keys({ userId: people.listed })).toEqual(['open-skill', 'listed-skill']);
    expect(await keys({ userId: people.other })).toEqual(['open-skill']);
    expect(await keys(undefined)).toEqual(['open-skill']);
    expect(await keys({ userId: people.listed, kbReader: 'anonymous' })).toEqual(['open-skill']);
  });
});
