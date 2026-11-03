/**
 * A crawl result keeps the engine that produced it and how long its fetch took,
 * on BOTH providers, and rows saved without them read back without them.
 */
import { beforeAll, expect, it } from 'vitest';

import { describeForEachProvider } from '../integration/db-parity.helper';

const suffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeForEachProvider('crawl result fetch timing', (getDb) => {
  const tenantId = 'tenant-crawl-timing';
  const dbName = `tenant_crawl_timing_${suffix()}`;
  const jobId = `job-${suffix()}`;

  beforeAll(async () => {
    const db = getDb();
    await db.switchToTenant(dbName);
    const rows = [
      { url: 'https://a.test/axios', type: 'html' as const, engine: 'axios' as const, fetchMs: 412 },
      { url: 'https://a.test/browser', type: 'html' as const, engine: 'playwright' as const, fetchMs: 18_204 },
      // An error keeps its time, with no engine.
      { url: 'https://a.test/broken', type: 'error' as const, fetchMs: 30_011, errorMessage: 'All engines failed' },
      // A row saved before the fields existed.
      { url: 'https://a.test/legacy', type: 'html' as const },
    ];
    for (const row of rows) {
      await db.createCrawlResult({ tenantId, jobId, depth: 0, bodyMarkdown: '# body', ...row });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  });

  it('reads the engine and fetch time back, with and without the body', async () => {
    const db = getDb();
    for (const omitBody of [false, true]) {
      const byUrl = new Map(
        (await db.listCrawlResults(jobId, { omitBody })).map((r) => [r.url, r]),
      );
      expect(byUrl.get('https://a.test/axios')).toMatchObject({ engine: 'axios', fetchMs: 412 });
      expect(byUrl.get('https://a.test/browser')).toMatchObject({ engine: 'playwright', fetchMs: 18_204 });
    }
  });

  it('finds a single result by id with both fields', async () => {
    const db = getDb();
    const [first] = await db.listCrawlResults(jobId, { limit: 1 });
    const found = await db.findCrawlResultById(String(first!._id));
    expect(found).toMatchObject({ url: 'https://a.test/axios', engine: 'axios', fetchMs: 412 });
  });

  it('keeps an error row\'s time and leaves its engine unset', async () => {
    const rows = await getDb().listCrawlResults(jobId, { type: 'error' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fetchMs).toBe(30_011);
    expect(rows[0]!.engine).toBeUndefined();
  });

  it('reads a row saved without them as unset, not zero or null', async () => {
    const rows = await getDb().listCrawlResults(jobId, { search: 'legacy' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.engine).toBeUndefined();
    expect(rows[0]!.fetchMs).toBeUndefined();
  });
});
