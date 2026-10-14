/**
 * Quota group scope + agent-run domain, end to end against BOTH real backends
 * (SQLite and MongoDB): policy storage (group mode, project-less rows), real
 * group memberships resolved through the principal cache, real counters in the
 * tenant database, and the agent-run entry point's refusal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Policies must be read fresh: tests add and remove them between checks.
process.env.QUOTA_POLICY_CACHE_TTL_SECONDS = '0';

import type { DatabaseProvider, IQuotaPolicy } from '@/lib/database';
const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The real helper closes over the module-local getDatabase, which this mock
    // cannot rebind — so re-implement it on top of the stubbed one.
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db: DatabaseProvider = await hoisted.getDatabase();
      return db.runWithTenant?.(tenantDbName, () => fn(db));
    },
  };
});

import { reloadConfig } from '@/lib/core/config';
import { checkRateLimit, resetQuotaGroupCacheForTests, resolveEffectiveLimits, type QuotaContext } from '@/lib/quota/quotaGuard';
import type { QuotaPolicyInput } from '@/lib/quota/types';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import {
  AgentQuotaExceededError,
  enforceAgentRunQuota,
  recordAgentRunTokens,
} from '@/lib/services/agents/agentQuota';
import {
  QuotaPolicyValidationError,
  assertValidQuotaPolicy,
  describeQuotaPolicies,
  listQuotaPolicies,
} from '@/lib/services/quota/quotaService';
import { describeForEachProvider } from './db-parity.helper';

beforeAll(() => reloadConfig());
afterAll(() => {
  delete process.env.QUOTA_POLICY_CACHE_TTL_SECONDS;
  reloadConfig();
});

const rpm = (perMinute: number) => ({ rateLimit: { requests: { perMinute } } });

describeForEachProvider('quota: group scope, tenant-wide kinds and agent runs', (getDb) => {
  let db: DatabaseProvider;
  let dbName: string;
  let tenantId: string;
  let projectId: string;

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `qg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Q', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'test' }))._id);
    resetQuotaGroupCacheForTests();
  });

  const mkUser = (email: string) =>
    db.createUser({ tenantId, email, name: email.split('@')[0], password: '$2b$10$x', role: 'user', licenseId: 'FREE', features: [] });
  const mkGroup = (name: string) => db.createGroup({ tenantId, name, createdBy: 'test', source: 'local' } as never);
  const join = (groupId: unknown, userId: unknown) =>
    db.addGroupMember({ groupId: String(groupId), userId: String(userId), tenantId, role: 'member' });
  const addPolicy = (overrides: Partial<QuotaPolicyInput> & Pick<QuotaPolicyInput, 'scope' | 'domain'>) =>
    db.createQuotaPolicy({
      tenantId,
      projectId,
      priority: 10,
      enabled: true,
      label: 'test',
      limits: {},
      ...overrides,
    } as Omit<IQuotaPolicy, '_id'>);

  const ctx = (userId: unknown, overrides: Partial<QuotaContext> = {}): QuotaContext => ({
    tenantDbName: dbName,
    tenantId,
    projectId,
    domain: 'llm',
    userId: String(userId),
    ...overrides,
  });
  const attempts = async (context: QuotaContext, times: number) => {
    const out: boolean[] = [];
    for (let i = 0; i < times; i += 1) out.push((await checkRateLimit(context, { requests: 1 })).allowed);
    return out;
  };

  describe('storage', () => {
    it('round-trips the group mode and lists only project-less rows as tenant-wide', async () => {
      const group = await mkGroup('Branch staff');
      const legacy = await addPolicy({ scope: 'user', scopeId: 'someone', domain: 'llm', limits: rpm(5) });
      const shared = await addPolicy({
        projectId: undefined, scope: 'group', scopeId: String(group._id), groupMode: 'shared', domain: 'llm', limits: rpm(9),
      });
      const agentWide = await addPolicy({ projectId: undefined, scope: 'tenant', domain: 'agent', limits: rpm(3) });
      const legacyWide = await addPolicy({ projectId: undefined, scope: 'tenant', domain: 'llm', limits: rpm(7) });
      // Same tenant database, another tenant's row: never visible.
      await db.createQuotaPolicy({
        tenantId: 'other-tenant', priority: 1, enabled: true, scope: 'tenant', domain: 'agent', limits: rpm(1),
      } as Omit<IQuotaPolicy, '_id'>);

      const all = await db.listQuotaPolicies(tenantId);
      expect(all.map((p) => String(p._id)).sort()).toEqual(
        [legacy, shared, agentWide, legacyWide].map((p) => String(p._id)).sort(),
      );

      const wide = await db.listTenantWideQuotaPolicies(tenantId);
      expect(wide.map((p) => String(p._id)).sort()).toEqual(
        [shared, agentWide, legacyWide].map((p) => String(p._id)).sort(),
      );

      const byId = new Map(all.map((p) => [String(p._id), p]));
      expect(byId.get(String(shared._id))?.groupMode).toBe('shared');
      // Rows written without a mode read back as "no mode" on either backend.
      expect(byId.get(String(legacy._id))?.groupMode ?? undefined).toBeUndefined();

      const updated = await db.updateQuotaPolicy(String(shared._id), tenantId, { groupMode: 'perMember' });
      expect(updated?.groupMode).toBe('perMember');
    });

    it('serves the API view: a mode only on group rows, perMember by default', async () => {
      const group = await mkGroup('Support');
      await addPolicy({ scope: 'group', scopeId: String(group._id), domain: 'llm', limits: rpm(1) });
      await addPolicy({ scope: 'user', scopeId: 'u', domain: 'llm', limits: rpm(1) });

      const view = await listQuotaPolicies(dbName, tenantId);
      const groupRow = view.find((p) => p.scope === 'group');
      const userRow = view.find((p) => p.scope === 'user');
      expect(groupRow?.groupMode).toBe('perMember');
      expect(userRow).not.toHaveProperty('groupMode');
    });
  });

  describe('group limits with real memberships', () => {
    it('perMember: each member has the limit on a counter of their own', async () => {
      const group = await mkGroup('Branch staff');
      const [alice, bob, carol] = await Promise.all([mkUser('alice@x.io'), mkUser('bob@x.io'), mkUser('carol@x.io')]);
      await join(group._id, alice._id);
      await join(group._id, bob._id);
      await addPolicy({ scope: 'group', scopeId: String(group._id), domain: 'llm', limits: rpm(2) });

      // No groupIds on the context: the guard resolves them from the memberships.
      expect(await attempts(ctx(alice._id), 3)).toEqual([true, true, false]);
      expect(await attempts(ctx(bob._id), 3)).toEqual([true, true, false]);
      expect(await attempts(ctx(carol._id), 4)).toEqual([true, true, true, true]);
    });

    it('shared: the group draws from one counter', async () => {
      const group = await mkGroup('Credit desk');
      const [alice, bob, carol] = await Promise.all([mkUser('alice@x.io'), mkUser('bob@x.io'), mkUser('carol@x.io')]);
      await join(group._id, alice._id);
      await join(group._id, bob._id);
      await addPolicy({ scope: 'group', scopeId: String(group._id), groupMode: 'shared', domain: 'llm', limits: rpm(3) });

      expect(await attempts(ctx(alice._id), 2)).toEqual([true, true]);
      expect(await attempts(ctx(bob._id), 2)).toEqual([true, false]);
      expect(await attempts(ctx(alice._id), 1)).toEqual([false]);
      expect(await attempts(ctx(carol._id), 3)).toEqual([true, true, true]);
    });

    it('gives an actor with no user row (public A2A, a schedule) no groups instead of an error', async () => {
      const group = await mkGroup('Everyone else');
      await addPolicy({ projectId: undefined, scope: 'group', scopeId: String(group._id), domain: 'agent', limits: rpm(1) });
      for (const actor of ['a2a-public', 'system:agent-schedule', 'redteam']) {
        expect(await attempts(ctx(actor, { domain: 'agent' }), 3)).toEqual([true, true, true]);
      }
    });

    it('follows a membership change at once (the write invalidates the cached memberships)', async () => {
      const group = await mkGroup('Temps');
      const alice = await mkUser('alice@x.io');
      await join(group._id, alice._id);
      await addPolicy({ scope: 'group', scopeId: String(group._id), domain: 'llm', limits: rpm(1) });

      expect((await resolveEffectiveLimits(ctx(alice._id))).rateLimit?.requests?.perMinute).toBe(1);
      await db.removeGroupMember(String(group._id), String(alice._id));
      expect((await resolveEffectiveLimits(ctx(alice._id))).rateLimit?.requests?.perMinute).toBeUndefined();
    });

    it('applies a project-less group policy in a project it was never attached to', async () => {
      const group = await mkGroup('Everywhere');
      const alice = await mkUser('alice@x.io');
      await join(group._id, alice._id);
      await addPolicy({ projectId: undefined, scope: 'group', scopeId: String(group._id), domain: 'llm', limits: rpm(1) });
      const other = String((await db.createProject({ tenantId, key: 'other', name: 'Other', createdBy: 'test' }))._id);

      expect(await attempts(ctx(alice._id, { projectId: other }), 2)).toEqual([true, false]);
    });

    it('caps what a group hands out at the tenant policy', async () => {
      const group = await mkGroup('Power users');
      const alice = await mkUser('alice@x.io');
      await join(group._id, alice._id);
      await addPolicy({ scope: 'tenant', domain: 'llm', priority: 1, limits: rpm(10) });
      await addPolicy({ scope: 'group', scopeId: String(group._id), domain: 'llm', priority: 50, limits: rpm(1000) });
      await addPolicy({ scope: 'user', scopeId: String(alice._id), domain: 'llm', priority: 60, limits: { rateLimit: { requests: { perHour: 5000 } } } });

      const limits = await resolveEffectiveLimits(ctx(alice._id));
      expect(limits.rateLimit?.requests?.perMinute).toBe(10);
      expect(limits.rateLimit?.requests?.perHour).toBe(5000); // the explicit user policy still applies
    });
  });

  describe('agent runs', () => {
    const caller = (userId: unknown, agentKey = 'support-bot') => ({
      tenantDbName: dbName, tenantId, projectId, agentKey, userId: String(userId),
    });
    const runs = async (who: ReturnType<typeof caller>, times: number) => {
      const out: string[] = [];
      for (let i = 0; i < times; i += 1) {
        try {
          await enforceAgentRunQuota(who);
          out.push('ok');
        } catch (error) {
          out.push(error instanceof AgentQuotaExceededError ? 'quota' : 'error');
        }
      }
      return out;
    };

    it('lets every run through while no agent limit exists, even with global limits around', async () => {
      const alice = await mkUser('alice@x.io');
      await addPolicy({ scope: 'tenant', domain: 'global', limits: rpm(1) });
      await addPolicy({ scope: 'user', scopeId: String(alice._id), domain: 'llm', limits: rpm(1) });
      expect(await runs(caller(alice._id), 4)).toEqual(['ok', 'ok', 'ok', 'ok']);
    });

    it('refuses with the same error every other quota refusal uses', async () => {
      const alice = await mkUser('alice@x.io');
      await addPolicy({ projectId: undefined, scope: 'tenant', domain: 'agent', limits: rpm(2) });

      await enforceAgentRunQuota(caller(alice._id));
      await enforceAgentRunQuota(caller(alice._id));
      const error = await enforceAgentRunQuota(caller(alice._id)).then(() => null, (e: unknown) => e);

      expect(error).toBeInstanceOf(AgentQuotaExceededError);
      expect((error as Error).message).toBe('Rate limit exceeded for requests perMinute (3/2)');

      // 429 + { message, type: 'rate_limit_error' } is exactly what the model endpoints answer
      // ({ error: { message, type: 'rate_limit_error' } }); the agent API adds a code.
      expect(classifyAgentRunError(error)).toEqual({
        status: 429,
        error: { message: 'Rate limit exceeded for requests perMinute (3/2)', type: 'rate_limit_error', code: 'agent_quota_exceeded' },
      });
    });

    it('counts a person\'s runs across all agents, and a policy narrowed to one agent only for that agent', async () => {
      const [alice, bob, carol] = await Promise.all([mkUser('alice@x.io'), mkUser('bob@x.io'), mkUser('carol@x.io')]);
      await addPolicy({ scope: 'tenant', domain: 'agent', limits: rpm(3) });
      await addPolicy({ scope: 'resource', scopeId: 'credit-bot', domain: 'agent', limits: rpm(1) });

      // 2 runs of one agent + 1 of another use up the person-wide 3, whichever agent they are for.
      expect(await runs(caller(alice._id, 'support-bot'), 2)).toEqual(['ok', 'ok']);
      expect(await runs(caller(alice._id, 'hr-bot'), 2)).toEqual(['ok', 'quota']);
      // The policy narrowed to credit-bot limits that agent alone: Bob's second run of it is refused...
      expect(await runs(caller(bob._id, 'credit-bot'), 2)).toEqual(['ok', 'quota']);
      // ...while Carol (own counters) is untouched by it on any other agent, up to the person-wide 3.
      expect(await runs(caller(carol._id, 'support-bot'), 4)).toEqual(['ok', 'ok', 'ok', 'quota']);
    });

    it('refuses once the token window is spent, after the run that spent it', async () => {
      const alice = await mkUser('alice@x.io');
      await addPolicy({ scope: 'tenant', domain: 'agent', limits: { rateLimit: { tokens: { perDay: 1000 } } } });

      await enforceAgentRunQuota(caller(alice._id)); // 0 of 1000 used
      recordAgentRunTokens(caller(alice._id), 1500); // this run used 1500
      await vi.waitFor(async () => {
        await expect(enforceAgentRunQuota(caller(alice._id))).rejects.toThrow(/tokens perDay \(1500\/1000\)/);
      });
    });

    it('applies a group\'s agent limit per member, or shared', async () => {
      const group = await mkGroup('Branch staff');
      const [alice, bob] = await Promise.all([mkUser('alice@x.io'), mkUser('bob@x.io')]);
      await join(group._id, alice._id);
      await join(group._id, bob._id);
      const policy = await addPolicy({
        projectId: undefined, scope: 'group', scopeId: String(group._id), domain: 'agent', limits: rpm(2),
      });

      expect(await runs(caller(alice._id), 3)).toEqual(['ok', 'ok', 'quota']);
      expect(await runs(caller(bob._id), 3)).toEqual(['ok', 'ok', 'quota']);

      await db.updateQuotaPolicy(String(policy._id), tenantId, { groupMode: 'shared' });
      const second = await mkUser('dave@x.io');
      await join(group._id, second._id);
      // The per-member counters above are keyed by user; the shared pool starts empty.
      expect(await runs(caller(alice._id, 'a'), 1)).toEqual(['ok']);
      expect(await runs(caller(second._id, 'b'), 2)).toEqual(['ok', 'quota']);
    });

    it('works with no project on the run (a tenant-wide agent limit still applies)', async () => {
      const alice = await mkUser('alice@x.io');
      await addPolicy({ projectId: undefined, scope: 'tenant', domain: 'agent', limits: rpm(1) });
      expect(await runs({ ...caller(alice._id), projectId: '' }, 2)).toEqual(['ok', 'quota']);
    });
  });

  describe('write-time validation', () => {
    it('only accepts a group that exists in this tenant, and a mode only on a group policy', async () => {
      const group = await mkGroup('Real');
      await expect(
        assertValidQuotaPolicy(dbName, tenantId, { scope: 'group', scopeId: String(group._id), groupMode: 'shared' }, null),
      ).resolves.toBeUndefined();
      await expect(assertValidQuotaPolicy(dbName, tenantId, { scope: 'group', scopeId: 'missing' }, null))
        .rejects.toMatchObject({ code: 'group_not_found', status: 404 });
      await expect(assertValidQuotaPolicy(dbName, tenantId, { scope: 'group' }, null))
        .rejects.toMatchObject({ code: 'group_required' });
      await expect(assertValidQuotaPolicy(dbName, tenantId, { scope: 'user', scopeId: 'u', groupMode: 'shared' }, null))
        .rejects.toBeInstanceOf(QuotaPolicyValidationError);
      await expect(assertValidQuotaPolicy(dbName, tenantId, { scope: 'group', scopeId: String(group._id), groupMode: 'nope' as never }, null))
        .rejects.toMatchObject({ code: 'invalid_group_mode' });
    });
  });

  describe('table view', () => {
    it('names the group, the user and the agent a policy points at, and its project', async () => {
      const group = await mkGroup('Branch staff');
      const alice = await mkUser('alice@x.io');
      await db.createAgent({
        tenantId, projectId, key: 'credit-bot', name: 'Credit assistant', config: { modelKey: 'm' }, status: 'active', createdBy: 'test',
      });
      await addPolicy({ scope: 'group', scopeId: String(group._id), domain: 'agent', limits: rpm(1) });
      await addPolicy({ scope: 'user', scopeId: String(alice._id), domain: 'llm', limits: rpm(1) });
      await addPolicy({ scope: 'resource', scopeId: 'credit-bot', domain: 'agent', limits: rpm(1) });
      await addPolicy({ scope: 'user', scopeId: 'deleted-user', domain: 'llm', limits: rpm(1) });
      await addPolicy({ scope: 'tenant', domain: 'llm', limits: rpm(1) });

      const view = await describeQuotaPolicies(dbName, tenantId, await listQuotaPolicies(dbName, tenantId));
      const target = (scope: string, id?: string) => view.find((p) => p.scope === scope && (!id || p.scopeId === id))?.target;
      expect(target('group')).toMatchObject({ type: 'group', label: 'Branch staff' });
      expect(target('user', String(alice._id))).toMatchObject({ type: 'user', label: 'alice', sublabel: 'alice@x.io' });
      expect(target('resource')).toMatchObject({ type: 'agent', label: 'Credit assistant', sublabel: 'credit-bot' });
      expect(target('user', 'deleted-user')).toMatchObject({ type: 'user', missing: true, label: 'deleted-user' });
      expect(target('tenant')).toEqual({ type: 'tenant' });
      expect(view.every((p) => p.projectName === 'Main' && p.projectKey === 'main')).toBe(true);
    });
  });
});
