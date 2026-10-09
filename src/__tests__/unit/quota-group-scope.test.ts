/**
 * Quota guard — group scope.
 *
 * What is pinned here:
 *  - the pre-group behaviour is untouched (same merge, same counter keys, no
 *    extra reads) for a tenant without group policies;
 *  - `group` policies join the existing priority merge, and explicit user /
 *    token policies still apply;
 *  - tenant policies cap what a group hands out, and nothing else;
 *  - `perMember` counts per user, `shared` counts once for the group;
 *  - tenant-wide (project-less) policies are picked up for the group and
 *    agent-run kinds only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const config = {
  quota: { policyCacheTtlSeconds: 0 },
  rateLimit: { provider: 'mongodb' },
};

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/config', () => ({ getConfig: () => config }));
vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({ get: async () => undefined, set: async () => {}, del: async () => {} }),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { getDatabase } from '@/lib/database';
import type { IQuotaPolicy, ITenant } from '@/lib/database';
import { invalidatePrincipal, invalidateTenantPrincipals } from '@/lib/iam/events';
import {
  checkBudget,
  checkRateLimit,
  resetQuotaGroupCacheForTests,
  resolveEffectiveLimits,
  type QuotaContext,
} from '@/lib/quota/quotaGuard';
import type { QuotaLimits } from '@/lib/quota/types';

const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

let seq = 0;
function policy(overrides: Partial<IQuotaPolicy>): IQuotaPolicy {
  seq += 1;
  return {
    _id: `p-${seq}`,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    domain: 'llm',
    scope: 'tenant',
    priority: 10,
    enabled: true,
    limits: {},
    ...overrides,
  } as IQuotaPolicy;
}

const rpm = (perMinute: number): QuotaLimits => ({ rateLimit: { requests: { perMinute } } });

function context(overrides: Partial<QuotaContext> = {}): QuotaContext {
  return {
    tenantDbName: 'tenant_acme',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    domain: 'llm',
    ...overrides,
  };
}

describe('quota guard — group scope', () => {
  let db: ReturnType<typeof createMockDb>;
  let counters: Map<string, number>;

  function setPolicies(...policies: IQuotaPolicy[]) {
    db.listQuotaPolicies.mockResolvedValue(policies);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetQuotaGroupCacheForTests();
    seq = 0;
    config.quota.policyCacheTtlSeconds = 0;
    counters = new Map();
    db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: TENANT_ID, slug: 'acme' } as unknown as ITenant);
    db.incrementRateLimit.mockImplementation(async (key: string, _window: number, amount: number) => {
      const count = (counters.get(key) ?? 0) + amount;
      counters.set(key, count);
      return { count, resetAt: new Date(Date.now() + 60_000) };
    });
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  const memberOf = (...groupIds: string[]) =>
    db.listGroupMembersByUser.mockResolvedValue(groupIds.map((groupId) => ({ groupId, userId: 'x', role: 'member' })) as never);

  async function runs(ctx: QuotaContext, times: number) {
    const results = [];
    for (let i = 0; i < times; i += 1) results.push((await checkRateLimit(ctx, { requests: 1 })).allowed);
    return results;
  }

  describe('tenants without group policies decide exactly as before', () => {
    it('merges by ascending priority, last wins, and counts per caller', async () => {
      setPolicies(
        policy({ scope: 'tenant', priority: 10, limits: rpm(100) }),
        policy({ scope: 'user', scopeId: 'u1', priority: 20, limits: rpm(2) }),
      );

      expect((await resolveEffectiveLimits(context({ userId: 'u1' }))).rateLimit?.requests?.perMinute).toBe(2);
      expect((await resolveEffectiveLimits(context({ userId: 'u2' }))).rateLimit?.requests?.perMinute).toBe(100);

      expect(await runs(context({ userId: 'u1' }), 3)).toEqual([true, true, false]);
      // The counter key is the one every existing deployment already has in its store.
      expect([...counters.keys()]).toEqual(['rate_limit:llm:requests:perMinute:user:u1']);
    });

    it('keeps the provider / resource parts and the token and tenant identities of the key', async () => {
      setPolicies(policy({ limits: rpm(5) }));
      await checkRateLimit(context({ tokenId: 't1', resourceKey: 'gpt', providerKey: 'azure' }), { requests: 1 });
      await checkRateLimit(context(), { requests: 1 });
      expect([...counters.keys()]).toEqual([
        'rate_limit:llm:requests:perMinute:prov:azure:res:gpt:token:t1',
        'rate_limit:llm:requests:perMinute:tenant:tenant-1',
      ]);
    });

    it('never looks up groups when no group policy exists', async () => {
      setPolicies(policy({ scope: 'user', scopeId: 'u1', limits: rpm(2) }));
      await resolveEffectiveLimits(context({ userId: 'u1' }));
      expect(db.listGroupMembersByUser).not.toHaveBeenCalled();
    });
  });

  describe('group policies (perMember, the default)', () => {
    it('gives every member the limit, counted per user', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(2) }));

      const alice = context({ userId: 'alice', groupIds: ['g1'] });
      const bob = context({ userId: 'bob', groupIds: ['g1'] });
      expect(await runs(alice, 3)).toEqual([true, true, false]);
      // Alice used hers up; Bob has his own.
      expect(await runs(bob, 3)).toEqual([true, true, false]);
      expect([...counters.keys()].sort()).toEqual([
        'rate_limit:llm:requests:perMinute:user:alice',
        'rate_limit:llm:requests:perMinute:user:bob',
      ]);
    });

    it('treats an explicit perMember the same as the default', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', groupMode: 'perMember', limits: rpm(1) }));
      expect(await runs(context({ userId: 'alice', groupIds: ['g1'] }), 2)).toEqual([true, false]);
    });

    it('does not apply to a caller outside the group, or when the policy is disabled', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', limits: rpm(1) }),
        policy({ scope: 'group', scopeId: 'g2', enabled: false, limits: rpm(1) }),
      );
      expect(await runs(context({ userId: 'carol', groupIds: ['g9'] }), 3)).toEqual([true, true, true]);
      expect(await runs(context({ userId: 'dave', groupIds: ['g2'] }), 3)).toEqual([true, true, true]);
    });

    it('is matched by any of a caller\'s groups', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g2', limits: rpm(1) }));
      expect(await runs(context({ userId: 'erin', groupIds: ['g1', 'g2'] }), 2)).toEqual([true, false]);
    });
  });

  describe('priority merge and ceilings', () => {
    it('lets an explicit user policy that outranks the group win, and the group win when it outranks the user', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', priority: 10, limits: rpm(5) }),
        policy({ scope: 'user', scopeId: 'u1', priority: 20, limits: rpm(50) }),
      );
      const ctx = context({ userId: 'u1', groupIds: ['g1'] });
      expect((await resolveEffectiveLimits(ctx)).rateLimit?.requests?.perMinute).toBe(50);

      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', priority: 30, limits: rpm(5) }),
        policy({ scope: 'user', scopeId: 'u1', priority: 20, limits: rpm(50) }),
      );
      expect((await resolveEffectiveLimits(ctx)).rateLimit?.requests?.perMinute).toBe(5);
    });

    it('lets an explicit user or token policy beat its group at the SAME priority, whichever was written first', async () => {
      // The editor gives every policy priority 0, so equal priorities are the normal case.
      const ctx = context({ userId: 'u1', tokenId: 'tok-1', groupIds: ['g1'] });
      const group = policy({ scope: 'group', scopeId: 'g1', priority: 0, limits: rpm(5) });
      const user = policy({ scope: 'user', scopeId: 'u1', priority: 0, limits: rpm(50) });
      const token = policy({ scope: 'token', scopeId: 'tok-1', priority: 0, limits: rpm(70) });
      const effective = async () => (await resolveEffectiveLimits(ctx)).rateLimit?.requests?.perMinute;

      for (const order of [[group, user], [user, group]]) {
        setPolicies(...order);
        expect(await effective()).toBe(50);
      }
      for (const order of [[group, user, token], [token, user, group], [user, token, group]]) {
        setPolicies(...order);
        expect(await effective()).toBe(70);
      }
    });

    it('keeps today\'s order for policies that involve no group (a tie goes to the older one)', async () => {
      // Listed newest first, as both providers return them: the older policy is merged last and wins.
      const newer = policy({ scope: 'tenant', priority: 100, limits: rpm(5) });
      const older = policy({ scope: 'user', scopeId: 'u1', priority: 100, limits: rpm(50) });
      setPolicies(newer, older);
      expect((await resolveEffectiveLimits(context({ userId: 'u1' }))).rateLimit?.requests?.perMinute).toBe(50);
      setPolicies(older, newer);
      expect((await resolveEffectiveLimits(context({ userId: 'u1' }))).rateLimit?.requests?.perMinute).toBe(5);
    });

    it('lets an explicit token policy still apply next to a group policy', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', priority: 10, limits: rpm(5) }),
        policy({ scope: 'token', scopeId: 'tok-1', priority: 20, limits: rpm(7) }),
      );
      const withToken = context({ userId: 'u1', tokenId: 'tok-1', groupIds: ['g1'] });
      const withoutToken = context({ userId: 'u1', tokenId: 'tok-2', groupIds: ['g1'] });
      expect((await resolveEffectiveLimits(withToken)).rateLimit?.requests?.perMinute).toBe(7);
      expect((await resolveEffectiveLimits(withoutToken)).rateLimit?.requests?.perMinute).toBe(5);
    });

    it('caps a group allowance at the tenant policy, but leaves a stricter one alone', async () => {
      setPolicies(
        policy({ scope: 'tenant', priority: 1, limits: { ...rpm(100), perRequest: { maxInputTokens: 1000 } } }),
        policy({
          scope: 'group',
          scopeId: 'g1',
          priority: 50,
          limits: { ...rpm(500), perRequest: { maxInputTokens: 400 } },
        }),
      );
      const limits = await resolveEffectiveLimits(context({ userId: 'u1', groupIds: ['g1'] }));
      // 500 requests asked for, the tenant says 100; 400 tokens is under the 1000 ceiling.
      expect(limits.rateLimit?.requests?.perMinute).toBe(100);
      expect(limits.perRequest?.maxInputTokens).toBe(400);
    });

    it('treats a group\'s "unlimited" (-1) as the tenant ceiling', async () => {
      setPolicies(
        policy({ scope: 'tenant', priority: 1, limits: rpm(100) }),
        policy({ scope: 'group', scopeId: 'g1', priority: 50, limits: rpm(-1) }),
      );
      expect((await resolveEffectiveLimits(context({ userId: 'u1', groupIds: ['g1'] }))).rateLimit?.requests?.perMinute).toBe(100);
    });

    it('does not cap an explicit user exception, nor a field the tenant does not limit', async () => {
      setPolicies(
        policy({ scope: 'tenant', priority: 1, limits: rpm(100) }),
        policy({ scope: 'group', scopeId: 'g1', priority: 20, limits: { ...rpm(500), budget: { dailySpendLimit: 80 } } }),
        policy({ scope: 'user', scopeId: 'vip', priority: 60, limits: rpm(900) }),
      );
      const member = await resolveEffectiveLimits(context({ userId: 'u1', groupIds: ['g1'] }));
      expect(member.rateLimit?.requests?.perMinute).toBe(100);
      // No tenant budget -> nothing to cap the group's budget with.
      expect(member.budget?.dailySpendLimit).toBe(80);

      const vip = await resolveEffectiveLimits(context({ userId: 'vip', groupIds: ['g1'] }));
      expect(vip.rateLimit?.requests?.perMinute).toBe(900);
    });

    it('changes nothing for a tenant policy that already outranks the group', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', priority: 10, limits: rpm(5) }),
        policy({ scope: 'tenant', priority: 90, limits: rpm(100) }),
      );
      // Today\'s override semantics: the higher-priority tenant policy wins the field.
      expect((await resolveEffectiveLimits(context({ userId: 'u1', groupIds: ['g1'] }))).rateLimit?.requests?.perMinute).toBe(100);
    });
  });

  describe('shared group policies', () => {
    it('counts the whole group on ONE counter', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', groupMode: 'shared', limits: rpm(3) }));

      const alice = context({ userId: 'alice', groupIds: ['g1'] });
      const bob = context({ userId: 'bob', groupIds: ['g1'] });
      const outsider = context({ userId: 'zed', groupIds: [] });

      expect(await runs(alice, 2)).toEqual([true, true]);
      expect(await runs(bob, 2)).toEqual([true, false]); // the third request of the group
      expect(await runs(alice, 1)).toEqual([false]);
      expect(await runs(outsider, 5)).toEqual([true, true, true, true, true]);
      expect(counters.get('rate_limit:llm:requests:perMinute:group:g1')).toBe(5);
      // Shared means no per-member counter was created for the members.
      expect([...counters.keys()].some((k) => k.endsWith(':user:alice'))).toBe(false);
    });

    it('says it was the group that ran out', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', groupMode: 'shared', limits: rpm(1) }));
      const ctx = context({ userId: 'alice', groupIds: ['g1'] });
      await checkRateLimit(ctx, { requests: 1 });
      const refused = await checkRateLimit(ctx, { requests: 1 });
      expect(refused.allowed).toBe(false);
      expect(refused.reason).toMatch(/^Group rate limit exceeded for requests perMinute \(2\/1\)$/);
    });

    it('keeps a member\'s own limits next to the shared pool', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', groupMode: 'shared', limits: rpm(10) }),
        policy({ scope: 'user', scopeId: 'alice', limits: rpm(1) }),
      );
      const alice = context({ userId: 'alice', groupIds: ['g1'] });
      expect(await runs(alice, 2)).toEqual([true, false]);
    });

    it('merges two shared policies of one group by priority into the one pool', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', groupMode: 'shared', priority: 10, limits: rpm(10) }),
        policy({ scope: 'group', scopeId: 'g1', groupMode: 'shared', priority: 20, limits: rpm(2) }),
      );
      expect(await runs(context({ userId: 'alice', groupIds: ['g1'] }), 3)).toEqual([true, true, false]);
    });

    it('is pooled per group, so one request draws from every shared pool of the caller', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', groupMode: 'shared', limits: rpm(100) }),
        policy({ scope: 'group', scopeId: 'g2', groupMode: 'shared', limits: rpm(1) }),
      );
      const ctx = context({ userId: 'alice', groupIds: ['g1', 'g2'] });
      expect(await runs(ctx, 2)).toEqual([true, false]);
      expect(counters.get('rate_limit:llm:requests:perMinute:group:g1')).toBe(2);
    });

    it('leaves the stateless half (per-request, resource caps) in the effective limits', async () => {
      setPolicies(
        policy({
          scope: 'group',
          scopeId: 'g1',
          groupMode: 'shared',
          limits: { ...rpm(3), perRequest: { maxInputTokens: 50 }, quotas: { maxModels: 2 } },
        }),
      );
      const limits = await resolveEffectiveLimits(context({ userId: 'alice', groupIds: ['g1'] }));
      expect(limits.perRequest?.maxInputTokens).toBe(50);
      expect(limits.quotas?.maxModels).toBe(2);
      // The counted half belongs to the pool, not to the per-caller merge.
      expect(limits.rateLimit).toBeUndefined();
    });

    it('pools a budget too', async () => {
      setPolicies(
        policy({ scope: 'group', scopeId: 'g1', groupMode: 'shared', limits: { budget: { dailySpendLimit: 1 } } }),
      );
      const alice = context({ userId: 'alice', groupIds: ['g1'] });
      const bob = context({ userId: 'bob', groupIds: ['g1'] });
      expect((await checkBudget(alice, { usd: 0.7 })).allowed).toBe(true);
      expect((await checkBudget(bob, { usd: 0.7 })).allowed).toBe(false); // 1.4 of the group's $1
      const keys = [...counters.keys()];
      expect(keys.every((k) => k === 'budget:llm:usd_micros:perDay:group:g1')).toBe(true);
    });
  });

  describe('where group ids come from', () => {
    it('reads the memberships once, only when a group policy could match, and reuses them', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(1) }));
      memberOf('g1');

      expect(await runs(context({ userId: 'alice' }), 2)).toEqual([true, false]);
      await resolveEffectiveLimits(context({ userId: 'alice' }));

      expect(db.listGroupMembersByUser).toHaveBeenCalledTimes(1);
      expect(db.listGroupMembersByUser).toHaveBeenCalledWith('alice');
      // Read inside the tenant's scope, not through the process-global binding.
      expect(db.runWithTenant).toHaveBeenCalledWith('tenant_acme', expect.any(Function));
    });

    it('keeps each person (and each tenant) apart', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(1) }));
      db.listGroupMembersByUser.mockImplementation(async (userId: string) =>
        (userId === 'alice' ? [{ groupId: 'g1' }] : []) as never);

      expect(await runs(context({ userId: 'alice' }), 2)).toEqual([true, false]);
      expect(await runs(context({ userId: 'bob' }), 2)).toEqual([true, true]);
      await resolveEffectiveLimits(context({ userId: 'alice', tenantDbName: 'tenant_other' }));
      expect(db.listGroupMembersByUser).toHaveBeenCalledTimes(3); // alice, bob, alice in another tenant
    });

    it('sees a membership change at once when a write invalidates the person, or the tenant', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(7) }));
      const limitOf = async () => (await resolveEffectiveLimits(context({ userId: 'alice' }))).rateLimit?.requests?.perMinute;

      memberOf('g1');
      expect(await limitOf()).toBe(7);

      memberOf(); // alice was removed from the group...
      expect(await limitOf()).toBe(7); // ...the cached answer holds until the write says so
      invalidatePrincipal('tenant_acme', 'alice');
      expect(await limitOf()).toBeUndefined();

      memberOf('g1');
      invalidatePrincipal('tenant_acme', 'someone-else'); // not her: nothing changes
      expect(await limitOf()).toBeUndefined();
      invalidateTenantPrincipals('tenant_acme'); // a group was edited: everyone is re-read
      expect(await limitOf()).toBe(7);
    });

    it('expires the cached memberships on its own', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(7) }));
        memberOf('g1');
        await resolveEffectiveLimits(context({ userId: 'alice' }));
        vi.setSystemTime(Date.now() + 16_000);
        await resolveEffectiveLimits(context({ userId: 'alice' }));
        expect(db.listGroupMembersByUser).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('trusts the ids the caller supplies and skips the lookup', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(1) }));
      await runs(context({ userId: 'alice', groupIds: ['g1'] }), 1);
      expect(db.listGroupMembersByUser).not.toHaveBeenCalled();
    });

    it('does not look anything up for a group policy of another domain', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', domain: 'vector', limits: rpm(1) }));
      await runs(context({ userId: 'alice' }), 1);
      expect(db.listGroupMembersByUser).not.toHaveBeenCalled();
    });

    it('treats an actor with no memberships (a schedule, public A2A) as having no groups', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(1) }));
      memberOf();
      expect(await runs(context({ userId: 'a2a-public' }), 3)).toEqual([true, true, true]);
    });

    it('does not swallow a real failure, and does not remember it', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(1) }));
      db.listGroupMembersByUser.mockRejectedValueOnce(new Error('connection reset'));
      await expect(resolveEffectiveLimits(context({ userId: 'alice' }))).rejects.toThrow('connection reset');

      memberOf('g1');
      expect((await resolveEffectiveLimits(context({ userId: 'alice' }))).rateLimit?.requests?.perMinute).toBe(1);
    });

    it('has no groups without a user', async () => {
      setPolicies(policy({ scope: 'group', scopeId: 'g1', limits: rpm(1) }));
      expect(await runs(context({ tokenId: 't1' }), 3)).toEqual([true, true, true]);
      expect(db.listGroupMembersByUser).not.toHaveBeenCalled();
    });
  });

  describe('tenant-wide (project-less) policies', () => {
    it('applies a group policy that has no project, in every project', async () => {
      setPolicies();
      db.listTenantWideQuotaPolicies.mockResolvedValue([
        policy({ projectId: undefined, scope: 'group', scopeId: 'g1', limits: rpm(1) }),
      ]);
      expect(await runs(context({ userId: 'alice', groupIds: ['g1'], projectId: 'other-project' }), 2)).toEqual([true, false]);
    });

    it('still ignores a project-less policy of an older kind', async () => {
      setPolicies();
      db.listTenantWideQuotaPolicies.mockResolvedValue([
        policy({ projectId: undefined, scope: 'user', scopeId: 'alice', limits: rpm(1) }),
        policy({ projectId: undefined, scope: 'tenant', limits: rpm(1) }),
      ]);
      expect(await runs(context({ userId: 'alice' }), 3)).toEqual([true, true, true]);
    });

    it('caches the combined set per project like any other policy source', async () => {
      config.quota.policyCacheTtlSeconds = 30;
      const store = new Map<string, unknown>();
      vi.doMock('@/lib/core/cache', () => ({
        getCache: async () => ({
          get: async (k: string) => store.get(k),
          set: async (k: string, v: unknown) => { store.set(k, v); },
          del: async (k: string) => { store.delete(k); },
        }),
      }));
      vi.resetModules();
      const guard = await import('@/lib/quota/quotaGuard');
      setPolicies();
      db.listTenantWideQuotaPolicies.mockResolvedValue([
        policy({ projectId: undefined, scope: 'group', scopeId: 'g1', limits: rpm(4) }),
      ]);
      const ctx = context({ userId: 'alice', groupIds: ['g1'] });
      await guard.resolveEffectiveLimits(ctx);
      await guard.resolveEffectiveLimits(ctx);
      expect(db.listQuotaPolicies).toHaveBeenCalledTimes(1);
      expect(db.listTenantWideQuotaPolicies).toHaveBeenCalledTimes(1);
      vi.doUnmock('@/lib/core/cache');
    });
  });
});
