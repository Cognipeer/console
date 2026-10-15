/**
 * Unit tests — realtime single-page fetch through a crawler (agent `web_fetch`).
 * The model picks the URL, so the host policy is the security boundary: seed
 * hosts + allowList, minus blockList, and no open-web fetch for a crawler that
 * carries credentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { crawlMock, findCrawlerById, findCrawlerByKey } = vi.hoisted(() => ({
  crawlMock: vi.fn(),
  findCrawlerById: vi.fn(),
  findCrawlerByKey: vi.fn(),
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue({
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    findCrawlerById,
    findCrawlerByKey,
  }),
}));
vi.mock('@/lib/services/crawler/engine', () => ({ crawl: crawlMock }));
vi.mock('@/lib/core/cluster', () => ({ routeInstanceCall: vi.fn(), queueNameFor: vi.fn() }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn() }));

import {
  crawlerHasCredentials,
  fetchPageWithCrawler,
  refuseCrawlerUrl,
  WEB_FETCH_MAX_CHARS,
} from '@/lib/services/crawler/singlePage';

const ctx = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };

function crawler(over: Record<string, unknown> = {}) {
  return {
    _id: 'c1',
    key: 'docs',
    tenantId: 't1',
    projectId: 'p1',
    status: 'active',
    seeds: ['https://docs.example.com/start'],
    engine: 'auto',
    maxDepth: 2,
    maxPages: 50,
    autoCrawl: true,
    scope: { sameDomainOnly: true, includeSubdomains: false },
    http: {},
    ...over,
  };
}

function pages(...items: Array<Record<string, unknown>>) {
  crawlMock.mockImplementation(async function* () {
    for (const item of items) yield { depth: 0, fetchedAt: new Date(), ...item };
  });
}

describe('refuseCrawlerUrl', () => {
  const base = crawler() as never;

  it('allows the seed host and refuses others', () => {
    expect(refuseCrawlerUrl(base, 'https://docs.example.com/a/b')).toBeNull();
    expect(refuseCrawlerUrl(base, 'https://evil.test/x')).toMatch(/outside/);
  });

  it('allows subdomains of a seed only with includeSubdomains', () => {
    expect(refuseCrawlerUrl(base, 'https://api.docs.example.com/')).toMatch(/outside/);
    const withSubs = crawler({ scope: { sameDomainOnly: true, includeSubdomains: true } }) as never;
    expect(refuseCrawlerUrl(withSubs, 'https://api.docs.example.com/')).toBeNull();
  });

  it('allows allowList hosts (wildcards) and lets blockList win', () => {
    const c = crawler({
      seeds: [],
      scope: { sameDomainOnly: true, includeSubdomains: false, allowList: ['*.example.org'], blockList: ['secret.example.org'] },
    }) as never;
    expect(refuseCrawlerUrl(c, 'https://a.example.org/')).toBeNull();
    expect(refuseCrawlerUrl(c, 'https://secret.example.org/')).toMatch(/blocked/);
    expect(refuseCrawlerUrl(c, 'https://example.com/')).toMatch(/outside/);
  });

  it('rejects non-http(s) and malformed URLs', () => {
    expect(refuseCrawlerUrl(base, 'file:///etc/passwd')).toMatch(/http/);
    expect(refuseCrawlerUrl(base, 'not a url')).toMatch(/valid/);
  });

  it('open web is fine without credentials, refused with them', () => {
    const open = crawler({ seeds: [] }) as never;
    expect(refuseCrawlerUrl(open, 'https://anything.test/')).toBeNull();
    const authed = crawler({ seeds: [], http: { bearerToken: 'x' } }) as never;
    expect(refuseCrawlerUrl(authed, 'https://anything.test/')).toMatch(/credentials/);
  });
});

describe('crawlerHasCredentials', () => {
  it('sees every credential form, including a sealed payload', () => {
    expect(crawlerHasCredentials({})).toBe(false);
    expect(crawlerHasCredentials({ userAgent: 'ua' })).toBe(false);
    expect(crawlerHasCredentials({ sealed: 'abc' })).toBe(true);
    expect(crawlerHasCredentials({ headers: { 'X-Api-Key': 'k' } })).toBe(true);
    expect(crawlerHasCredentials({ cookies: [{ name: 'a', value: 'b' }] })).toBe(true);
    expect(crawlerHasCredentials({ basicAuth: { username: 'u' } })).toBe(true);
  });
});

describe('fetchPageWithCrawler', () => {
  beforeEach(() => {
    crawlMock.mockReset();
    findCrawlerById.mockReset().mockResolvedValue(null);
    findCrawlerByKey.mockReset().mockResolvedValue(crawler());
  });

  it('runs the crawler plan for exactly one page and returns its markdown', async () => {
    pages({ url: 'https://docs.example.com/a', type: 'html', title: 'A', httpStatus: 200, contentType: 'text/html', body: '# A' });
    const out = await fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/a');
    expect(out).toMatchObject({ url: 'https://docs.example.com/a', title: 'A', content: '# A', truncated: false });
    const plan = crawlMock.mock.calls[0][0];
    expect(plan).toMatchObject({ seeds: ['https://docs.example.com/a'], maxDepth: 0, maxPages: 1, autoCrawl: false, engine: 'auto' });
  });

  it('truncates to the default cap, or to the crawler maxBodyChars', async () => {
    pages({ url: 'https://docs.example.com/a', type: 'html', body: 'x'.repeat(WEB_FETCH_MAX_CHARS + 10) });
    const big = await fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/a');
    expect(big.content).toHaveLength(WEB_FETCH_MAX_CHARS);
    expect(big.truncated).toBe(true);

    findCrawlerByKey.mockResolvedValue(crawler({ markdownOptions: { maxBodyChars: 5 } }));
    pages({ url: 'https://docs.example.com/a', type: 'html', body: 'abcdefgh' });
    const small = await fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/a');
    expect(small).toMatchObject({ content: 'abcde', truncated: true });
  });

  it('surfaces an engine error page as an error', async () => {
    pages({ url: 'https://docs.example.com/a', type: 'error', errorMessage: 'HTTP 404' });
    await expect(fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/a')).rejects.toThrow('HTTP 404');
  });

  it('does not touch the engine for an out-of-scope host', async () => {
    await expect(fetchPageWithCrawler(ctx, 'docs', 'https://evil.test/')).rejects.toThrow(/outside/);
    expect(crawlMock).not.toHaveBeenCalled();
  });

  it('refuses a missing, inactive or foreign-tenant crawler', async () => {
    findCrawlerByKey.mockResolvedValue(null);
    await expect(fetchPageWithCrawler(ctx, 'nope', 'https://docs.example.com/')).rejects.toThrow(/not found/);
    findCrawlerByKey.mockResolvedValue(crawler({ status: 'paused' }));
    await expect(fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/')).rejects.toThrow(/not active/);
    findCrawlerByKey.mockResolvedValue(crawler({ tenantId: 'other' }));
    await expect(fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/')).rejects.toThrow(/not found/);
  });

  it('reports a skipped page when the engine yields nothing', async () => {
    pages();
    await expect(fetchPageWithCrawler(ctx, 'docs', 'https://docs.example.com/a')).rejects.toThrow(/skipped/);
  });
});
