import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handler: undefined as undefined | ((ctx: unknown) => Promise<unknown>),
  runJobUnderLease: vi.fn(),
  runCrawlJobLocal: vi.fn(),
}));

vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/core/cluster', () => ({ queueNameFor: (name: string) => `q-${name}` }));
vi.mock('@/lib/core/queue', () => ({
  getQueue: async () => ({
    consume: (_name: string, handler: (ctx: unknown) => Promise<unknown>) => {
      h.handler = handler;
    },
  }),
}));
vi.mock('@/lib/services/planLeases', () => ({ runJobUnderLease: h.runJobUnderLease }));
vi.mock('@/lib/services/crawler/crawlerJobService', () => ({ runCrawlJobLocal: h.runCrawlJobLocal }));

import { startCrawlerQueueConsumer } from '@/lib/services/crawler/crawlerConsumer';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('crawler queue consumer', () => {
  it('runs each crawl under a lease from the crawler pool', async () => {
    h.runJobUnderLease.mockResolvedValue({ deferred: false, value: undefined });
    await startCrawlerQueueConsumer();
    const data = { ctx: { tenantId: 't1' }, jobId: 'j1' };
    await h.handler!({ name: 'crawler.run', data });
    expect(h.runJobUnderLease).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', holderId: 'j1', pool: 'crawler', jobName: 'crawler.run' }),
    );
  });
});
