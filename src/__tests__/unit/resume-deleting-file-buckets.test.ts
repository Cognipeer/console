/**
 * Deleting a bucket with its files marks the bucket and queues a job. The memory queue keeps its jobs in the process, so a
 * restart that comes between the two (or while the job runs) loses the job and leaves the bucket switched off and "being
 * deleted" for good. The boot sweep queues the job again for every bucket still marked, and nothing else:
 *
 *  - only a bucket that is marked, inside a project, is queued;
 *  - each organization is read in its own scope, with its own id, and one that fails does not stop the rest;
 *  - a boot queues no more than a fixed number of buckets, and each job carries a key of its own for the bucket;
 *  - it is a step of the boot that runs after the files consumer is registered and cannot stop the boot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tenants: [] as Array<Record<string, unknown>>,
  /** The buckets of each tenant database, by name; an Error is thrown when the listing is read. */
  buckets: {} as Record<string, unknown>,
  scopes: [] as string[],
  listFileBuckets: vi.fn(),
  publish: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/core/logger', () => ({ createLogger: () => mocks.log }));
vi.mock('@/lib/core/queue', () => ({ getQueue: async () => ({ publish: mocks.publish }) }));
vi.mock('@/lib/database', () => ({
  getDatabase: async () => ({ listTenants: async () => mocks.tenants }),
  runWithTenantScope: async (tenantDbName: string, fn: (db: unknown) => unknown) => {
    mocks.scopes.push(tenantDbName);
    return fn({
      listFileBuckets: async (tenantId: string) => {
        mocks.listFileBuckets(tenantId);
        const buckets = mocks.buckets[tenantDbName];
        if (buckets instanceof Error) throw buckets;
        return buckets ?? [];
      },
    });
  },
}));

import type { IFileBucketRecord } from '@/lib/database';
import { BUCKET_DELETE_ERROR_KEY, BUCKET_DELETING_KEY } from '@/lib/services/files/bucketRules';
import { DELETE_BUCKET_JOB, FILES_QUEUE } from '@/lib/services/files/jobs/filesQueue';
import { resumeDeletingFileBuckets } from '@/server/resumeDeletingFileBuckets';

const tenant = (n: number, over: Record<string, unknown> = {}) => ({ _id: `tenant-${n}`, dbName: `tenant_${n}`, slug: `org-${n}`, ...over });
const marked = (over: Partial<IFileBucketRecord> = {}): IFileBucketRecord => ({
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'docs',
  name: 'Docs',
  providerKey: 'disk',
  status: 'disabled',
  metadata: { [BUCKET_DELETING_KEY]: true },
  createdBy: 'creator',
  updatedBy: 'deleter',
  ...over,
});
const published = () => mocks.publish.mock.calls as Array<[string, string, Record<string, unknown>, { attempts: number; dedupKey: string }]>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenants = [tenant(1)];
  mocks.buckets = {};
  mocks.scopes.length = 0;
  mocks.publish.mockResolvedValue(undefined);
});

