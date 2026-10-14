/**
 * Where the agent-run quota (domain `agent`) is enforced: the shared run entry
 * points count a run before any work and add its tokens afterwards, attributed
 * to the caller the server stamped on the request — and a refusal stops the run
 * before it is routed anywhere.
 *
 * The quota decision itself is covered end to end in
 * integration/quota-group-parity.test.ts; here the enforcement module is a
 * spy so the wiring can be seen on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  enforce: vi.fn(),
  record: vi.fn(),
  route: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
// `settleAgentRun` is the real rule (the larger of what the run reported and what its model calls
// were seen to spend); `record` stands for the counter it ends up charging.
vi.mock('@/lib/services/agents/agentQuota', () => ({
  enforceAgentRunQuota: hoisted.enforce,
  settleAgentRun: (caller: unknown, sink: { totalTokens: number }, reported?: number) =>
    hoisted.record(caller, Math.max(typeof reported === 'number' ? reported : 0, sink.totalTokens)),
}));
vi.mock('@/lib/core/cluster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/cluster')>();
  return { ...actual, routeInstanceCall: hoisted.route };
});

import { executeAgentChat, executePlaygroundChat } from '@/lib/services/agents/agentService';
import { addRunUsage } from '@/lib/services/agents/runUsage';
import { AgentQuotaExceededError, classifyAgentRunError } from '@/lib/services/agents/agentErrors';

const BASE = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  agentKey: 'support-bot',
  userMessage: 'hello',
};

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.enforce.mockResolvedValue(undefined);
});

describe('executeAgentChat', () => {
  const request = {
    ...BASE,
    conversationId: 'c1',
    userId: 'alice',
    runtimeContext: { userId: 'ignored-when-userId-is-set', tokenId: 'tok-1', source: 'api' as const },
  };

  it('counts the run, routes it, then adds its tokens for the same caller', async () => {
    hoisted.route.mockResolvedValue({ id: 'resp_1', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });

    const response = await executeAgentChat(request);

    expect(response.id).toBe('resp_1');
    const caller = {
      tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support-bot',
      userId: 'alice', tokenId: 'tok-1',
    };
    expect(hoisted.enforce).toHaveBeenCalledWith(caller);
    expect(hoisted.record).toHaveBeenCalledWith(caller, 15);
    // Counted BEFORE the run is routed anywhere.
    expect(hoisted.enforce.mock.invocationCallOrder[0]).toBeLessThan(hoisted.route.mock.invocationCallOrder[0]);
  });

  it('refuses without routing the run and without counting tokens', async () => {
    hoisted.enforce.mockRejectedValue(new AgentQuotaExceededError('Rate limit exceeded for requests perDay (51/50)'));

    await expect(executeAgentChat(request)).rejects.toBeInstanceOf(AgentQuotaExceededError);

    expect(hoisted.route).not.toHaveBeenCalled();
    expect(hoisted.record).not.toHaveBeenCalled();
  });

  it('charges a run that failed late for the tokens its model calls had spent (abort-before-the-end must not be free)', async () => {
    hoisted.route.mockImplementation(async () => {
      addRunUsage(120); // the model usage tap, seen from a model call that completed
      addRunUsage(30);
      throw new Error('provider down');
    });
    await expect(executeAgentChat(request)).rejects.toThrow('provider down');
    expect(hoisted.record).toHaveBeenCalledTimes(1);
    expect(hoisted.record).toHaveBeenCalledWith(expect.objectContaining({ agentKey: 'support-bot', userId: 'alice' }), 150);
  });

  it('a run that failed before spending anything is charged nothing', async () => {
    hoisted.route.mockRejectedValue(new Error('provider down'));
    await expect(executeAgentChat(request)).rejects.toThrow('provider down');
    expect(hoisted.record).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('charges the larger of what the run reported and what its calls were seen to spend', async () => {
    hoisted.route.mockImplementation(async () => {
      addRunUsage(900);
      return { id: 'resp_3', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    });
    await executeAgentChat(request);
    expect(hoisted.record).toHaveBeenCalledWith(expect.anything(), 900);
  });

  it('two runs at the same time never see each other\'s tokens', async () => {
    hoisted.route.mockImplementation(async (_target: unknown, payload: { userMessage: string }) => {
      await new Promise((resolve) => setTimeout(resolve, payload.userMessage === 'slow' ? 15 : 1));
      addRunUsage(payload.userMessage === 'slow' ? 1000 : 10);
      return { id: payload.userMessage, usage: { total_tokens: 1 } };
    });
    await Promise.all([executeAgentChat({ ...request, userMessage: 'slow' }), executeAgentChat({ ...request, userMessage: 'fast' })]);
    expect(hoisted.record.mock.calls.map((c) => c[1]).sort((a, b) => a - b)).toEqual([10, 1000]);
  });

  it('falls back to the identity in the runtime context when the request has no user', async () => {
    hoisted.route.mockResolvedValue({ id: 'resp_2', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });

    await executeAgentChat({ ...request, userId: '', runtimeContext: { userId: 'bob', source: 'a2a' } });

    expect(hoisted.enforce).toHaveBeenCalledWith(expect.objectContaining({ userId: 'bob', tokenId: undefined }));
  });
});

describe('executePlaygroundChat (dashboard chat, portals, realtime voice)', () => {
  it('attributes the run to the user stamped in the runtime context', async () => {
    hoisted.route.mockResolvedValue({ content: 'hi', usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } });

    const result = await executePlaygroundChat({
      ...BASE,
      runtimeContext: { userId: 'portal-user', source: 'portal' },
    });

    expect(result.content).toBe('hi');
    const caller = expect.objectContaining({ agentKey: 'support-bot', userId: 'portal-user' });
    expect(hoisted.enforce).toHaveBeenCalledWith(caller);
    expect(hoisted.record).toHaveBeenCalledWith(caller, 10);
  });

  it('refuses before routing, and the refusal reads as a 429 rate_limit_error', async () => {
    const refusal = new AgentQuotaExceededError('Group rate limit exceeded for requests perDay (201/200)');
    hoisted.enforce.mockRejectedValue(refusal);

    const error = await executePlaygroundChat({ ...BASE, runtimeContext: { userId: 'u', source: 'playground' } })
      .then(() => null, (e: unknown) => e);

    expect(error).toBe(refusal);
    expect(hoisted.route).not.toHaveBeenCalled();
    // What every entry point (and the portal's RATE_LIMITED mapping) sees:
    expect(classifyAgentRunError(error)).toEqual({
      status: 429,
      error: {
        message: 'Group rate limit exceeded for requests perDay (201/200)',
        type: 'rate_limit_error',
        code: 'agent_quota_exceeded',
      },
    });
  });

  it('tolerates a run with no usage to add', async () => {
    hoisted.route.mockResolvedValue({ content: 'hi' });
    await executePlaygroundChat({ ...BASE, runtimeContext: { userId: 'u', source: 'playground' } });
    expect(hoisted.record).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('charges a playground run that failed or was cancelled for what it spent', async () => {
    hoisted.route.mockImplementation(async () => {
      addRunUsage(64);
      throw new Error('aborted');
    });
    await expect(executePlaygroundChat({ ...BASE, runtimeContext: { userId: 'u', source: 'playground' } })).rejects.toThrow('aborted');
    expect(hoisted.record).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u' }), 64);
  });
});
