/**
 * Unit tests — crawler run start checks the quota (one request, page window
 * must have room), the single-page fetch counts a request and a page, and a
 * refusal creates no job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforce: vi.fn(),
  createCrawlJob: vi.fn(),
  findCrawlerByKey: vi.fn(),
}));

vi.mock('@/lib/quota/serviceQuota', () => ({ enforceServiceQuota: mocks.enforce }));
vi.mock('@/lib/database', () => {
  const db = {
    findCrawlerById: vi.fn().mockResolvedValue(null),
    findCrawlerByKey: mocks.findCrawlerByKey,
    createCrawlJob: mocks.createCrawlJob,
  };
  return {
    getDatabase: vi.fn().mockResolvedValue(db),
    runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(db)),
  };
});
vi.mock('@/lib/services/availability/serviceAvailability', () => ({ assertServiceEnabled: vi.fn() }));
vi.mock('@/lib/services/crawler/engine', () => ({
  crawl: async function* () { yield { url: 'https://a.test/', type: 'html', body: 'x', depth: 0, fetchedAt: new Date() }; },
}));
vi.mock('@/lib/core/cluster', () => ({ routeInstanceCall: vi.fn(), queueNameFor: vi.fn() }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn() }));

import { runCrawler } from '@/lib/services/crawler/crawlerService';
import { fetchPageWithCrawler } from '@/lib/services/crawler/singlePage';

const ctx = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };
const crawler = {
  _id: 'c1', key: 'docs', tenantId: 't1', projectId: 'p1', status: 'active',
  seeds: ['https://a.test/'], engine: 'auto', maxDepth: 0, maxPages: 5, autoCrawl: false,
  scope: { sameDomainOnly: true, includeSubdomains: false }, http: {},
};

describe('crawler quota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCrawlerByKey.mockResolvedValue(crawler);
    mocks.createCrawlJob.mockResolvedValue({ _id: 'job1' });
  });

  it('run start checks one request with page-window headroom, before the job exists', async () => {
    const refusal = Object.assign(new Error('pages exhausted'), { name: 'QuotaExceededError', status: 429 });
    mocks.enforce.mockRejectedValue(refusal);

    await expect(runCrawler(ctx, 'docs', { triggerActor: 'me', mode: 'async' })).rejects.toBe(refusal);

    expect(mocks.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', projectId: 'p1' }),
      expect.objectContaining({ domain: 'crawler', resourceKey: 'docs', cost: { requests: 1 }, headroom: ['units'] }),
    );
    expect(mocks.createCrawlJob).not.toHaveBeenCalled();
  });

  it('does not check scheduler runs (no caller)', async () => {
    mocks.enforce.mockResolvedValue(null);
    await runCrawler(ctx, 'docs', { trigger: 'schedule', triggerActor: 'system:scheduler', mode: 'async' }).catch(() => undefined);
    expect(mocks.enforce).not.toHaveBeenCalled();
  });

  it('single-page fetch counts one request and one page', async () => {
    mocks.enforce.mockResolvedValue(null);
    await fetchPageWithCrawler(ctx, 'docs', 'https://a.test/');
    expect(mocks.enforce).toHaveBeenCalledWith(
      expect.anything(),
      { domain: 'crawler', resourceKey: 'docs', cost: { requests: 1, units: 1 } },
    );
  });
});