describe('a bucket a restart left being deleted', () => {
  it('is queued again, in its project, for the person whose request marked it', async () => {
    mocks.buckets.tenant_1 = [marked()];

    await expect(resumeDeletingFileBuckets()).resolves.toBe(1);

    expect(published()).toHaveLength(1);
    const [queue, job, payload, options] = published()[0]!;
    expect([queue, job]).toEqual([FILES_QUEUE, DELETE_BUCKET_JOB]);
    expect(payload).toEqual({ tenantDbName: 'tenant_1', tenantId: 'tenant-1', projectId: 'proj-1', bucketKey: 'docs', actor: 'deleter' });
    // one attempt, like the request that queued the first one: a run that stops writes why onto the bucket
    expect(options.attempts).toBe(1);
    expect(mocks.log.info).toHaveBeenCalledWith('Resumed bucket deletions', { resumed: 1 });
  });

  it('is run for its creator when nobody else touched it', async () => {
    mocks.buckets.tenant_1 = [marked({ updatedBy: undefined })];

    await resumeDeletingFileBuckets();

    expect(published()[0]![2]).toMatchObject({ actor: 'creator' });
  });

  it('is told apart by its organization, its project and its key', async () => {
    mocks.tenants = [tenant(1), tenant(2)];
    mocks.buckets.tenant_1 = [marked(), marked({ projectId: 'proj-2' }), marked({ key: 'other' })];
    mocks.buckets.tenant_2 = [marked({ tenantId: 'tenant-2' })];

    await resumeDeletingFileBuckets();

    const keys = published().map(([, , , options]) => options.dedupKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    // the same bucket gets the same key on every node that boots, which is what keeps a cluster from queueing it once each
    mocks.publish.mockClear();
    await resumeDeletingFileBuckets();
    expect(published().map(([, , , options]) => options.dedupKey)).toEqual(keys);
  });
});

describe('buckets that are not left to resume', () => {
  it('are not queued: a bucket that takes files, one switched off, one that stopped with an error, one with no project', async () => {
    mocks.buckets.tenant_1 = [
      marked({ key: 'active', status: 'active', metadata: {} }),
      marked({ key: 'no-metadata', metadata: undefined }),
      marked({ key: 'switched-off', metadata: {} }),
      marked({ key: 'stopped', metadata: { [BUCKET_DELETE_ERROR_KEY]: '1 file could not be deleted from the storage provider.' } }),
      // the mark is the boolean true and nothing else
      marked({ key: 'text', metadata: { [BUCKET_DELETING_KEY]: 'true' } }),
      marked({ key: 'number', metadata: { [BUCKET_DELETING_KEY]: 1 } }),
      marked({ key: 'cleared', metadata: { [BUCKET_DELETING_KEY]: false } }),
      marked({ key: 'no-project', projectId: undefined }),
      marked({ key: 'marked' }),
    ];

    await expect(resumeDeletingFileBuckets()).resolves.toBe(1);

    expect(published().map(([, , payload]) => payload.bucketKey)).toEqual(['marked']);
  });

  it('leave the queue alone and the log quiet when there is none', async () => {
    mocks.buckets.tenant_1 = [marked({ metadata: {} })];

    await expect(resumeDeletingFileBuckets()).resolves.toBe(0);

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});

describe('the organizations', () => {
  it('are each read in their own scope, by their own id', async () => {
    mocks.tenants = [tenant(1), tenant(2)];
    mocks.buckets.tenant_2 = [marked({ tenantId: 'tenant-2', key: 'theirs' })];

    await resumeDeletingFileBuckets();

    expect(mocks.scopes).toEqual(['tenant_1', 'tenant_2']);
    expect(mocks.listFileBuckets.mock.calls).toEqual([['tenant-1'], ['tenant-2']]);
    expect(published()[0]![2]).toMatchObject({ tenantDbName: 'tenant_2', tenantId: 'tenant-2', bucketKey: 'theirs' });
  });

  it('are skipped when they have no database or no id', async () => {
    mocks.tenants = [tenant(1, { dbName: undefined }), tenant(2, { _id: undefined }), tenant(3)];
    mocks.buckets.tenant_1 = [marked()];
    mocks.buckets.tenant_2 = [marked()];
    mocks.buckets.tenant_3 = [marked({ tenantId: 'tenant-3', key: 'kept' })];

    await expect(resumeDeletingFileBuckets()).resolves.toBe(1);

    expect(mocks.scopes).toEqual(['tenant_3']);
    expect(published()[0]![2]).toMatchObject({ bucketKey: 'kept' });
  });

  it('do not stop the sweep when one of them cannot be read', async () => {
    mocks.tenants = [tenant(1), tenant(2)];
    mocks.buckets.tenant_1 = new Error('database unavailable');
    mocks.buckets.tenant_2 = [marked({ tenantId: 'tenant-2' })];

    await expect(resumeDeletingFileBuckets()).resolves.toBe(1);

    expect(published()[0]![2]).toMatchObject({ tenantDbName: 'tenant_2' });
    expect(mocks.log.warn).toHaveBeenCalledWith('Failed to resume bucket deletions for tenant', { tenant: 'org-1', error: 'database unavailable' });
  });

  it('do not stop the sweep when a job cannot be queued for one of them', async () => {
    mocks.tenants = [tenant(1), tenant(2)];
    mocks.buckets.tenant_1 = [marked()];
    mocks.buckets.tenant_2 = [marked({ tenantId: 'tenant-2' })];
    mocks.publish.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(resumeDeletingFileBuckets()).resolves.toBe(1);

    expect(mocks.log.warn).toHaveBeenCalledWith('Failed to resume bucket deletions for tenant', { tenant: 'org-1', error: 'queue unavailable' });
    expect(published().map(([, , payload]) => payload.tenantDbName)).toEqual(['tenant_1', 'tenant_2']);
  });
});

describe('a boot that finds a great many', () => {
  const many = (tenantId: string, count: number) => Array.from({ length: count }, (_, i) => marked({ tenantId, key: `b-${i}` }));

  it('queues no more than a hundred, and does not read the organizations after that', async () => {
    mocks.tenants = [tenant(1), tenant(2), tenant(3), tenant(4)];
    mocks.buckets.tenant_1 = many('tenant-1', 40);
    mocks.buckets.tenant_2 = many('tenant-2', 40);
    mocks.buckets.tenant_3 = many('tenant-3', 40);
    mocks.buckets.tenant_4 = many('tenant-4', 40);

    await expect(resumeDeletingFileBuckets()).resolves.toBe(100);

    expect(published()).toHaveLength(100);
    // 40 + 40 + the first 20 of the third; the fourth is never read
    expect(published().filter(([, , payload]) => payload.tenantDbName === 'tenant_3')).toHaveLength(20);
    expect(mocks.scopes).toEqual(['tenant_1', 'tenant_2', 'tenant_3']);
    expect(mocks.log.info).toHaveBeenCalledWith('Resumed bucket deletions', { resumed: 100 });
  });

  it('counts only the jobs that were queued', async () => {
    mocks.buckets.tenant_1 = many('tenant-1', 150);
    let calls = 0;
    mocks.publish.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('queue unavailable');
    });

    // the first failure ends that organization's turn; nothing is counted for it
    await expect(resumeDeletingFileBuckets()).resolves.toBe(0);
    expect(published()).toHaveLength(1);
  });
});

describe('the boot of the server', () => {
  const source = readFileSync(join(__dirname, '../../server/bootstrap.ts'), 'utf8');

  it('runs the sweep after the files consumer is registered, and before the server reports itself ready', () => {
    const consumer = source.indexOf('startFilesQueueConsumer(),');
    const sweep = source.indexOf('resumeDeletingFileBuckets,');
    const ready = source.indexOf('applicationReady = true;');

    expect(consumer).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(consumer);
    expect(ready).toBeGreaterThan(sweep);
  });

  it('runs it as a step that cannot stop the boot', () => {
    expect(source).toMatch(/await bestEffort\(resumeDeletingFileBuckets, '[^']+'\);/);
  });
});
