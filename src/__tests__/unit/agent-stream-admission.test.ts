/**
 * What a stream asks before it opens (a refusal is still a plain 429 then), and the signal a long-poll stops on
 * when its client goes away. The quota guard is stood in for; the cap check without caps never reads the database.
 */
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(), runWithTenantScope: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkRateLimit: hoisted.checkRateLimit }));

import type { FastifyReply } from 'fastify';
import { peekAgentRunQuota, AgentQuotaExceededError } from '@/lib/services/agents/agentQuota';
import { clientGoneSignal, refuseStreamAdmission } from '@/server/api/plugins/agent-invocation';

const CALLER = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'support', userId: 'user-1', tokenId: 'tok-1' };
const NO_CAPS = { syncWaitMs: 60_000, maxDurationMs: 1_800_000, maxActivePerTenant: 0, maxActivePerProject: 0 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('peekAgentRunQuota', () => {
  it('asks the guard without counting anything: zero cost, the request and token windows as headroom', async () => {
    hoisted.checkRateLimit.mockResolvedValue({ allowed: true });
    await expect(peekAgentRunQuota(CALLER)).resolves.toBeUndefined();
    expect(hoisted.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'agent', resourceKey: 'support', userId: 'user-1', tokenId: 'tok-1' }),
      { requests: 0, tokens: 0 },
      { headroom: ['requests', 'tokens'] },
    );
  });

  it('throws the quota refusal when a window is exhausted, and lets the call through when the guard itself fails', async () => {
    hoisted.checkRateLimit.mockResolvedValue({ allowed: false, reason: 'Rate limit exceeded for requests perDay (200/200)' });
    await expect(peekAgentRunQuota(CALLER)).rejects.toBeInstanceOf(AgentQuotaExceededError);
    hoisted.checkRateLimit.mockRejectedValue(new Error('policy store unreachable'));
    await expect(peekAgentRunQuota(CALLER)).resolves.toBeUndefined();
  });
});

describe('refuseStreamAdmission', () => {
  const answer = async (dialect: 'client' | 'openai') => {
    const app = Fastify({ logger: false });
    app.get('/', async (_request, reply) => {
      const ctx = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', tokenRecord: { _id: 'tok-1', userId: 'user-1' } };
      if (await refuseStreamAdmission(reply, dialect, ctx as never, 'support', NO_CAPS)) return reply;
      return reply.code(200).send({ admitted: true });
    });
    try {
      return await app.inject({ method: 'GET', url: '/' });
    } finally {
      await app.close();
    }
  };

  it('over the quota: 429 rate_limit_error agent_quota_exceeded with Retry-After, in either dialect', async () => {
    hoisted.checkRateLimit.mockResolvedValue({ allowed: false, reason: 'Rate limit exceeded for requests perDay (200/200)' });
    for (const dialect of ['client', 'openai'] as const) {
      const res = await answer(dialect);
      expect(res.statusCode, dialect).toBe(429);
      expect(res.headers['retry-after'], dialect).toBe('60');
      expect(JSON.parse(res.body).error, dialect).toMatchObject({ type: 'rate_limit_error', code: 'agent_quota_exceeded' });
    }
  });

  it('under every limit (and without caps) it admits the stream', async () => {
    hoisted.checkRateLimit.mockResolvedValue({ allowed: true });
    const res = await answer('openai');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ admitted: true });
  });
});

describe('clientGoneSignal', () => {
  const replyOf = () => {
    const raw = Object.assign(new EventEmitter(), { writableFinished: false });
    return { raw, reply: { raw } as unknown as FastifyReply };
  };

  it('aborts when the connection closes before the answer was sent', () => {
    const { raw, reply } = replyOf();
    const signal = clientGoneSignal(reply);
    expect(signal.aborted).toBe(false);
    raw.emit('close');
    expect(signal.aborted).toBe(true);
  });

  it('stays quiet when the connection closes after the answer was sent', () => {
    const { raw, reply } = replyOf();
    const signal = clientGoneSignal(reply);
    raw.writableFinished = true;
    raw.emit('close');
    expect(signal.aborted).toBe(false);
  });
});
