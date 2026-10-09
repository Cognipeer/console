/**
 * What a run has spent so far (runUsage.ts), fed by the model usage tap and
 * settled by agentQuota.settleAgentRun: a run that fails or is cancelled late is
 * still charged for the tokens its model calls used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ checkRateLimit: vi.fn(), logModelUsage: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkRateLimit: hoisted.checkRateLimit }));
vi.mock('@/lib/services/models/usageLogger', () => ({ logModelUsage: hoisted.logModelUsage }));

import { settleAgentRun } from '@/lib/services/agents/agentQuota';
import { withModelUsageLogging } from '@/lib/services/agents/modelUsageTap';
import { addRunUsage, createRunUsageSink, runWithUsageSink } from '@/lib/services/agents/runUsage';

const caller = { tenantDbName: 'tenant_a', tenantId: 't1', projectId: 'p1', agentKey: 'bot', userId: 'u1' };
const model = { key: 'm1' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.checkRateLimit.mockResolvedValue({ allowed: true, effectiveLimits: {} });
  hoisted.logModelUsage.mockResolvedValue(undefined);
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

describe('the model usage tap feeds the run', () => {
  it('a completed call adds its tokens', async () => {
    const tapped = withModelUsageLogging({
      invoke: async () => ({ usage_metadata: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } }),
    }, { tenantDbName: 'tenant_a', model, route: 'agent', agentKey: 'bot' });
    const sink = createRunUsageSink();
    await runWithUsageSink(sink, () => tapped.invoke!());
    expect(sink.totalTokens).toBe(50);
  });

  it('a call that fails adds nothing (the provider spent nothing)', async () => {
    const tapped = withModelUsageLogging({
      invoke: async () => { throw new Error('429 from the provider'); },
    }, { tenantDbName: 'tenant_a', model, route: 'agent', agentKey: 'bot' });
    const sink = createRunUsageSink();
    await expect(runWithUsageSink(sink, () => tapped.invoke!())).rejects.toThrow('429');
    expect(sink.totalTokens).toBe(0);
  });

  it('a stream that is abandoned before its end still counts what it had generated', async () => {
    const tapped = withModelUsageLogging({
      stream: async function* () {
        yield { content: 'a', usage_metadata: { input_tokens: 30, output_tokens: 20, total_tokens: 50 } };
        yield { content: 'b' };
        yield { content: 'never read' };
      },
    }, { tenantDbName: 'tenant_a', model, route: 'agent', agentKey: 'bot' });
    const sink = createRunUsageSink();
    await runWithUsageSink(sink, async () => {
      for await (const chunk of tapped.stream!() as AsyncIterable<{ content: string }>) {
        if (chunk.content === 'b') break; // the client hung up
      }
    });
    expect(sink.totalTokens).toBe(50);
  });

  it('many calls of one run add up', async () => {
    const tapped = withModelUsageLogging({
      invoke: async () => ({ usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    }, { tenantDbName: 'tenant_a', model, route: 'agent', agentKey: 'bot' });
    const sink = createRunUsageSink();
    await runWithUsageSink(sink, async () => { for (let i = 0; i < 5; i++) await tapped.invoke!(); });
    expect(sink.totalTokens).toBe(10);
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
