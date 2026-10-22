/**
 * Crawl-result list/count filters behind the run browser, on BOTH providers:
 * paging, type / Knowledge Engine status filters, literal search, and the
 * body-less summary rows.
 */
import { beforeAll, expect, it } from 'vitest';

import type { ICrawlResult } from '@/lib/database/provider.interface';
import { describeForEachProvider } from '../integration/db-parity.helper';

const suffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeForEachProvider('crawl result filters', (getDb) => {
  const tenantId = 'tenant-crawl-filters';
  const dbName = `tenant_crawl_filters_${suffix()}`;
  const jobId = `job-${suffix()}`;

  beforeAll(async () => {
    const db = getDb();
    await db.switchToTenant(dbName);
    const rows: Array<Omit<ICrawlResult, '_id' | 'createdAt'>> = [
      { tenantId, jobId, url: 'https://a.test/pricing', depth: 0, type: 'html', title: 'Pricing 100%_off', bodyMarkdown: 'big body', ragStatus: 'indexed' },
      { tenantId, jobId, url: 'https://a.test/docs', depth: 1, type: 'html', title: 'Docs Übersicht', bodyMarkdown: 'docs body', ragStatus: 'failed' },
      { tenantId, jobId, url: 'https://a.test/guide.pdf', depth: 1, type: 'file', bodyMarkdown: 'pdf text' },
      { tenantId, jobId, url: 'https://a.test/broken', depth: 1, type: 'error', errorMessage: 'ECONNRESET upstream' },
      { tenantId, jobId: 'other-job', url: 'https://a.test/pricing', depth: 0, type: 'html' },
    ];
    // Distinct createdAt values: the order under test is createdAt, not the tiebreak.
    for (const row of rows) {
      await db.createCrawlResult(row);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  });

  it('pages in insertion order and can leave the body out', async () => {
    const db = getDb();
    const all = await db.listCrawlResults(jobId);
    expect(all.map((r) => r.url)).toEqual([
      'https://a.test/pricing',
      'https://a.test/docs',
      'https://a.test/guide.pdf',
      'https://a.test/broken',
    ]);
    expect(all[0]!.bodyMarkdown).toBe('big body');

    const page = await db.listCrawlResults(jobId, { limit: 2, skip: 1, omitBody: true });
    expect(page.map((r) => r.url)).toEqual(['https://a.test/docs', 'https://a.test/guide.pdf']);
    expect(page.every((r) => r.bodyMarkdown === undefined)).toBe(true);
    expect(page[0]!.title).toBe('Docs Übersicht');

    // OFFSET without a LIMIT.
    expect((await db.listCrawlResults(jobId, { skip: 3 })).map((r) => r.url)).toEqual(['https://a.test/broken']);
  });

  it('filters by type and Knowledge Engine status, with none = never sent', async () => {
    const db = getDb();
    expect(await db.countCrawlResults(jobId)).toBe(4);
    expect(await db.countCrawlResults(jobId, { type: 'html' })).toBe(2);
    expect(await db.countCrawlResults(jobId, { ragStatus: 'failed' })).toBe(1);
    expect(await db.countCrawlResults(jobId, { ragStatus: 'none' })).toBe(2);
    const noneHtml = await db.listCrawlResults(jobId, { type: 'file', ragStatus: 'none' });
    expect(noneHtml.map((r) => r.url)).toEqual(['https://a.test/guide.pdf']);
  });

  it('searches url, title and error message case-insensitively with wildcards taken literally', async () => {
    const db = getDb();
    expect(await db.countCrawlResults(jobId, { search: 'GUIDE.PDF' })).toBe(1);
    expect(await db.countCrawlResults(jobId, { search: 'übersicht' })).toBe(1);
    expect(await db.countCrawlResults(jobId, { search: 'econnreset' })).toBe(1);
    expect(await db.countCrawlResults(jobId, { search: '100%_off' })).toBe(1);
    expect(await db.countCrawlResults(jobId, { search: '1%0' })).toBe(0);
    expect(await db.countCrawlResults(jobId, { search: 'a.test/(' })).toBe(0);
    expect(await db.countCrawlResults(jobId, { search: '   ' })).toBe(4);
  });

  it('counts rows per type for one job only', async () => {
    expect(await getDb().countCrawlResultsByType(jobId)).toEqual({ html: 2, file: 1, error: 1 });
    expect(await getDb().countCrawlResultsByType('missing-job')).toEqual({});
  });
});
