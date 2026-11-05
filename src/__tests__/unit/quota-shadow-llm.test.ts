/**
 * Shadow mode for the application's own model calls: counted against the llm
 * limits on separate counters, logged when they would go over, never refused,
 * and never touching the counters the gateway enforces on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const config = { quota: { policyCacheTtlSeconds: 0 }, rateLimit: { provider: 'mongodb' } };
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/config', () => ({ getConfig: () => config }));
vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({ get: async () => undefined, set: async () => {}, del: async () => {} }),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn, error: () => {} }),
}));

import { getDatabase } from '@/lib/database';
import type { IQuotaPolicy, ITenant } from '@/lib/database';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { resetQuotaGroupCacheForTests } from '@/lib/quota/quotaGuard';
import { shadowInternalLlmUsage } from '@/lib/quota/shadowLlmQuota';

describe('shadow mode for internal model calls', () => {
  let counters: Map<string, number>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetQuotaGroupCacheForTests();
    counters = new Map();
    const db = createMockDb();
    db.findTenantById.mockResolvedValue({ _id: 'tenant-1', slug: 'acme' } as unknown as ITenant);
    db.listGroupMembersByUser.mockResolvedValue([] as never);
    db.listQuotaPolicies.mockResolvedValue([{
      _id: 'p-1', tenantId: 'tenant-1', projectId: 'proj-1', domain: 'llm', scope: 'tenant',
      priority: 10, enabled: true, limits: { rateLimit: { tokens: { perMinute: 100 } } },
    } as unknown as IQuotaPolicy]);
    db.incrementRateLimit.mockImplementation(async (key: string, _window: number, amount: number) => {
      const count = (counters.get(key) ?? 0) + amount;
      counters.set(key, count);
      return { count, resetAt: new Date(Date.now() + 60_000) };
    });
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  const call = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'gpt', route: 'rag-answer' };

  it('counts on shadow counters only and logs a call that would go over', async () => {
    shadowInternalLlmUsage(call, { inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    await drainPendingTasks();
    expect(warn).not.toHaveBeenCalled();

    shadowInternalLlmUsage(call, { inputTokens: 40, outputTokens: 20, totalTokens: 60 });
    await drainPendingTasks();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ modelKey: 'gpt', route: 'rag-answer', projectId: 'proj-1' });

    const keys = [...counters.keys()];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('rate_limit_shadow:llm:'))).toBe(true);
  });

  it('does nothing for a call without a project', async () => {
    shadowInternalLlmUsage({ ...call, projectId: '' }, { inputTokens: 500, outputTokens: 500, totalTokens: 1000 });
    await drainPendingTasks();
    expect(counters.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
