/**
 * The crawl job runner and the single-page fetch hand the crawl engine the extraction bridge, only for a plan whose
 * OCR is on and only when the installed converter has the extraction API (3.6): an older one keeps the crawler's own
 * OCR path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { crawlMock, findCrawlerByKey, detailedApi } = vi.hoisted(() => ({
  crawlMock: vi.fn(),
  findCrawlerByKey: vi.fn(),
  detailedApi: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('@/lib/services/crawler/crawlerWebhook', () => ({ sendCrawlerWebhook: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/services/crawler/crawlerRagBridge', () => ({ ingestCrawlPage: vi.fn() }));
vi.mock('@/lib/core/cluster', () => ({ routeInstanceCall: vi.fn(), queueNameFor: vi.fn() }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn() }));
vi.mock('@/lib/services/extraction/toMarkdownApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/extraction/toMarkdownApi')>()),
  getConvertToMarkdownDetailed: detailedApi,
}));
vi.mock('@/lib/services/crawler/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawler/engine')>()),
  crawl: crawlMock,
}));

import { createMockDb } from '../helpers/db.mock';
import { getDatabase } from '@/lib/database';
import { runCrawlJobLocal } from '@/lib/services/crawler/crawlerJobService';
import { fetchPageWithCrawler } from '@/lib/services/crawler/singlePage';

const ctx = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' };

function noPages() {
  crawlMock.mockImplementation(async function* () {
    /* no pages */
  });
}

describe('crawl job runner — OCR bridge', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.updateCrawlJob.mockResolvedValue(null);
    db.finalizeCrawlJob.mockResolvedValue({} as never);
    crawlMock.mockReset();
    detailedApi.mockReset().mockReturnValue(vi.fn());
    noPages();
  });

  function job(markdownOptions?: Record<string, unknown>) {
    return {
      _id: 'job-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      crawlerKey: 'docs',
      triggerActor: 'user-1',
      planSnapshot: {
        seeds: ['https://example.com/'],
        engine: 'axios',
        http: { maxConcurrency: 2 },
        ...(markdownOptions ? { markdownOptions } : {}),
      },
    };
  }

  it('hands the engine an extractor and a longer conversion limit when the plan turns OCR on', async () => {
    db.claimCrawlJob.mockResolvedValue(job({ ocr: { enabled: true, modelKey: 'ocr-1', mode: 'always' } }) as never);
    await runCrawlJobLocal(ctx, 'job-1');

    const [receivedPlan, deps] = crawlMock.mock.calls[0];
    expect(receivedPlan.markdownOptions.ocr).toEqual({ enabled: true, modelKey: 'ocr-1', mode: 'always' });
    expect(typeof deps.extractFile).toBe('function');
    expect(deps.ocrConversionTimeoutMs).toBeGreaterThan(60_000);
  });

  it('keeps the crawler\'s own OCR path when the installed converter predates the extraction API', async () => {
    detailedApi.mockReturnValue(undefined);
    db.claimCrawlJob.mockResolvedValue(job({ ocr: { enabled: true, modelKey: 'ocr-1' } }) as never);
    await runCrawlJobLocal(ctx, 'job-1');

    const [receivedPlan, deps] = crawlMock.mock.calls[0];
    expect(receivedPlan.markdownOptions.ocr).toEqual({ enabled: true, modelKey: 'ocr-1' });
    expect(Object.keys(deps).sort()).toEqual(['logger', 'signal']);
  });

  it.each([
    ['no markdown options', undefined],
    ['OCR switched off', { ocr: { enabled: false, modelKey: 'ocr-1' } }],
    ['other markdown options', { cleanup: false }],
  ])('leaves the engine deps as they were with %s', async (_label, options) => {
    db.claimCrawlJob.mockResolvedValue(job(options as Record<string, unknown> | undefined) as never);
    await runCrawlJobLocal(ctx, 'job-1');

    const deps = crawlMock.mock.calls[0][1];
    expect(Object.keys(deps).sort()).toEqual(['logger', 'signal']);
  });
});

describe('fetchPageWithCrawler — OCR bridge', () => {
  beforeEach(() => {
    crawlMock.mockReset();
    detailedApi.mockReset().mockReturnValue(vi.fn());
    noPages();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue({
      switchToTenant: vi.fn().mockResolvedValue(undefined),
      findCrawlerById: vi.fn().mockResolvedValue(null),
      findCrawlerByKey,
    });
  });

  function crawler(markdownOptions?: Record<string, unknown>) {
    return {
      _id: 'c1', key: 'docs', tenantId: 'tenant-1', projectId: 'proj-1', status: 'active',
      seeds: ['https://docs.example.com/start'], engine: 'auto', maxDepth: 0, maxPages: 5, autoCrawl: false,
      scope: { sameDomainOnly: true, includeSubdomains: false }, http: {},
      ...(markdownOptions ? { markdownOptions } : {}),
    };
  }

  it('passes the extractor with the inline budget when the crawler has OCR on', async () => {
    findCrawlerByKey.mockResolvedValue(crawler({ ocr: { enabled: true } }));
    await expect(fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/a.pdf')).rejects.toThrow(/skipped/);

    const deps = crawlMock.mock.calls[0][1];
    expect(typeof deps.extractFile).toBe('function');
    // The inline limit (OCR_INLINE_TIMEOUT_MS + grace) is shorter than a job's document limit.
    expect(deps.ocrConversionTimeoutMs).toBeLessThan(900_000);
  });

  it('passes only logger and signal when OCR is off', async () => {
    findCrawlerByKey.mockResolvedValue(crawler());
    await expect(fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/a')).rejects.toThrow(/skipped/);
    expect(Object.keys(crawlMock.mock.calls[0][1]).sort()).toEqual(['logger', 'signal']);
  });
});
