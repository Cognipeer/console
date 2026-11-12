/**
 * The tenant spend pre-flight checks every model a turn can call (the primary
 * and each sub-agent override), and a spend observer sees each priced request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  checkBudget: vi.fn(),
  settleUsageBudget: vi.fn(),
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  checkBudget: hoisted.checkBudget,
  settleUsageBudget: hoisted.settleUsageBudget,
}));
vi.mock('@/lib/database', () => ({ getDatabase: hoisted.getDatabase }));

import {
  agentSpendSettler,
  assertQueuedTurnSpendAllowed,
  resetAgentSpendLicenseMemo,
  resolveAgentSpendScope,
  assertAgentTurnSpendAllowed,
  AgentSpendLimitError,
  type AgentSpendScope,
} from '@/lib/services/agents/agentSpendLimits';

beforeEach(() => resetAgentSpendLicenseMemo());

const scope: AgentSpendScope = {
  tenantDbName: 't_db', tenantId: 't1', projectId: 'p1', userId: 'u1', licenseType: 'FREE' as never,
};

describe('assertAgentTurnSpendAllowed', () => {
  it('checks the primary model and each distinct sub-agent model, once', async () => {
    hoisted.checkBudget.mockResolvedValue({ allowed: true });
    await assertAgentTurnSpendAllowed(scope, {
      modelKey: 'main',
      subagents: [{ modelKey: 'cheap' }, { modelKey: 'main' }, { modelKey: 'cheap' }, {}] as never,
    });
    expect(hoisted.checkBudget.mock.calls.map((c) => c[0].resourceKey)).toEqual(['main', 'cheap']);
  });

  it('refuses when a sub-agent model is already over its limit', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockImplementation(async (ctx: { resourceKey: string }) =>
      ctx.resourceKey === 'cheap' ? { allowed: false, reason: 'Budget exceeded' } : { allowed: true });
    await expect(assertAgentTurnSpendAllowed(scope, { modelKey: 'main', subagents: [{ modelKey: 'cheap' }] as never }))
      .rejects.toBeInstanceOf(AgentSpendLimitError);
  });
});

describe('assertAgentTurnSpendAllowed: the checks run together, the first refusal in key order wins', () => {
  const subs = [{ modelKey: 'b' }, { modelKey: 'c' }] as never;

  it('starts every key\'s check before waiting for any', async () => {
    hoisted.checkBudget.mockReset();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    hoisted.checkBudget.mockImplementation(async () => { await gate; return { allowed: true }; });
    const done = assertAgentTurnSpendAllowed(scope, { modelKey: 'a', subagents: subs });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hoisted.checkBudget).toHaveBeenCalledTimes(3);
    release();
    await done;
  });

  it('reports the earlier key\'s refusal even when a later key answers first', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockImplementation(async (ctx: { resourceKey: string }) => {
      if (ctx.resourceKey === 'b') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { allowed: false, reason: 'b is over' };
      }
      if (ctx.resourceKey === 'c') return { allowed: false, reason: 'c is over' };
      return { allowed: true };
    });
    await expect(assertAgentTurnSpendAllowed(scope, { modelKey: 'a', subagents: subs }))
      .rejects.toMatchObject({ message: 'b is over' });
  });

  it('a check that errors earlier in key order wins over a later refusal', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockImplementation(async (ctx: { resourceKey: string }) => {
      if (ctx.resourceKey === 'a') throw new Error('store down');
      return { allowed: false, reason: 'later refusal' };
    });
    await expect(assertAgentTurnSpendAllowed(scope, { modelKey: 'a', subagents: subs }))
      .rejects.toThrow('store down');
  });
});

describe('resolveAgentSpendScope: the licence type is memoised per tenant', () => {
  const input = { tenantDbName: 't_db', tenantId: 't1', projectId: 'p1', userId: 'u1' };
  const findTenantById = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    resetAgentSpendLicenseMemo();
    findTenantById.mockReset();
    hoisted.getDatabase.mockResolvedValue({ findTenantById });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reads the tenant once for repeated turns', async () => {
    findTenantById.mockResolvedValue({ licenseType: 'PRO' });
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('PRO');
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('PRO');
    expect(findTenantById).toHaveBeenCalledTimes(1);
  });

  it('keeps tenants apart', async () => {
    findTenantById.mockImplementation(async (id: string) => ({ licenseType: id === 't1' ? 'PRO' : 'FREE' }));
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('PRO');
    expect((await resolveAgentSpendScope({ ...input, tenantId: 't2' })).licenseType).toBe('FREE');
    expect(findTenantById).toHaveBeenCalledTimes(2);
  });

  it('sees a licence change after the memo expires', async () => {
    findTenantById.mockResolvedValueOnce({ licenseType: 'PRO' }).mockResolvedValueOnce({ licenseType: 'ENTERPRISE' });
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('PRO');
    vi.advanceTimersByTime(29_000);
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('PRO');
    vi.advanceTimersByTime(2_000);
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('ENTERPRISE');
    expect(findTenantById).toHaveBeenCalledTimes(2);
  });

  it('answers FREE for a tenant that cannot be read, without remembering it', async () => {
    findTenantById.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ licenseType: 'PRO' });
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('FREE');
    expect((await resolveAgentSpendScope(input)).licenseType).toBe('PRO');
  });

  it('leaves out the user for a synthetic actor', async () => {
    findTenantById.mockResolvedValue({ licenseType: 'PRO' });
    const scoped = await resolveAgentSpendScope({ ...input, userId: 'system:schedule' });
    expect(scoped.userId).toBeUndefined();
  });
});

describe('assertAgentTurnSpendAllowed: sub-agents that can run', () => {
  const checked = () => hoisted.checkBudget.mock.calls.map((c) => c[0].resourceKey);
  const ref = (extra: Record<string, unknown> = {}) => ({ kind: 'ref', name: 'writer', header: 'Writes', agentKey: 'writer-agent', ...extra }) as never;
  /** The project's agents: a draft model, and the published snapshot a run actually loads. */
  const withTarget = () => hoisted.getDatabase.mockResolvedValue({
    switchToTenant: vi.fn(),
    findAgentByKey: vi.fn(async () => ({ _id: 'id-1', key: 'writer-agent', config: { modelKey: 'draft-model' }, publishedVersion: 2 })),
    findAgentVersion: vi.fn(async () => ({ version: 2, snapshot: { config: { modelKey: 'live-model' } } })),
  });

  it('checks the model of a referenced agent, the one its published version runs on', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockResolvedValue({ allowed: true });
    withTarget();
    await assertAgentTurnSpendAllowed(scope, { modelKey: 'main', subagents: [ref()] });
    expect(checked()).toEqual(['main', 'live-model']);
  });

  it('refuses when the model of a referenced agent is already over its limit', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockImplementation(async (ctx: { resourceKey: string }) =>
      ctx.resourceKey === 'live-model' ? { allowed: false, reason: 'Budget exceeded' } : { allowed: true });
    withTarget();
    await expect(assertAgentTurnSpendAllowed(scope, { modelKey: 'main', subagents: [ref()] }))
      .rejects.toBeInstanceOf(AgentSpendLimitError);
  });

  it('checks the entry\'s own model instead of its target\'s when it has one', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockResolvedValue({ allowed: true });
    withTarget();
    await assertAgentTurnSpendAllowed(scope, { modelKey: 'main', subagents: [ref({ modelKey: 'override' })] });
    expect(checked()).toEqual(['main', 'override']);
  });

  it('checks only the primary model when delegation is switched off or an entry is', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockResolvedValue({ allowed: true });
    withTarget();
    await assertAgentTurnSpendAllowed(scope, {
      modelKey: 'main',
      subagents: [{ modelKey: 'cheap' }, ref()] as never,
      subagentPolicy: { mode: 'off' },
    });
    await assertAgentTurnSpendAllowed(scope, {
      modelKey: 'main',
      subagents: [{ modelKey: 'cheap', enabled: false }, ref({ enabled: false })] as never,
    });
    expect(checked()).toEqual(['main', 'main']);
  });
});

