/**
 * Unit tests — the OCR queue consumer runs each item inside a tenant scope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handler: null as null | ((job: { name: string; data: unknown }) => Promise<unknown>),
  scope: vi.fn(),
  process: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/database', () => ({
  runWithTenantScope: mocks.scope,
}));
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({
    consume: (_name: string, fn: typeof mocks.handler) => {
      mocks.handler = fn;
    },
  })),
}));
vi.mock('@/lib/core/cluster', () => ({ queueNameFor: (n: string) => n }));
vi.mock('@/lib/services/ocrJobs/ocrJobRunner', () => ({ processOcrItem: mocks.process }));

import { startOcrJobQueueConsumer } from '@/lib/services/ocrJobs/ocrJobConsumer';

beforeEach(() => {
  mocks.scope.mockImplementation(async (_name: string, fn: () => unknown) => fn());
});

describe('startOcrJobQueueConsumer', () => {
  it('processes items within the tenant scope of the payload', async () => {
    await startOcrJobQueueConsumer();
    const ctx = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1', userId: 'u1' };
    await mocks.handler!({ name: 'ocr.item', data: { ctx, itemId: 'i1' } });
    expect(mocks.scope).toHaveBeenCalledWith('tenant_db', expect.any(Function));
    expect(mocks.process).toHaveBeenCalledWith(ctx, 'i1');
  });
});
