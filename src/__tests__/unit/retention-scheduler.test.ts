/**
 * Retention jobs: the scheduled sweep (dry-run records at most daily), and the
 * purge lifecycle - queued, run in slices, cancelled, waiting on the tenant
 * lock, and treated as failed once its process is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb, type MockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const locks = new Set<string>();
  return {
    db: null as unknown,
    store,
    locks,
    published: [] as Array<{ queue: string; job: string; payload: Record<string, unknown>; opts: Record<string, unknown> }>,
  };
});

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({
    name: 'memory',
    get: async (key: string) => h.store.get(key),
    set: async (key: string, value: unknown) => { h.store.set(key, JSON.parse(JSON.stringify(value))); },
    del: async (key: string) => { h.store.delete(key); },
    acquireLock: async (key: string) => (h.locks.has(key) ? undefined : (h.locks.add(key), 'token')),
    releaseLock: async (key: string) => { h.locks.delete(key); },
  })),
}));
vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({
    publish: async (queue: string, job: string, payload: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      h.published.push({ queue, job, payload, opts });
      return 'job-id';
    },
  })),
}));

import {
  RetentionPurgeConflictError,
  cancelPurge,
  getLastSweep,
  getPurgeStatus,
  requestPurge,
  runPurgeSlice,
  sweepTenant,
} from '@/lib/retention/scheduler';

const tenant = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', tenantSlug: 'acme' };
let db: MockDb;

beforeEach(() => {
  h.store.clear();
  h.locks.clear();
  h.published.length = 0;
  db = createMockDb();
  h.db = db;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sweepTenant', () => {
  it('in dry run counts, keeps the summary and leaves a record at most once a day', async () => {
    db.retentionCount.mockResolvedValue(4);

    expect(await sweepTenant(tenant)).toBe(true);
    expect(await sweepTenant(tenant)).toBe(true);

    expect(db.retentionDeleteBatch).not.toHaveBeenCalled();
    expect(db.createAuditLog).toHaveBeenCalledTimes(1);
    expect(db.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      service: 'retention', event: 'retention.sweep', actorType: 'system',
      metadata: expect.objectContaining({ dryRun: true }),
    }));
    expect(await getLastSweep('tenant_acme')).toMatchObject({ dryRun: true, done: true });
  });

  it('writes nothing when there is nothing to do', async () => {
    await sweepTenant(tenant);
    expect(db.createAuditLog).not.toHaveBeenCalled();
  });

  it('skips a tenant another job holds', async () => {
    h.locks.add('retention:lock:tenant_acme');
    expect(await sweepTenant(tenant)).toBe(true);
    expect(db.retentionCount).not.toHaveBeenCalled();
  });
});

describe('purge', () => {
  it('queues once, then refuses a second purge while the first is active', async () => {
    const status = await requestPurge(tenant, { mode: { kind: 'policy' } }, 'owner@acme.test', 12);
    expect(status).toMatchObject({ state: 'queued', estimate: 12, requestedBy: 'owner@acme.test' });
    expect(h.published).toEqual([expect.objectContaining({ queue: 'retention', job: 'purge', payload: expect.objectContaining({ purgeId: status.id }) })]);

    await expect(requestPurge(tenant, { mode: { kind: 'policy' } }, null, 0)).rejects.toBeInstanceOf(RetentionPurgeConflictError);
  });

  it('runs regardless of dry run, finishes and leaves a destruction record', async () => {
    db.retentionDeleteBatch.mockResolvedValueOnce(3).mockResolvedValue(0);
    const status = await requestPurge(tenant, { mode: { kind: 'olderThan', days: 7 }, classes: ['telemetry'] }, 'owner@acme.test', 3);

    await runPurgeSlice(tenant, status.id, 0);

    const done = await getPurgeStatus('tenant_acme');
    expect(done).toMatchObject({ state: 'done', deleted: 3, byClass: { telemetry: { deleted: 3, redacted: 0 } } });
    expect(db.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'retention.purge', actorType: 'user', actorEmail: 'owner@acme.test',
      metadata: expect.objectContaining({ deleted: 3, state: 'done', dryRun: false }),
    }));
    // A finished purge does not block the next one.
    await expect(requestPurge(tenant, { mode: { kind: 'policy' } }, null, 0)).resolves.toMatchObject({ state: 'queued' });
  });

  it('stops when cancelled', async () => {
    const status = await requestPurge(tenant, { mode: { kind: 'policy' } }, null, 0);
    await cancelPurge('tenant_acme');

    await runPurgeSlice(tenant, status.id, 0);

    expect(await getPurgeStatus('tenant_acme')).toMatchObject({ state: 'cancelled' });
    expect(db.retentionDeleteBatch).not.toHaveBeenCalled();
  });

  it('waits and re-queues itself while a sweep holds the tenant', async () => {
    const status = await requestPurge(tenant, { mode: { kind: 'policy' } }, null, 0);
    h.locks.add('retention:lock:tenant_acme');

    await runPurgeSlice(tenant, status.id, 0);

    expect(await getPurgeStatus('tenant_acme')).toMatchObject({ state: 'waiting' });
    expect(h.published.at(-1)).toMatchObject({ job: 'purge', payload: { slice: 1 }, opts: { delayMs: 30_000 } });
  });

  it('reports an active purge that stopped writing as failed, so a new one can start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'));
    await requestPurge(tenant, { mode: { kind: 'policy' } }, null, 0);
    vi.setSystemTime(new Date('2026-10-23T11:00:00.000Z'));

    expect(await getPurgeStatus('tenant_acme')).toMatchObject({ state: 'failed', error: expect.stringContaining('Interrupted') });
    await expect(requestPurge(tenant, { mode: { kind: 'policy' } }, null, 0)).resolves.toMatchObject({ state: 'queued' });
  });
});