describe('agentSpendSettler', () => {
  it('debits each request and lets the scope observe it', () => {
    const observe = vi.fn();
    const settle = agentSpendSettler({ ...scope, observe }, 'main');
    settle({ currency: 'USD', totalCost: 0.5 });
    expect(observe).toHaveBeenCalledWith({ currency: 'USD', totalCost: 0.5 });
    expect(hoisted.settleUsageBudget).toHaveBeenCalledTimes(1);
  });
});

describe('assertQueuedTurnSpendAllowed (before a run is queued)', () => {
  const input = { tenantDbName: 't_db', tenantId: 't1', projectId: 'p1', agentKey: 'a1', userId: 'u1' };
  const withAgent = (config: unknown) => hoisted.getDatabase.mockResolvedValue({
    switchToTenant: vi.fn(),
    findAgentByKey: vi.fn(async () => (config ? { config } : null)),
    findTenantById: vi.fn(async () => ({ licenseType: 'FREE' })),
  });

  it('refuses with the spend-limit error before anything is queued', async () => {
    hoisted.checkBudget.mockReset();
    hoisted.checkBudget.mockResolvedValue({ allowed: false, reason: 'Budget exceeded' });
    withAgent({ modelKey: 'main' });
    await expect(assertQueuedTurnSpendAllowed(input)).rejects.toBeInstanceOf(AgentSpendLimitError);
  });

  it('lets a connected (external) agent through: it calls no model of ours', async () => {
    hoisted.checkBudget.mockReset();
    withAgent({ modelKey: 'main', kind: 'external', connection: { url: 'https://x' } });
    await expect(assertQueuedTurnSpendAllowed(input)).resolves.toBeUndefined();
    expect(hoisted.checkBudget).not.toHaveBeenCalled();
  });
});
