/**
 * The ingest consumer runs each job inside the tenant scope of its payload. A deferred OCR extraction awaits for
 * minutes between queries, and two jobs for different tenants interleave on one node; a bare `switchToTenant` would
 * let the second job's binding leak into the first job's later queries.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  seen: [] as Array<{ documentId: string; tenant: string | undefined }>,
  scope: undefined as unknown as AsyncLocalStorage<string>,
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/core/queue', () => ({ getQueue: async () => ({ name: 'memory', publish: vi.fn() }) }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ isServiceEnabled: async () => true }));
vi.mock('@/lib/database', async () => {
  const { AsyncLocalStorage: Als } = await import('node:async_hooks');
  hoisted.scope = new Als<string>();
  return {
    getDatabase: async () => ({}),
    runWithTenantScope: (tenantDbName: string, work: (db: unknown) => unknown) =>
      hoisted.scope.run(tenantDbName, () => work({})),
  };
});
vi.mock('@/lib/services/rag/ragService', () => ({
  indexPendingRagDocument: async (_tenantDbName: string, _tenantId: string, _projectId: string, _key: string, documentId: string) => {
    // The OCR wait: the other tenant's job runs in between.
    await new Promise((resolve) => setTimeout(resolve, documentId === 'doc-a' ? 20 : 5));
    hoisted.seen.push({ documentId, tenant: hoisted.scope.getStore() });
  },
}));

import { runRagIngestJob } from '@/lib/services/rag/ragIngestJob';

describe('runRagIngestJob', () => {
  it('keeps each job bound to its own tenant across long awaits while jobs interleave', async () => {
    await Promise.all([
      runRagIngestJob({ tenantDbName: 'tenant_a', tenantId: 'ta', ragModuleKey: 'kb', documentId: 'doc-a' }),
      runRagIngestJob({ tenantDbName: 'tenant_b', tenantId: 'tb', ragModuleKey: 'kb', documentId: 'doc-b' }),
    ]);

    expect(hoisted.seen).toEqual([
      { documentId: 'doc-b', tenant: 'tenant_b' },
      { documentId: 'doc-a', tenant: 'tenant_a' },
    ]);
  });
});
