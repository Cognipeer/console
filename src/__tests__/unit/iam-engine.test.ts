/**
 * Policy engine: custom policies layered on the managed set, hot-swap on
 * policy changes, enabled / disabled policies, obligations, failure behaviour
 * (never throws; a failure is flagged, never turned into an allow) and a
 * non-gating latency smoke.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The real helper closes over the module-local getDatabase, which this mock
    // cannot rebind — so re-implement it on top of the stubbed one.
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import {
  authorize,
  authorizeGate,
  configureIamEngine,
  describeTenantPolicySet,
  getIamEngineStats,
  resetIamEngineForTests,
} from '@/lib/iam/engine';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { createPolicy, deletePolicy, updatePolicy } from '@/lib/iam/store';
import { invalidateTenantPolicies } from '@/lib/iam/events';
import { createIamTestDb, type IamTestDb } from '../helpers/iamTestDb';

let env: IamTestDb;
const tenant = () => env.tenantDbName;

/**
 * These tests exercise how the ENGINE evaluates policies about one resource
 * (`agent.delete` on an agent). The store refuses to save such a forbid - the
 * request gates do not check individual resources yet, so it would never block
 * anything - so they put the policy in the way another node's write would arrive:
 * straight into the policy collection, then announce it.
 */
async function putPolicy(policyId: string, cedar: string, extra: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  await env.db.runWithTenant(tenant(), async () => {
    await env.db.iamDocPut('iam_policies', policyId, {
      _id: policyId, policyId, name: policyId, cedar, spec: null, enabled: true,
      createdBy: 'tester', updatedBy: 'tester', createdAt: now, updatedAt: now, ...extra,
    });
    await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
  });
  invalidateTenantPolicies(tenant());
}

const agentRes = { kind: 'resource', type: 'agent', id: 'a1', service: 'agents', projectId: 'p1' } as const;
const member = (extra: Partial<Parameters<typeof userPrincipal>[0]> = {}): IamPrincipal =>
  userPrincipal({ userId: 'u1', user: { role: 'user' }, ...extra });

