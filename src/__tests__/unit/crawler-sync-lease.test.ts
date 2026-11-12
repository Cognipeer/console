/**
 * A sync crawl run in the request holds a 'crawler' lease like the queue consumer, and a full pool refuses it with
 * tenant_concurrency_limited (never requeued) and fails the job so nothing runs it later.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tryPoolLease: vi.fn(),
  release: vi.fn(async () => undefined),
  runCrawlJobLocal: vi.fn(async () => undefined),
  updateCrawlJob: vi.fn(async () => null),
  publish: vi.fn(),
}));

vi.mock('@/lib/quota/serviceQuota', () => ({ enforceServiceQuota: vi.fn(async () => null) }));
vi.mock('@/lib/database', () => {
  const db = {
    findCrawlerById: vi.fn().mockResolvedValue(null),
    findCrawlerByKey: vi.fn().mockResolvedValue({
      _id: 'c1', key: 'docs', tenantId: 't1', projectId: 'p1', status: 'active', seeds: ['https://a.test/'],
      engine: 'auto', maxDepth: 0, maxPages: 5, autoCrawl: false, scope: {}, http: {},
    }),
    createCrawlJob: vi.fn().mockResolvedValue({ _id: 'job1' }),
    updateCrawlJob: h.updateCrawlJob,
  };
  return {
    getDatabase: vi.fn().mockResolvedValue(db),
    runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(db)),
  };
});
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
vi.mock('@/lib/core/cluster', () => ({
  routeInstanceCall: (_target: unknown, _payload: unknown, local: () => Promise<void>) => local(),
  queueNameFor: (name: string) => `q-${name}`,
}));
vi.mock('@/lib/core/queue', () => ({ getQueue: async () => ({ publish: h.publish }) }));
vi.mock('@/lib/services/planLeases', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/planLeases')>()),
  tryPoolLease: h.tryPoolLease,
}));
vi.mock('@/lib/services/crawler/crawlerJobService', () => ({ runCrawlJobLocal: h.runCrawlJobLocal }));

import { runCrawler } from '@/lib/services/crawler/crawlerService';

const ctx = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sync crawler runs and the crawler pool', () => {
  it('runs the crawl under a lease of the crawler pool and releases it afterwards, even when the crawl throws', async () => {
    h.tryPoolLease.mockResolvedValue({ refused: false, lease: { release: h.release }, decision: { allowed: true } });
    await runCrawler(ctx, 'docs', { triggerActor: 'me', mode: 'sync' });
    expect(h.tryPoolLease).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', pool: 'crawler', holderId: 'job1' }));
    expect(h.runCrawlJobLocal).toHaveBeenCalledWith(ctx, 'job1');
    expect(h.release).toHaveBeenCalledTimes(1);

    h.runCrawlJobLocal.mockRejectedValueOnce(new Error('boom'));
    await expect(runCrawler(ctx, 'docs', { triggerActor: 'me' })).rejects.toThrow('boom');
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('refuses with tenant_concurrency_limited when the pool is full, without running or requeueing', async () => {
    h.tryPoolLease.mockResolvedValue({ refused: true, lease: null, decision: { allowed: false, limit: 1, used: 1 } });
    await expect(runCrawler(ctx, 'docs', { triggerActor: 'me', mode: 'sync' }))
      .rejects.toMatchObject({ code: 'tenant_concurrency_limited' });
    expect(h.runCrawlJobLocal).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.updateCrawlJob).toHaveBeenCalledWith('job1', expect.objectContaining({ status: 'failed' }));
  });
});
