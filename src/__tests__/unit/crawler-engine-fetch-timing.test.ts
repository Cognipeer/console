/**
 * Every page the engine yields says which engine produced it (`engine`) and how
 * long the fetch took (`fetchMs`). Both fetchers and the markdown converter are
 * mocked, so no network or browser is involved and the delays are the test's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosFetch, pwFetch, toMarkdown } = vi.hoisted(() => ({
  axiosFetch: vi.fn(),
  pwFetch: vi.fn(),
  toMarkdown: { delayMs: 0 },
}));

vi.mock('@/lib/services/crawler/engine/axiosFetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawler/engine/axiosFetcher')>()),
  fetchWithAxios: axiosFetch,
}));

vi.mock('@/lib/services/crawler/engine/playwrightFetcher', () => ({
  PlaywrightSession: class {
    fetch = pwFetch;
    close = async () => undefined;
  },
}));

vi.mock('@/lib/services/crawler/engine/markdown', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawler/engine/markdown')>()),
  htmlToMarkdown: async () => {
    await sleep(toMarkdown.delayMs);
    return '# page';
  },
  fileToMarkdown: async () => {
    await sleep(toMarkdown.delayMs);
    return 'file text';
  },
}));

import { crawl, type CrawlPlan, type PageResult } from '@/lib/services/crawler/engine';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const REAL_PAGE = `<html><head><title>Real</title></head><body><main><h1>Real page</h1><p>${'Genuine content paragraph. '.repeat(30)}</p></main></body></html>`;
// Matches BOT_CHALLENGE_PATTERNS, so looksLikeJsShell() flags it.
const CHALLENGE_PAGE = '<html><body>Just a moment... checking your browser</body></html>';

const html = (body: string) => ({
  type: 'html' as const,
  httpStatus: 200,
  contentType: 'text/html',
  html: body,
  htmlBytes: body.length,
});

const pdf = {
  type: 'file' as const,
  httpStatus: 200,
  contentType: 'application/pdf',
  fileBytes: 4,
  fileBuffer: Buffer.from('%PDF'),
};

/** Resolves after `ms`, like a request that takes that long. */
const after = <T>(ms: number, value: T) => async () => {
  await sleep(ms);
  return value;
};
const failsAfter = (ms: number, message: string) => async () => {
  await sleep(ms);
  throw new Error(message);
};

function plan(over: Partial<CrawlPlan>): CrawlPlan {
  return {
    seeds: ['https://example.com/'],
    engine: 'axios',
    maxDepth: 0,
    maxPages: 0,
    autoCrawl: false,
    scope: { sameDomainOnly: true, includeSubdomains: false },
    // One attempt per engine: no retry backoff in these timings.
    http: { maxConcurrency: 4, retries: 1 },
    ...over,
  } as CrawlPlan;
}

async function run(p: CrawlPlan): Promise<PageResult[]> {
  const pages: PageResult[] = [];
  for await (const page of crawl(p, { logger })) pages.push(page);
  return pages;
}

beforeEach(() => {
  axiosFetch.mockReset();
  pwFetch.mockReset();
  toMarkdown.delayMs = 0;
});