beforeAll(async () => {
  env = await createIamTestDb('tenant_engine');
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

describe('custom policies on top of the managed set', () => {
  it('a forbid takes effect immediately on this node and can be disabled/removed again', async () => {
    const principal = member();
    const input = { tenant: tenant(), principal, action: 'agent.delete', resource: agentRes };
    expect((await authorize(input)).allowed).toBe(true);

    await putPolicy('no-agent-delete', 'forbid(principal, action == Action::"agent.delete", resource is Agent);');
    const denied = await authorize(input);
    expect(denied.allowed).toBe(false);
    expect(denied.reasons).toEqual(['custom:no-agent-delete']);
    // other actions are untouched
    expect((await authorize({ ...input, action: 'agent.get' })).allowed).toBe(true);

    await updatePolicy(tenant(), 'no-agent-delete', { enabled: false }, 'tester');
    expect((await authorize(input)).allowed).toBe(true);
    await updatePolicy(tenant(), 'no-agent-delete', { enabled: true }, 'tester');
    expect((await authorize(input)).allowed).toBe(false);
    await deletePolicy(tenant(), 'no-agent-delete');
    expect((await authorize(input)).allowed).toBe(true);
  });

  it('a forbid overrides a managed permit even for the owner', async () => {
    await createPolicy(tenant(), { policyId: 'freeze-models', name: 'freeze', cedar: 'forbid(principal, action in Action::"Write", resource) when { resource.service == "models" };' }, 'tester');
    const owner = userPrincipal({ userId: 'o', user: { role: 'owner' } });
    expect((await authorizeGate({ tenant: tenant(), principal: owner, service: 'models', method: 'POST' })).allowed).toBe(false);
    expect((await authorizeGate({ tenant: tenant(), principal: owner, service: 'models', method: 'GET' })).allowed).toBe(true);
    expect((await authorizeGate({ tenant: tenant(), principal: owner, service: 'agents', method: 'POST' })).allowed).toBe(true);
    await deletePolicy(tenant(), 'freeze-models');
  });

  it('a custom permit grants what RBAC does not, and its annotations come back as obligations', async () => {
    const noAgents = member({ user: { role: 'user', servicePermissions: { agents: 'none' } } });
    const input = { tenant: tenant(), principal: noAgents, action: 'agent.invoke', resource: agentRes };
    expect((await authorize(input)).allowed).toBe(false);

    await createPolicy(tenant(), {
      policyId: 'invoke-with-guardrail',
      name: 'invoke',
      cedar: '@guardrail("pii-strict") @limits("{\\"rpm\\":10}") @max("3") @label("plain text") permit(principal is User, action == Action::"agent.invoke", resource is Agent) when { principal.role == "user" };',
    }, 'tester');
    const res = await authorize(input);
    expect(res.allowed).toBe(true);
    expect(res.reasons).toEqual(['custom:invoke-with-guardrail']);
    expect(res.obligations).toEqual({ guardrail: 'pii-strict', limits: { rpm: 10 }, max: 3, label: 'plain text' });
    // a deny carries no obligations
    expect((await authorize({ ...input, action: 'agent.update' })).obligations).toEqual({});
    await deletePolicy(tenant(), 'invoke-with-guardrail');
  });

  it('obligations only come from the permits that determined the decision; clashes resolve by policy id', async () => {
    await createPolicy(tenant(), { policyId: 'b-second', name: 'b', cedar: '@guardrail("b") @extra("1") permit(principal is User, action == Action::"agent.invoke", resource is Agent);' }, 't');
    await createPolicy(tenant(), { policyId: 'a-first', name: 'a', cedar: '@guardrail("a") permit(principal is User, action == Action::"agent.invoke", resource is Agent);' }, 't');
    const res = await authorize({ tenant: tenant(), principal: member(), action: 'agent.invoke', resource: agentRes });
    expect(res.allowed).toBe(true);
    expect(res.reasons).toEqual(expect.arrayContaining(['managed:rbac:user-write', 'custom:a-first', 'custom:b-second']));
    expect(res.obligations).toEqual({ guardrail: 'a', extra: 1 });
    await deletePolicy(tenant(), 'b-second');
    await deletePolicy(tenant(), 'a-first');
  });

  it('matches on group membership, project containment and token attributes', async () => {
    await createPolicy(tenant(), { policyId: 'grp', name: 'grp', cedar: 'permit(principal in Group::"g-ml", action == Action::"agent.invoke", resource is Agent);' }, 't');
    await putPolicy('proj', 'forbid(principal, action == Action::"agent.delete", resource in Project::"p-frozen");');
    await putPolicy('tok', 'forbid(principal is ApiToken, action == Action::"agent.update", resource) when { principal has project && principal.project == Project::"p-ci" };');

    const none = member({ user: { role: 'user', servicePermissions: { agents: 'none' } } });
    expect((await authorize({ tenant: tenant(), principal: none, action: 'agent.invoke', resource: agentRes })).allowed).toBe(false);
    const inGroup = { ...none, groupIds: ['g-ml'] };
    expect((await authorize({ tenant: tenant(), principal: inGroup, action: 'agent.invoke', resource: agentRes })).allowed).toBe(true);

    const u = member();
    expect((await authorize({ tenant: tenant(), principal: u, action: 'agent.delete', resource: { ...agentRes, projectId: 'p-frozen' } })).allowed).toBe(false);
    expect((await authorize({ tenant: tenant(), principal: u, action: 'agent.delete', resource: agentRes })).allowed).toBe(true);

    const ci = tokenPrincipal({ tokenId: 't1', owner: u, scope: null, projectId: 'p-ci' });
    const other = tokenPrincipal({ tokenId: 't2', owner: u, scope: null, projectId: 'p-other' });
    const none2 = tokenPrincipal({ tokenId: 't3', owner: u, scope: null });
    expect((await authorize({ tenant: tenant(), principal: ci, action: 'agent.update', resource: agentRes })).allowed).toBe(false);
    expect((await authorize({ tenant: tenant(), principal: other, action: 'agent.update', resource: agentRes })).allowed).toBe(true);
    expect((await authorize({ tenant: tenant(), principal: none2, action: 'agent.update', resource: agentRes })).allowed).toBe(true);

    for (const id of ['grp', 'proj', 'tok']) await deletePolicy(tenant(), id);
  });

  it('uses request context', async () => {
    await putPolicy('sms', 'forbid(principal, action == Action::"agent.invoke", resource is Agent) when { context has channel && context.channel == "sms" };');
    const base = { tenant: tenant(), principal: member(), action: 'agent.invoke', resource: agentRes };
    expect((await authorize({ ...base, context: { channel: 'sms' } })).allowed).toBe(false);
    expect((await authorize({ ...base, context: { channel: 'web' } })).allowed).toBe(true);
    expect((await authorize(base)).allowed).toBe(true);
    await deletePolicy(tenant(), 'sms');
  });

  it('keeps tenants apart', async () => {
    await putPolicy('only-here', 'forbid(principal, action == Action::"agent.get", resource is Agent);');
    const here = await authorize({ tenant: tenant(), principal: member(), action: 'agent.get', resource: agentRes });
    const there = await authorize({ tenant: 'tenant_other_engine', principal: member(), action: 'agent.get', resource: agentRes });
    expect(here.allowed).toBe(false);
    expect(there.allowed).toBe(true);
    await deletePolicy(tenant(), 'only-here');
  });

  it('picks up a change made by ANOTHER node when the version is re-checked', async () => {
    configureIamEngine({ versionCheckMs: 0 });
    const input = { tenant: tenant(), principal: member(), action: 'agent.get', resource: agentRes };
    expect((await authorize(input)).allowed).toBe(true);
    // Simulate a remote write: store + counter changed without any local event.
    const now = new Date().toISOString();
    await env.db.runWithTenant(tenant(), async () => {
      await env.db.iamDocPut('iam_policies', 'remote', {
        _id: 'remote', policyId: 'remote', name: 'remote', cedar: 'forbid(principal, action == Action::"agent.get", resource is Agent);',
        enabled: true, createdBy: 'x', updatedBy: 'x', createdAt: now, updatedAt: now,
      });
      await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
    });
    expect((await authorize(input)).allowed).toBe(false);
    await env.db.runWithTenant(tenant(), async () => {
      await env.db.iamDocDelete('iam_policies', 'remote');
      await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
    });
    expect((await authorize(input)).allowed).toBe(true);
  });
});

describe('a policy is enabled or disabled - nothing in between', () => {
  it('a result carries no dry-run verdict, whatever the workspace has stored', async () => {
    await putPolicy('plain', 'forbid(principal, action == Action::"agent.delete", resource is Agent);');
    const denied = await authorize({ tenant: tenant(), principal: member(), action: 'agent.delete', resource: agentRes });
    const allowed = await authorize({ tenant: tenant(), principal: member(), action: 'agent.get', resource: agentRes });
    expect(denied.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
    expect(denied).not.toHaveProperty('monitor');
    expect(allowed).not.toHaveProperty('monitor');
    await deletePolicy(tenant(), 'plain');
  });

  it('a policy an earlier build stored in monitor mode is disabled: it neither blocks nor grants, and counts as no custom policy', async () => {
    await putPolicy('was-dry-run', 'forbid(principal, action == Action::"agent.delete", resource is Agent);', { mode: 'monitor' });
    await putPolicy('was-dry-run-permit', 'permit(principal is User, action == Action::"agent.invoke", resource is Agent);', { mode: 'monitor' });
    const noAgents = member({ user: { role: 'user', servicePermissions: { agents: 'none' } } });
    expect((await authorize({ tenant: tenant(), principal: member(), action: 'agent.delete', resource: agentRes })).allowed).toBe(true);
    expect((await authorize({ tenant: tenant(), principal: noAgents, action: 'agent.invoke', resource: agentRes })).allowed).toBe(false);
    expect((await describeTenantPolicySet(tenant())).custom).toBe(0);
    // enabling it is a deliberate save of its own; from then on it applies
    await updatePolicy(tenant(), 'was-dry-run', { enabled: true }, 'tester');
    expect((await authorize({ tenant: tenant(), principal: member(), action: 'agent.delete', resource: agentRes })).allowed).toBe(false);
    expect((await describeTenantPolicySet(tenant())).custom).toBe(1);
    await deletePolicy(tenant(), 'was-dry-run');
    await deletePolicy(tenant(), 'was-dry-run-permit');
  });

  it('a workspace without enabled custom policies shares the managed set; one with them has a set of its own', async () => {
    const managed = await describeTenantPolicySet(tenant());
    expect(managed).toMatchObject({ custom: 0, skipped: [] });
    expect(managed.setId).not.toContain(tenant());
    await putPolicy('own-set', 'forbid(principal, action == Action::"agent.delete", resource is Agent);');
    const own = await describeTenantPolicySet(tenant());
    expect(own).toMatchObject({ custom: 1, skipped: [], setId: `tenant:${tenant()}:policies` });
    expect(own.version).toBeGreaterThan(managed.version);
    // disabling the only custom policy hands the workspace back to the shared set
    await updatePolicy(tenant(), 'own-set', { enabled: false }, 'tester');
    expect((await describeTenantPolicySet(tenant())).setId).toBe(managed.setId);
    await deletePolicy(tenant(), 'own-set');
  });
});

/**
 * The engine keeps ONE preparsed set per workspace under a stable id. A load that
 * read its policy list before a later policy write must therefore never preparse
 * it: it would bring the older rules back for every decision until the next write.
 */
describe('a policy load that a newer policy write overtook', () => {
  const FORBID_TOOLS = 'forbid (principal, action, resource) when { resource.service == "tools" };';
  const FORBID_MODELS = 'forbid (principal, action, resource) when { resource.service == "models" };';

  /** Holds the engine's policy-list reads: a held read returns the list it read, but only once released. */
  function holdPolicyReads() {
    const realList = env.db.iamDocList.bind(env.db);
    const held: Array<() => void> = [];
    let armed = false;
    const spy = vi.spyOn(env.db, 'iamDocList').mockImplementation(async (...args: Parameters<typeof realList>) => {
      const snapshot = await realList(...args);
      if (armed && args[0] === 'iam_policies') await new Promise<void>((resolve) => held.push(resolve));
      return snapshot;
    });
    return {
      arm: () => { armed = true; },
      disarm: () => { armed = false; },
      reads: () => held.length,
      release: (index: number) => held[index](),
      restore: () => spy.mockRestore(),
    };
  }

  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(condition()).toBe(true);
  };
  const askModels = () => authorizeGate({ tenant: tenant(), principal: member(), service: 'models', method: 'GET' });

  it('does not bring the older rules back once it finishes', async () => {
    await putPolicy('older-1', FORBID_TOOLS);
    expect((await askModels()).allowed).toBe(true);

    const reads = holdPolicyReads();
    try {
      // This write makes the next decision reload; that load reads its list and then waits.
      await putPolicy('older-2', FORBID_TOOLS);
      reads.arm();
      const slow = askModels();
      await until(() => reads.reads() === 1);
      reads.disarm();

      // A newer write lands while it waits; the next decision loads the newer list.
      await putPolicy('freeze-models', FORBID_MODELS);
      expect((await askModels()).allowed).toBe(false);

      // The waiting load finally ends with its older list ...
      reads.release(0);
      await slow;

      // ... and the workspace still runs the newer rules, also across version re-checks.
      expect((await askModels()).allowed).toBe(false);
      configureIamEngine({ versionCheckMs: 0 });
      expect((await askModels()).allowed).toBe(false);
      expect((await askModels()).allowed).toBe(false);
      expect(await describeTenantPolicySet(tenant())).toMatchObject({ custom: 3, skipped: [] });
    } finally {
      reads.restore();
      for (const id of ['older-1', 'older-2', 'freeze-models']) await deletePolicy(tenant(), id);
    }
  });

  it('a decision that was waiting on the older load is answered by the newer rules', async () => {
    await putPolicy('older-1', FORBID_TOOLS);
    expect((await askModels()).allowed).toBe(true);

    const reads = holdPolicyReads();
    try {
      await putPolicy('older-2', FORBID_TOOLS);
      reads.arm();
      const waiting = askModels();
      await until(() => reads.reads() === 1);
      reads.disarm();
      await putPolicy('freeze-models', FORBID_MODELS);
      reads.release(0);
      expect((await waiting).allowed).toBe(false);
    } finally {
      reads.restore();
      for (const id of ['older-1', 'older-2', 'freeze-models']) await deletePolicy(tenant(), id);
    }
  });

  it('an older load that ends does not drop the pending load of the newer one', async () => {
    await putPolicy('older-1', FORBID_TOOLS);
    expect((await askModels()).allowed).toBe(true);

    const reads = holdPolicyReads();
    try {
      await putPolicy('older-2', FORBID_TOOLS);
      reads.arm();
      const first = askModels();
      await until(() => reads.reads() === 1);
      // the newer load starts and waits too
      await putPolicy('freeze-models', FORBID_MODELS);
      const second = askModels();
      await until(() => reads.reads() === 2);

      // the older one ends; a decision that arrives now joins the newer load instead of starting a third
      reads.release(0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const third = askModels();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(reads.reads()).toBe(2);

      reads.release(1);
      expect((await Promise.all([first, second, third])).map((r) => r.allowed)).toEqual([false, false, false]);
    } finally {
      reads.restore();
      for (const id of ['older-1', 'older-2', 'freeze-models']) await deletePolicy(tenant(), id);
    }
  });
});

describe('never throws', () => {
  it('unknown actions, resource types and garbage inputs deny with a result', async () => {
    const principal = member();
    const unknownAction = await authorize({ tenant: tenant(), principal, action: 'nonsense.verb', resource: agentRes });
    expect(unknownAction.allowed).toBe(false);

    for (const bad of [undefined, null, {}, { tenant: tenant() }, { tenant: tenant(), principal: {}, action: 1, resource: 2 }] as unknown[]) {
      const res = await authorize(bad as never);
      expect(res.allowed).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
      expect(typeof res.durationUs).toBe('number');
    }

    const garbagePrincipal = { kind: 'user', userId: 'x' } as unknown as IamPrincipal;
    await expect(authorize({ tenant: tenant(), principal: garbagePrincipal, action: 'agents.read', resource: { kind: 'service', service: 'agents' } })).resolves.toMatchObject({ allowed: false });
  });

  it('a malformed method or service at the gate yields a deny with errors, never a throw (a request that cannot even be built is flagged as a failure)', async () => {
    const principal = userPrincipal({ userId: 'x', user: { role: 'admin' } });
    const noMethod = await authorizeGate({ tenant: tenant(), principal, service: 'models', method: undefined as unknown as string });
    expect(noMethod).toMatchObject({ allowed: false, failed: true });
    expect(noMethod.errors.length).toBeGreaterThan(0);
    const noService = await authorizeGate({ tenant: tenant(), principal, service: undefined as unknown as string, method: 'GET' });
    expect(noService.allowed).toBe(false);
    expect(noService.errors.join(' ')).toMatch(/unknown action/);
  });

  it('an unreadable store denies (fresh tenant) with the cause in errors, flagged as a failure (the gates answer 503 for it)', async () => {
    resetIamEngineForTests();
    hoisted.getDatabase.mockRejectedValueOnce(new Error('db down'));
    const res = await authorize({ tenant: 'tenant_never_loaded', principal: member(), action: 'agent.get', resource: agentRes });
    expect(res.allowed).toBe(false);
    expect(res.failed).toBe(true);
    expect(res.errors.join(' ')).toMatch(/db down/);
    expect(getIamEngineStats().failures).toBeGreaterThan(0);
    // and recovers
    expect((await authorize({ tenant: 'tenant_never_loaded', principal: member(), action: 'agent.get', resource: agentRes })).allowed).toBe(true);
  });

  it('keeps serving the last good set when a refresh fails (fail static)', async () => {
    configureIamEngine({ versionCheckMs: 0 });
    const input = { tenant: tenant(), principal: member(), action: 'agent.get', resource: agentRes };
    expect((await authorize(input)).allowed).toBe(true);
    hoisted.getDatabase.mockRejectedValue(new Error('flaky'));
    try {
      const res = await authorize(input);
      expect(res.allowed).toBe(true);
    } finally {
      hoisted.getDatabase.mockResolvedValue(env.db);
    }
  });

  it('a corrupted stored policy is skipped, the managed set still decides', async () => {
    const now = new Date().toISOString();
    await env.db.runWithTenant(tenant(), async () => {
      await env.db.iamDocPut('iam_policies', 'broken', {
        _id: 'broken', policyId: 'broken', name: 'broken', cedar: 'permit(((', enabled: true,
        createdBy: 'x', updatedBy: 'x', createdAt: now, updatedAt: now,
      });
      await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
    });
    resetIamEngineForTests();
    const res = await authorize({ tenant: tenant(), principal: member(), action: 'agent.get', resource: agentRes });
    expect(res.allowed).toBe(true);
    expect((await describeTenantPolicySet(tenant())).skipped).toEqual(['custom:broken']);
    await env.db.runWithTenant(tenant(), async () => {
      await env.db.iamDocDelete('iam_policies', 'broken');
      await env.db.iamDocIncrement('iam_meta', 'policy_version', 'value', 1);
    });
  });
});

describe('engine stats and latency smoke (non-gating)', () => {
  it('counts decisions and reports percentiles', async () => {
    const principal = member();
    for (let i = 0; i < 50; i++) await authorizeGate({ tenant: tenant(), principal, service: 'agents', method: 'GET' });
    const stats = getIamEngineStats();
    expect(stats.decisions).toBeGreaterThanOrEqual(50);
    expect(stats.allows).toBeGreaterThanOrEqual(50);
    expect(stats.p50Us).toBeGreaterThan(0);
    expect(stats.p99Us).toBeGreaterThanOrEqual(stats.p50Us);
    expect(stats.cedar).toMatchObject({ loaded: true, sdk: '4.13.0' });
    expect(stats.tenantsLoaded).toBeGreaterThan(0);
  });

  it('reports p50/p99 for managed-only and managed + 50 custom policies (no gate)', async () => {
    configureIamEngine({ validateRequests: false });
    const principal = userPrincipal({ userId: 'u', user: { role: 'admin' }, groupIds: Array.from({ length: 10 }, (_, i) => `g${i}`) });
    const measure = async (label: string) => {
      for (let i = 0; i < 300; i++) await authorizeGate({ tenant: tenant(), principal, service: 'agents', method: 'POST' });
      resetIamEngineForTests();
      for (let i = 0; i < 3000; i++) await authorizeGate({ tenant: tenant(), principal, service: 'agents', method: i % 2 ? 'POST' : 'GET' });
      const s = getIamEngineStats();
      console.log(`[iam-perf] ${label}: p50=${s.p50Us}us p99=${s.p99Us}us over ${s.window} decisions (10 groups)`);
      return s;
    };
    const managed = await measure('managed only');
    expect(managed.window).toBeGreaterThan(0);

    for (let i = 0; i < 50; i++) {
      await createPolicy(tenant(), {
        policyId: `perf-${i}`, name: `perf ${i}`,
        cedar: `permit(principal in Group::"g${i % 20}", action == Action::"agent.invoke", resource is Agent) when { resource.service == "agents" };`,
      }, 't');
    }
    const custom = await measure('managed + 50 custom');
    expect(custom.window).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) await deletePolicy(tenant(), `perf-${i}`);
  }, 60_000);
});
