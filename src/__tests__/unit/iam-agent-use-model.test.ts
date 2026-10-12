/**
 * `agent.use_model`: running an agent on one of its ADDITIONAL models, decided by the policy engine for a request of the
 * dashboard or the API (the route asks it with `context.model` set; the main model is never asked about).
 *
 *   the default   a managed permit grants it to everyone who reaches the run, so with no custom policy every model on the
 *                 agent's list is usable - the list on the agent is the bound
 *   the narrowing a forbid on `context.model` (optionally `unless` a group) takes a model from some people
 *   the limits    the permit covers that one action only
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
import type { DatabaseProvider } from '@/lib/database';
import { RUNTIME_ENFORCED_ACTIONS } from '@/lib/iam/actions';
import { agentSessionResource } from '@/lib/iam/agentEntities';
import { buildCatalog } from '@/lib/iam/catalog';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { tokenPrincipal, userPrincipal, type IamPrincipal } from '@/lib/iam/entities';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { authorizeResourceForPrincipal, resetResourceAuthzThrottleForTests } from '@/lib/iam/resourceAuthz';
import { resetResourceAuthzStatsForTests } from '@/lib/iam/resourceAuthzStats';
import { AGENT_POLICIES } from '@/lib/iam/managedPolicies';
import { createPolicy, deletePolicy, listPolicies } from '@/lib/iam/store';
import { describeForEachProvider } from '../integration/db-parity.helper';

describeForEachProvider('agent.use_model', (getDb) => {
  let db: DatabaseProvider;
  let dbName = '';
  let tenantId = '';
  const P1 = 'p1';

  const person = (userId: string, over: Partial<Parameters<typeof userPrincipal>[0]> = {}) =>
    userPrincipal({ userId, user: { role: 'user' }, projects: [P1], adminProjects: [], ...over });
  const agent = (id = 'support') => agentSessionResource({ id, key: id, projectId: P1, ownerIds: [] });

  async function ask(principal: IamPrincipal, model: string | undefined, over: { channel?: 'dashboard' | 'api'; agentId?: string; action?: 'agent.use_model' | 'agent.approve' } = {}) {
    return authorizeResourceForPrincipal({
      tenantDbName: dbName,
      tenantId,
      userId: 'someone',
      principal,
      channel: over.channel ?? (principal.kind === 'token' ? 'api' : 'dashboard'),
      action: over.action ?? 'agent.use_model',
      resource: agent(over.agentId),
      subject: { resourceName: over.agentId ?? 'support' },
      client: { ip: '203.0.113.9', requestId: 'req-1', userAgent: 'vitest', method: 'POST', path: '/api/client/v1/agents/responses', ...(model ? { model } : {}) },
    });
  }

  async function install(policyId: string, cedar: string) {
    await createPolicy(dbName, { policyId, name: policyId, cedar }, 'tester');
    resetIamEngineForTests();
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetPrincipalCacheForTests();
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `usemodel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'Use model', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(row._id);
  });
  afterAll(async () => {
    configureIamEngine({ validateRequests: false });
    await drainPendingTasks();
  });
  beforeEach(() => {
    configureIamEngine({ validateRequests: true, versionCheckMs: 5_000 });
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    resetResourceAuthzThrottleForTests();
    resetResourceAuthzStatsForTests();
  });
  afterEach(async () => {
    await drainPendingTasks();
    for (const p of await listPolicies(dbName)) await deletePolicy(dbName, p.policyId);
  });

  it('is a Read-level action of the agent type, decided in the dashboard, the API and the portal', () => {
    const entry = buildCatalog().actions.find((a) => a.id === 'agent.use_model');
    expect(entry).toMatchObject({ kind: 'resource', level: 'read', resourceType: 'agent', verb: 'use_model' });
    expect(RUNTIME_ENFORCED_ACTIONS['agent.use_model']).toEqual(['dashboard', 'api', 'portal']);
  });

  it('default: everyone who reaches the run may use any model on the list - people and tokens', async () => {
    const member = person('member');
    const stranger = person('outsider', { projects: [] });
    const viaToken = tokenPrincipal({ tokenId: 't1', owner: member, scope: null });
    for (const who of [member, stranger, viaToken]) {
      const result = await ask(who, 'gpt-5');
      expect(result.allowed, who.kind).toBe(true);
    }
  });

  it('a forbid on the model takes it from everybody, and only that model', async () => {
    await install('no-gpt5', `forbid (principal, action == Action::"agent.use_model", resource == Agent::"support") when { context has model && context.model == "gpt-5" };`);
    const member = person('member');
    const refused = await ask(member, 'gpt-5');
    expect(refused.allowed).toBe(false);
    expect(refused.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(refused.policyIds).toContain('no-gpt5');
    expect((await ask(member, 'gpt-4o-mini')).allowed).toBe(true);
    // another agent is untouched
    expect((await ask(member, 'gpt-5', { agentId: 'sales' })).allowed).toBe(true);
    // ...and so is a token of the same person on that model: the forbid is about the model, not the channel
    expect((await ask(tokenPrincipal({ tokenId: 't1', owner: member, scope: null }), 'gpt-5')).allowed).toBe(false);
  });

  it('group-scoped: forbid ... unless the person is in the group', async () => {
    await install('gpt5-pro-only', `forbid (principal, action == Action::"agent.use_model", resource == Agent::"support") when { context has model && context.model == "gpt-5" } unless { principal in Group::"pro" };`);
    expect((await ask(person('free'), 'gpt-5')).allowed).toBe(false);
    expect((await ask(person('pro-user', { groupIds: ['pro'] }), 'gpt-5')).allowed).toBe(true);
    expect((await ask(person('free'), 'gpt-4o-mini')).allowed).toBe(true);
  });

  it('the permit covers agent.use_model only: it grants nothing else, and an outsider still cannot approve', async () => {
    const outsider = person('outsider', { projects: [] });
    expect((await ask(outsider, 'gpt-5')).allowed).toBe(true);
    const approve = await ask(outsider, undefined, { action: 'agent.approve' });
    expect(approve.allowed).toBe(false);
    // the managed rule names that one action and nothing else
    expect(AGENT_POLICIES['managed:agent:use-model']).toBe('@managed("agent")\npermit (principal, action == Action::"agent.use_model", resource is Agent);');
  });
});
