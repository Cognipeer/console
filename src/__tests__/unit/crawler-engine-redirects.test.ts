/**
 * Redirect handling in the crawl engine: landing-URL dedup inside one batch and
 * the browser fallback's choice of URL. Both fetchers are mocked, so no network
 * or browser is involved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosFetch, pwFetch } = vi.hoisted(() => ({
  axiosFetch: vi.fn(),
  pwFetch: vi.fn(),
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

import { crawl, type CrawlPlan, type PageResult } from '@/lib/services/crawler/engine';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const REAL_PAGE = `<html><head><title>Real</title></head><body><main><h1>Real page</h1><p>${'Genuine content paragraph. '.repeat(30)}</p></main></body></html>`;
// Matches BOT_CHALLENGE_PATTERNS, so looksLikeJsShell() flags it.
const CHALLENGE_PAGE = '<html><body>Just a moment... checking your browser</body></html>';

const html = (body: string, finalUrl?: string) => ({
  type: 'html' as const,
  httpStatus: 200,
  contentType: 'text/html',
  html: body,
  htmlBytes: body.length,
  finalUrl,
});

function plan(over: Partial<CrawlPlan>): CrawlPlan {
  return {
    seeds: [],
    engine: 'axios',
    maxDepth: 0,
    maxPages: 0,
    autoCrawl: false,
    scope: { sameDomainOnly: true, includeSubdomains: false },
    http: { maxConcurrency: 4, retries: 1 },
    ...over,
  } as CrawlPlan;
}

async function run(p: CrawlPlan, signal?: AbortSignal): Promise<PageResult[]> {
  const pages: PageResult[] = [];
  for await (const page of crawl(p, { logger, signal })) pages.push(page);
  return pages;
}

beforeEach(() => {
  axiosFetch.mockReset();
  pwFetch.mockReset();
});

describe('engine — landing URL dedup', () => {
  it('yields one page when an alias and its redirect target are in the same batch', async () => {
    axiosFetch.mockImplementation(async (url: string) =>
      url.endsWith('/old') ? html(REAL_PAGE, 'https://example.com/new') : html(REAL_PAGE),
    );

    const pages = await run(
      plan({ seeds: ['https://example.com/old', 'https://example.com/new'] }),
    );

    expect(pages.filter((p) => p.type === 'html')).toHaveLength(1);
  });

  it('does not let the dropped duplicate count toward maxPages', async () => {
    axiosFetch.mockImplementation(async (url: string) =>
      url.endsWith('/old') ? html(REAL_PAGE, 'https://example.com/new') : html(REAL_PAGE),
    );

    const pages = await run(
      plan({
        seeds: ['https://example.com/old', 'https://example.com/new', 'https://example.com/other'],
        maxPages: 2,
      }),
    );

    // /old and /new collapse into one page, so the second slot goes to /other.
    expect(pages.map((p) => p.url).sort()).toEqual([
      'https://example.com/old',
      'https://example.com/other',
    ].sort());
  });
});

describe('engine — browser fallback target', () => {
  const challenged = () => axiosFetch.mockResolvedValue(html(CHALLENGE_PAGE, 'https://example.com/app'));

  it('navigates straight to the redirect target when that works', async () => {
    challenged();
    pwFetch.mockResolvedValue(html(REAL_PAGE));

    const [page] = await run(plan({ engine: 'auto', seeds: ['https://example.com/start'] }));

    expect(pwFetch.mock.calls.map((c) => c[0])).toEqual(['https://example.com/app']);
    expect(page.type).toBe('html');
    expect(page.url).toBe('https://example.com/start');
  });

  it('retries the original URL when the direct target is still a challenge', async () => {
    challenged();
    pwFetch.mockImplementation(async (url: string) =>
      url.endsWith('/app') ? html(CHALLENGE_PAGE) : html(REAL_PAGE, 'https://example.com/app'),
    );

    const [page] = await run(plan({ engine: 'auto', seeds: ['https://example.com/start'] }));

    expect(pwFetch.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/app',
      'https://example.com/start',
    ]);
    expect(page.type).toBe('html');
    expect(page.body).toContain('Real page');
  });

  it('retries the original URL when the direct navigation throws', async () => {
    challenged();
    pwFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/app')) throw new Error('HTTP 403');
      return html(REAL_PAGE);
    });

    const [page] = await run(plan({ engine: 'auto', seeds: ['https://example.com/start'] }));

    expect(pwFetch.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/app',
      'https://example.com/start',
    ]);
    expect(page.type).toBe('html');
  });

  it('reports an error page when both attempts stay challenged', async () => {
    challenged();
    pwFetch.mockResolvedValue(html(CHALLENGE_PAGE));

    const [page] = await run(plan({ engine: 'auto', seeds: ['https://example.com/start'] }));

    expect(page.type).toBe('error');
    expect(page.errorMessage).toMatch(/still looks JS-rendered or bot-challenged/);
  });
});

describe('engine — connection reset on the first engine', () => {
  it('cools down, then hands the host to the browser', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const events: string[] = [];
    axiosFetch.mockImplementation(async () => {
      events.push('axios');
      throw new Error('Axios error for https://example.com/: read ECONNRESET');
    });
    pwFetch.mockImplementation(async () => {
      events.push('browser');
      return html(REAL_PAGE);
    });

    const pending = run(plan({ engine: 'auto', seeds: ['https://example.com/'], http: { retries: 3 } as never }));
    // axios attempts at t=0, +2s, +8s (2s then 6s backoff) …
    await vi.advanceTimersByTimeAsync(7999);
    expect(events).toEqual(['axios', 'axios']);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['axios', 'axios', 'axios']);
    // … then a 3s cool-down before the browser is tried.
    await vi.advanceTimersByTimeAsync(2999);
    expect(events).not.toContain('browser');
    await vi.advanceTimersByTimeAsync(1);
    const pages = await pending;

    expect(events).toEqual(['axios', 'axios', 'axios', 'browser']);
    expect(pages[0].type).toBe('html');
    vi.useRealTimers();
  });

  it('cancelling during the cool-down never starts the browser', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    axiosFetch.mockRejectedValue(new Error('Axios error for https://example.com/: read ECONNRESET'));
    pwFetch.mockResolvedValue(html(REAL_PAGE));
    const ctrl = new AbortController();

    const pending = run(
      plan({ engine: 'auto', seeds: ['https://example.com/'], http: { retries: 3 } as never }),
      ctrl.signal,
    );
    await vi.advanceTimersByTimeAsync(8000); // axios attempts 1-3 done, now in the ~3s cool-down
    expect(axiosFetch).toHaveBeenCalledTimes(3);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    expect(pwFetch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancelling during an axios backoff stops further attempts immediately', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    axiosFetch.mockRejectedValue(new Error('Axios error for https://example.com/: read ECONNRESET'));
    const ctrl = new AbortController();

    const pending = run(
      plan({ engine: 'axios', seeds: ['https://example.com/'], http: { retries: 4 } as never }),
      ctrl.signal,
    );
    await vi.advanceTimersByTimeAsync(2000); // attempt 2 started; inside the 6s backoff
    expect(axiosFetch).toHaveBeenCalledTimes(2);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    expect(axiosFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

