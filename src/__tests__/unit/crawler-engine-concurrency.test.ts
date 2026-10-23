/**
 * Concurrency in the crawl engine: a sliding pool of `maxConcurrency` fetches
 * that refills as each one settles, keeps fetching while the caller is busy,
 * caps at exactly `maxPages`, and ends in-flight work when the caller stops.
 * The axios fetcher is mocked, so no network is involved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosFetch } = vi.hoisted(() => ({ axiosFetch: vi.fn() }));

vi.mock('@/lib/services/crawler/engine/axiosFetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawler/engine/axiosFetcher')>()),
  fetchWithAxios: axiosFetch,
}));

import { crawl, type CrawlPlan, type PageResult } from '@/lib/services/crawler/engine';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const PAGE = `<html><head><title>Page</title></head><body><main><p>${'Content. '.repeat(40)}</p></main></body></html>`;

const html = () => ({
  type: 'html' as const,
  httpStatus: 200,
  contentType: 'text/html',
  html: PAGE,
  htmlBytes: PAGE.length,
});

const seeds = (n: number, prefix = 'p') =>
  Array.from({ length: n }, (_, i) => `https://example.com/${prefix}${i}`);

function plan(over: Partial<CrawlPlan> & { concurrency?: number }): CrawlPlan {
  const { concurrency = 4, ...rest } = over;
  return {
    seeds: [],
    engine: 'axios',
    maxDepth: 0,
    maxPages: 0,
    autoCrawl: false,
    scope: { sameDomainOnly: true, includeSubdomains: false },
    http: { maxConcurrency: concurrency, retries: 1 },
    ...rest,
  } as CrawlPlan;
}

async function run(p: CrawlPlan): Promise<PageResult[]> {
  const pages: PageResult[] = [];
  for await (const page of crawl(p, { logger })) pages.push(page);
  return pages;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Resolves once `predicate` holds, polling on the macrotask queue. */
async function until(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  axiosFetch.mockReset();
});

describe('engine — sliding pool', () => {
  it('does not hold the other slots behind one slow URL', async () => {
    const slow = deferred();
    axiosFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/slow')) await slow.promise;
      return html();
    });

    const it = crawl(
      plan({ concurrency: 2, seeds: ['https://example.com/slow', ...seeds(3)] }),
      { logger },
    );
    // With fixed batches, /p0 shares a batch with /slow and nothing could be
    // yielded until /slow finished.
    const first = [await it.next(), await it.next(), await it.next()];
    expect(first.map((r) => (r.value as PageResult).url)).toEqual(seeds(3));

    slow.resolve();
    const last = await it.next();
    expect((last.value as PageResult).url).toBe('https://example.com/slow');
    expect((await it.next()).done).toBe(true);
  });

  it('never has more than maxConcurrency fetches in flight, and uses all of them', async () => {
    let inFlight = 0;
    let peak = 0;
    axiosFetch.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
      inFlight--;
      return html();
    });

    const pages = await run(plan({ concurrency: 3, seeds: seeds(12) }));

    expect(pages).toHaveLength(12);
    expect(peak).toBe(3);
  });

  it('keeps fetching while the caller is busy, up to its buffer cap', async () => {
    axiosFetch.mockImplementation(async () => html());

    const it = crawl(plan({ concurrency: 3, seeds: seeds(20) }), { logger });
    await it.next();
    // The caller holds on to page one. Fixed batches stopped at the first
    // three fetches here; the pool keeps going...
    await until(() => axiosFetch.mock.calls.length > 3);
    await new Promise((r) => setTimeout(r, 30));
    // ...but only until `ready` is full: the page handed out, `concurrency`
    // buffered and at most `concurrency` more in flight.
    expect(axiosFetch.mock.calls.length).toBeLessThanOrEqual(1 + 3 + 3);
    await it.return(undefined);
  });
});

describe('engine — maxPages with a pool', () => {
  it('returns exactly maxPages pages without fetching past the budget', async () => {
    axiosFetch.mockImplementation(async () => html());

    const pages = await run(plan({ concurrency: 5, maxPages: 3, seeds: seeds(10) }));

    expect(pages.filter((p) => p.type === 'html')).toHaveLength(3);
    expect(axiosFetch).toHaveBeenCalledTimes(3);
  });

  it('lets an error page hand its budget slot to the next URL', async () => {
    axiosFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/bad')) throw new Error('HTTP 404 for https://example.com/bad');
      return html();
    });

    const pages = await run(
      plan({ concurrency: 4, maxPages: 2, seeds: ['https://example.com/bad', ...seeds(4)] }),
    );

    expect(pages.filter((p) => p.type === 'html')).toHaveLength(2);
    expect(pages.filter((p) => p.type === 'error')).toHaveLength(1);
  });

  it('counts downloaded files toward maxPages', async () => {
    axiosFetch.mockImplementation(async () => ({
      type: 'file' as const,
      httpStatus: 200,
      contentType: 'application/pdf',
      fileBytes: 10,
    }));

    const pages = await run(plan({ concurrency: 4, maxPages: 2, seeds: seeds(6, 'doc') }));

    expect(pages.filter((p) => p.type === 'file')).toHaveLength(2);
  });
});

describe('engine — stopping', () => {
  it('aborts in-flight fetches when the caller stops iterating', async () => {
    const signals: AbortSignal[] = [];
    axiosFetch.mockImplementation(
      (url: string, _http: unknown, _mimes: unknown, signal: AbortSignal) => {
        if (!url.endsWith('/slow')) return Promise.resolve(html());
        signals.push(signal);
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Fetch aborted')));
        });
      },
    );

    for await (const page of crawl(
      plan({ concurrency: 2, seeds: ['https://example.com/slow', ...seeds(2)] }),
      { logger },
    )) {
      expect(page.url).toBe(seeds(1)[0]);
      break;
    }

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
  });

  it('stops scheduling once the caller aborts, still yielding what was in flight', async () => {
    const controller = new AbortController();
    axiosFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return html();
    });

    const pages: PageResult[] = [];
    for await (const page of crawl(plan({ concurrency: 2, seeds: seeds(10) }), {
      logger,
      signal: controller.signal,
    })) {
      pages.push(page);
      if (pages.length === 1) controller.abort();
    }

    expect(axiosFetch.mock.calls.length).toBeLessThan(10);
    expect(pages.length).toBeLessThan(10);
  });
});
