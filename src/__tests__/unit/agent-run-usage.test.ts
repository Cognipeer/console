/**
 * What a run has spent so far (runUsage.ts), fed by the gateway model's usage
 * settlement (agent-gateway-model.test.ts) and settled by agentQuota.settleAgentRun: a run that fails or is cancelled late is
 * still charged for the tokens its model calls used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkRateLimit: hoisted.checkRateLimit }));

import { settleAgentRun } from '@/lib/services/agents/agentQuota';
import { addRunUsage, createRunUsageSink, runWithUsageSink } from '@/lib/services/agents/runUsage';

const caller = { tenantDbName: 'tenant_a', tenantId: 't1', projectId: 'p1', agentKey: 'bot', userId: 'u1' };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.checkRateLimit.mockResolvedValue({ allowed: true, effectiveLimits: {} });
});

describe('the run usage sink', () => {
  it('collects what addRunUsage reports inside the run, and nothing outside it', async () => {
    addRunUsage(500); // no run: ignored
    const sink = createRunUsageSink();
    await runWithUsageSink(sink, async () => {
      addRunUsage(10);
      await Promise.resolve();
      addRunUsage(5.2); // whole tokens
      addRunUsage(0);
      addRunUsage(-4);
      addRunUsage(Number.NaN);
      addRunUsage(undefined);
    });
    expect(sink.totalTokens).toBe(16);
    addRunUsage(99);
    expect(sink.totalTokens).toBe(16);
  });

  it('keeps concurrent runs apart, also across awaits and nested sinks', async () => {
    const a = createRunUsageSink();
    const b = createRunUsageSink();
    await Promise.all([
      runWithUsageSink(a, async () => { await new Promise((r) => setTimeout(r, 5)); addRunUsage(7); }),
      runWithUsageSink(b, async () => { addRunUsage(3); await new Promise((r) => setTimeout(r, 10)); addRunUsage(3); }),
    ]);
    expect([a.totalTokens, b.totalTokens]).toEqual([7, 6]);
    const outer = createRunUsageSink();
    const inner = createRunUsageSink();
    await runWithUsageSink(outer, async () => {
      addRunUsage(1);
      await runWithUsageSink(inner, async () => addRunUsage(10));
      addRunUsage(1);
    });
    expect([outer.totalTokens, inner.totalTokens]).toEqual([2, 10]);
  });
});

describe('settleAgentRun', () => {
  it('charges the larger of the reported total and the tally', async () => {
    settleAgentRun(caller, { totalTokens: 30 }, 12);
    settleAgentRun(caller, { totalTokens: 5 }, 12);
    settleAgentRun(caller, { totalTokens: 40 });
    await Promise.resolve();
    const charged = hoisted.checkRateLimit.mock.calls.map((c) => (c[1] as { tokens: number }).tokens);
    expect(charged).toEqual([30, 12, 40]);
    expect(hoisted.checkRateLimit.mock.calls[0][0]).toMatchObject({ domain: 'agent', resourceKey: 'bot', userId: 'u1', tenantId: 't1' });
  });

  it('charges nothing for a run that spent nothing, and never throws on a failing counter', async () => {
    settleAgentRun(caller, { totalTokens: 0 });
    settleAgentRun(caller, { totalTokens: 0 }, 0);
    settleAgentRun(caller, { totalTokens: 0 }, Number.NaN);
    expect(hoisted.checkRateLimit).not.toHaveBeenCalled();
    hoisted.checkRateLimit.mockRejectedValue(new Error('counter down'));
    expect(() => settleAgentRun(caller, { totalTokens: 9 })).not.toThrow();
    await Promise.resolve();
  });
});
