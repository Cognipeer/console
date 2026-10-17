/**
 * Crawler scheduler — a due cron slot is dispatched exactly once even when two
 * replicas tick concurrently (the DB claim arbitrates; the cache lock does not).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claimed = new Set<string>();
const claimSchedulerSlot = vi.fn(async (key: string) => {
  // Yield so both ticks interleave between check and write, like two replicas.
  await Promise.resolve();
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
});
const cleanupSchedulerClaims = vi.fn(async () => 0);
const updateCrawler = vi.fn(async () => undefined);
const runCrawler = vi.fn(async () => undefined);

const crawler = {
  _id: 'crawler-1',
  key: 'docs',
  projectId: 'p1',
  status: 'active',
  createdAt: new Date('2026-05-19T08:00:00.000Z'),
  schedule: { mode: 'cron', enabled: true, cron: '0 * * * *' },
};

vi.mock('@/lib/database', () => ({
  getDatabase: async () => ({ listTenants: async () => [{ _id: 't1', slug: 't1', dbName: 'tenant_t1' }] }),
  runWithTenantScope: async (_db: string, fn: (db: unknown) => Promise<void>) =>
    fn({
      listCrawlers: async () => [crawler],
      claimSchedulerSlot,
      cleanupSchedulerClaims,
      updateCrawler,
    }),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: async () => ({ name: 'memory', acquireLock: async () => 'tok', releaseLock: async () => undefined }),
}));
vi.mock('@/lib/core/cluster', () => ({
  findInstanceAssignment: async () => null,
  getThisNodeName: () => 'node-a',
  resolveDefaultNodeName: async () => 'node-a',
}));
vi.mock('@/lib/services/crawler/crawlerService', () => ({ runCrawler }));

describe('crawler scheduler slot claims', () => {
  beforeEach(() => {
    vi.resetModules();
    claimed.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-19T10:00:20.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches a due cron slot once for two concurrent ticks', async () => {
    const a = await import('@/lib/services/crawler/crawlerScheduler');
    // Second "replica": a fresh module instance with its own in-process guard.
    vi.resetModules();
    const b = await import('@/lib/services/crawler/crawlerScheduler');

    await Promise.all([a.triggerCrawlerSchedulerRun(), b.triggerCrawlerSchedulerRun()]);

    expect(runCrawler).toHaveBeenCalledTimes(1);
    expect([...claimed]).toEqual(['crawler:crawler-1:default:2026-05-19T10:00:00.000Z']);
    expect(updateCrawler).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when the slot is already claimed', async () => {
    claimed.add('crawler:crawler-1:default:2026-05-19T10:00:00.000Z');
    const s = await import('@/lib/services/crawler/crawlerScheduler');
    await s.triggerCrawlerSchedulerRun();
    expect(runCrawler).not.toHaveBeenCalled();
  });

  it('sweeps expired claims for the tenant', async () => {
    const s = await import('@/lib/services/crawler/crawlerScheduler');
    await s.triggerCrawlerSchedulerRun();
    expect(cleanupSchedulerClaims).toHaveBeenCalledTimes(1);
  });
});
