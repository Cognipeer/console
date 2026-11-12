/**
 * Agent tracing, PII policies and the agent skill/session helpers run each public call inside the tenant scope of
 * their `tenantDbName`. Two tenants interleave on one process and every query awaits; a bare `switchToTenant` would
 * let the second call's binding leak into the first call's later queries.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  scope: undefined as unknown as AsyncLocalStorage<string>,
  /** Every db answer is read from the scope the query runs in, after a delay in which the other tenant runs. */
  makeDb: undefined as unknown as () => Record<string, unknown>,
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/database', async () => {
  const { AsyncLocalStorage: Als } = await import('node:async_hooks');
  hoisted.scope = new Als<string>();
  const later = async <T,>(read: () => T, ms: number): Promise<T> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return read();
  };
  hoisted.makeDb = () => ({
    listAgentTracingThreads: async () => ({
      threads: [{ threadId: `from-${hoisted.scope.getStore()}` }],
      total: await later(() => (hoisted.scope.getStore() === 'tenant_a' ? 1 : 2), hoisted.scope.getStore() === 'tenant_a' ? 20 : 5),
    }),
    findPiiPolicyById: async () => later(() => ({
      _id: 'p1', key: `policy-of-${hoisted.scope.getStore()}`, name: 'n', defaultAction: 'detect', categories: {},
      customPatterns: [], languages: [], enabled: true, metadata: {}, tenantId: 't',
    }), hoisted.scope.getStore() === 'tenant_a' ? 20 : 5),
  });
  return {
    getDatabase: async () => ({}),
    runWithTenantScope: (tenantDbName: string, work: (db: unknown) => unknown) =>
      hoisted.scope.run(tenantDbName, () => work(hoisted.makeDb())),
  };
});

import { AgentTracingService } from '@/lib/services/agentTracing';
import { getPiiPolicy } from '@/lib/services/pii/piiService';

describe('tenant scope in agent tracing and PII policies', () => {
  it('keeps two tenants apart across awaits when AgentTracingService calls interleave', async () => {
    const [a, b] = await Promise.all([
      AgentTracingService.listThreads('tenant_a', 'p1'),
      AgentTracingService.listThreads('tenant_b', 'p1'),
    ]);

    expect(a.threads[0]).toMatchObject({ threadId: 'from-tenant_a' });
    expect(a.total).toBe(1);
    expect(b.threads[0]).toMatchObject({ threadId: 'from-tenant_b' });
    expect(b.total).toBe(2);
  });

  it('keeps two tenants apart across awaits when PII policy reads interleave', async () => {
    const [a, b] = await Promise.all([getPiiPolicy('tenant_a', 'p1'), getPiiPolicy('tenant_b', 'p1')]);

    expect(a?.key).toBe('policy-of-tenant_a');
    expect(b?.key).toBe('policy-of-tenant_b');
  });
});