describe('engine — which engine produced the page', () => {
  it('reports axios for an axios crawl', async () => {
    axiosFetch.mockImplementation(after(5, html(REAL_PAGE)));

    const [page] = await run(plan({ engine: 'axios' }));

    expect(page).toMatchObject({ type: 'html', engine: 'axios' });
  });

  it('reports playwright for a playwright crawl', async () => {
    pwFetch.mockImplementation(after(5, html(REAL_PAGE)));

    const [page] = await run(plan({ engine: 'playwright' }));

    expect(page).toMatchObject({ type: 'html', engine: 'playwright' });
    expect(axiosFetch).not.toHaveBeenCalled();
  });

  it('reports axios in auto mode when axios answers', async () => {
    axiosFetch.mockImplementation(after(5, html(REAL_PAGE)));

    const [page] = await run(plan({ engine: 'auto' }));

    expect(page).toMatchObject({ type: 'html', engine: 'axios' });
    expect(pwFetch).not.toHaveBeenCalled();
  });

  it('reports playwright, not auto, when axios fails and the browser answers', async () => {
    axiosFetch.mockImplementation(failsAfter(5, 'connect ECONNREFUSED'));
    pwFetch.mockImplementation(after(5, html(REAL_PAGE)));

    const [page] = await run(plan({ engine: 'auto' }));

    expect(page).toMatchObject({ type: 'html', engine: 'playwright' });
  });

  it('reports playwright when axios returned a JS shell the browser then rendered', async () => {
    axiosFetch.mockImplementation(after(5, html(CHALLENGE_PAGE)));
    pwFetch.mockImplementation(after(5, html(REAL_PAGE)));

    const [page] = await run(plan({ engine: 'auto' }));

    expect(page).toMatchObject({ type: 'html', engine: 'playwright' });
  });

  it('reports the engine for attachments, including the browser download fallback', async () => {
    axiosFetch.mockImplementation(after(5, pdf));
    const [viaAxios] = await run(plan({ engine: 'auto', seeds: ['https://example.com/a.pdf'] }));
    expect(viaAxios).toMatchObject({ type: 'file', engine: 'axios' });

    axiosFetch.mockReset();
    axiosFetch.mockImplementation(failsAfter(5, 'unable to verify the first certificate'));
    pwFetch.mockImplementation(after(5, pdf));
    const [viaBrowser] = await run(plan({ engine: 'auto', seeds: ['https://example.com/b.pdf'] }));
    expect(viaBrowser).toMatchObject({ type: 'file', engine: 'playwright' });
  });
});

describe('engine — fetch time', () => {
  it('measures the fetch', async () => {
    axiosFetch.mockImplementation(after(40, html(REAL_PAGE)));

    const [page] = await run(plan({ engine: 'axios' }));

    expect(page!.fetchMs).toBeGreaterThanOrEqual(30);
    expect(page!.fetchMs).toBeLessThan(2000);
  });

  it('counts a failed axios attempt toward a page the browser finally served', async () => {
    axiosFetch.mockImplementation(failsAfter(40, 'connect ECONNREFUSED'));
    pwFetch.mockImplementation(after(40, html(REAL_PAGE)));

    const [page] = await run(plan({ engine: 'auto' }));

    // Both attempts, not just the browser's 40 ms.
    expect(page!.fetchMs).toBeGreaterThanOrEqual(70);
  });

  it('leaves markdown conversion out of it', async () => {
    axiosFetch.mockImplementation(after(10, html(REAL_PAGE)));
    toMarkdown.delayMs = 300;

    const started = Date.now();
    const [page] = await run(plan({ engine: 'axios' }));
    const wallMs = Date.now() - started;

    // Conversion took 300 ms of the wall time, yet the fetch was a few ms.
    expect(wallMs).toBeGreaterThanOrEqual(290);
    expect(page!.fetchMs).toBeLessThan(200);
  });

  it('leaves attachment conversion out of it too', async () => {
    axiosFetch.mockImplementation(after(10, pdf));
    toMarkdown.delayMs = 300;

    const [page] = await run(plan({ engine: 'axios', seeds: ['https://example.com/a.pdf'] }));

    expect(page).toMatchObject({ type: 'file', body: 'file text' });
    expect(page!.fetchMs).toBeLessThan(200);
  });
});

describe('engine — error pages', () => {
  it('records how long the fetch ran before it gave up, and no engine', async () => {
    axiosFetch.mockImplementation(failsAfter(40, 'connect ECONNREFUSED'));
    pwFetch.mockImplementation(failsAfter(40, 'page.goto: net::ERR_TIMED_OUT'));

    const [page] = await run(plan({ engine: 'auto' }));

    expect(page).toMatchObject({ type: 'error' });
    expect(page!.errorMessage).toContain('All engines failed');
    expect(page!.fetchMs).toBeGreaterThanOrEqual(70);
    expect(page!.engine).toBeUndefined();
  });

  it('records no fetch time for a URL rejected before any request', async () => {
    const [page] = await run(
      plan({ engine: 'auto', seeds: ['http://127.0.0.1:9/'], http: { maxConcurrency: 4, retries: 1 } }),
    );

    expect(page).toMatchObject({ type: 'error' });
    expect(page!.fetchMs).toBeUndefined();
    expect(page!.engine).toBeUndefined();
    expect(axiosFetch).not.toHaveBeenCalled();
    expect(pwFetch).not.toHaveBeenCalled();
  });
});
