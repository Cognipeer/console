/**
 * The boot sweep (`resumePendingRagIngests`) and documents whose OCR is being read by a node that is still alive:
 * on a multi-node queue they are left alone (a second job would read, and pay for, the same pages again), on a
 * single node a `running` stage can only be a lost run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  publish: vi.fn(),
  queueName: { value: 'bullmq' as 'bullmq' | 'memory' },
  documents: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => ({ name: hoisted.queueName.value, publish: hoisted.publish }),
}));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ isServiceEnabled: async () => true }));
vi.mock('@/lib/database', () => ({
  getDatabase: async () => ({ listTenants: async () => [{ _id: 't1', dbName: 'tenant_db', slug: 't1' }] }),
  runWithTenantScope: async (_db: string, work: (db: unknown) => unknown) =>
    work({
      listRagModules: async () => [{ key: 'kb' }],
      listRagDocuments: async () => hoisted.documents,
    }),
}));
vi.mock('@/lib/services/rag/ragService', () => ({ indexPendingRagDocument: vi.fn() }));

import { resumePendingRagIngests } from '@/lib/services/rag/ragIngestJob';

const row = (id: string, stage: string | undefined, ageMs: number) => ({
  _id: id,
  tenantId: 't1',
  projectId: 'p1',
  ...(stage ? { extraction: { sourceType: 'ocr', stage } } : {}),
  updatedAt: new Date(Date.now() - ageMs),
});

beforeEach(() => {
  hoisted.publish.mockReset().mockResolvedValue(undefined);
  hoisted.queueName.value = 'bullmq';
  hoisted.documents = [
    row('plain', undefined, 3_600_000),
    row('queued', 'queued', 5_000),
    row('live', 'running', 10_000),
    row('abandoned', 'running', 3_600_000),
  ];
});

const published = () => hoisted.publish.mock.calls.map(([, , payload]) => (payload as { documentId: string }).documentId);

describe('resumePendingRagIngests', () => {
  it('leaves a document alone that another node is reading right now, on a multi-node queue', async () => {
    await resumePendingRagIngests();
    expect(published()).toEqual(['plain', 'queued', 'abandoned']);
  });

  it('re-publishes every pending document on a single node', async () => {
    hoisted.queueName.value = 'memory';
    await resumePendingRagIngests();
    expect(published()).toEqual(['plain', 'queued', 'live', 'abandoned']);
  });
});
