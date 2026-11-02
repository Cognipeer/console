/**
 * Crawler attachments and OCR: the engine reads a downloaded file through the host's injected extractor when the
 * plan's OCR is on, and converts it exactly as before when it is off. The extraction engine itself is replaced by a
 * stub; the fetcher is mocked, so no network or OCR work is involved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosFetch, extractDocument, validateOcrModelRef, detailedSupport } = vi.hoisted(() => ({
  axiosFetch: vi.fn(),
  extractDocument: vi.fn(),
  validateOcrModelRef: vi.fn(),
  // The installed converter library: does it have the extraction API (3.6)?
  detailedSupport: { present: true },
}));

vi.mock('@/lib/services/extraction/toMarkdownApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/extraction/toMarkdownApi')>()),
  getConvertToMarkdownDetailed: () => (detailedSupport.present ? async () => ({ markdown: '' }) : undefined),
}));

vi.mock('@/lib/services/crawler/engine/axiosFetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawler/engine/axiosFetcher')>()),
  fetchWithAxios: axiosFetch,
}));
vi.mock('@/lib/services/extraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/extraction')>()),
  extractDocument,
  validateOcrModelRef,
}));

import { crawl, type CrawlEngineDeps, type CrawlPlan, type PageResult } from '@/lib/services/crawler/engine';
import { fileToMarkdown } from '@/lib/services/crawler/engine/markdown';
import {
  crawlerExtractionDeps,
  crawlerOcrProblem,
  crawlerOcrToSettings,
} from '@/lib/services/crawler/ocrExtractor';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const FILE_URL = 'https://example.com/scan.txt';

function plan(markdownOptions?: CrawlPlan['markdownOptions']): CrawlPlan {
  return {
    seeds: [FILE_URL],
    engine: 'axios',
    maxDepth: 0,
    maxPages: 0,
    autoCrawl: false,
    scope: { sameDomainOnly: true, includeSubdomains: false },
    http: { maxConcurrency: 2, retries: 1 },
    ...(markdownOptions ? { markdownOptions } : {}),
  } as CrawlPlan;
}

async function run(p: CrawlPlan, deps: Partial<CrawlEngineDeps> = {}): Promise<PageResult[]> {
  const pages: PageResult[] = [];
  for await (const page of crawl(p, { logger, ...deps })) pages.push(page);
  return pages;
}

const PDF_BYTES = Buffer.from('plain attachment text');

beforeEach(() => {
  axiosFetch.mockReset().mockResolvedValue({
    type: 'file',
    httpStatus: 200,
    contentType: 'text/plain',
    fileBuffer: PDF_BYTES,
    fileBytes: PDF_BYTES.length,
  });
  extractDocument.mockReset();
  validateOcrModelRef.mockReset();
});

describe('crawl engine — file attachments with OCR', () => {
  it('reads the file through the injected extractor when OCR is on, and cleans the result up', async () => {
    const extractFile = vi.fn(async () => '# Scan\n\n\n\n\nBody &amp; more');
    const ocr = { enabled: true, modelKey: 'ocr-1', mode: 'always' as const, languages: ['tur'] };

    const [page] = await run(plan({ ocr }), { extractFile });

    expect(extractFile).toHaveBeenCalledTimes(1);
    const input = (extractFile.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(input).toMatchObject({ fileName: expect.stringMatching(/\.txt$/), contentType: 'text/plain', ocr });
    expect(Buffer.isBuffer(input.buffer)).toBe(true);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    // finalizeBody ran over the extractor's text: entities decoded, blank-line runs collapsed.
    expect(page.type).toBe('file');
    expect(page.body).toBe('# Scan\n\nBody & more');
  });

  it('keeps the page without a body when the extractor fails or finds nothing', async () => {
    const ocr = { enabled: true };
    const failing = vi.fn(async () => {
      throw new Error('model down');
    });
    expect((await run(plan({ ocr }), { extractFile: failing }))[0].body).toBeUndefined();

    const empty = vi.fn(async () => '');
    expect((await run(plan({ ocr }), { extractFile: empty }))[0].body).toBeUndefined();
  });

  it('does not use the extractor when OCR is off or absent: the direct conversion, as before', async () => {
    const direct = (await fileToMarkdown({ buffer: PDF_BYTES, fileName: 'scan.txt' })) as string;
    const extractFile = vi.fn(async () => 'FROM EXTRACTOR');

    const without = await run(plan(), { extractFile });
    const disabled = await run(plan({ ocr: { enabled: false, modelKey: 'ocr-1' } }), { extractFile });

    expect(extractFile).not.toHaveBeenCalled();
    expect(without[0].body).toBe(direct);
    expect(disabled[0].body).toBe(direct);
  });

  it('keeps the direct conversion when OCR is on but the host injected no extractor', async () => {
    const direct = (await fileToMarkdown({ buffer: PDF_BYTES, fileName: 'scan.txt' })) as string;
    const [page] = await run(plan({ ocr: { enabled: true } }));
    expect(page.body).toBeTruthy();
    expect(page.body).toBe(direct);
  });

  it('gives an OCR conversion its own, longer time limit and aborts the work when it runs out', async () => {
    let seen: AbortSignal | undefined;
    const extractFile = vi.fn((input: { signal?: AbortSignal }) => {
      seen = input.signal;
      return new Promise<string | undefined>(() => undefined);
    });

    const [page] = await run(plan({ ocr: { enabled: true } }), { extractFile, ocrConversionTimeoutMs: 40 });

    expect(page.type).toBe('file');
    expect(page.body).toBeUndefined();
    expect(seen?.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'Attachment markdown conversion failed',
      expect.objectContaining({ error: expect.stringContaining('timed out after 40ms') }),
    );
  });

  it('aborts the extractor when the crawl is cancelled', async () => {
    const crawlAbort = new AbortController();
    let seen: AbortSignal | undefined;
    const extractFile = vi.fn((input: { signal?: AbortSignal }) => {
      seen = input.signal;
      return new Promise<string | undefined>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const pending = run(plan({ ocr: { enabled: true } }), { extractFile, signal: crawlAbort.signal });
    await vi.waitFor(() => expect(extractFile).toHaveBeenCalled());
    crawlAbort.abort();
    const [page] = await pending;

    expect(seen?.aborted).toBe(true);
    expect(page.body).toBeUndefined();
  });
});

describe('crawlerOcrToSettings', () => {
  it('is undefined when OCR is off', () => {
    expect(crawlerOcrToSettings(undefined)).toBeUndefined();
    expect(crawlerOcrToSettings({ enabled: false, modelKey: 'm' })).toBeUndefined();
  });

  it('defaults to auto mode and carries the optional fields only when set', () => {
    expect(crawlerOcrToSettings({ enabled: true })).toEqual({ mode: 'auto' });
    expect(
      crawlerOcrToSettings({
        enabled: true,
        mode: 'always',
        modelKey: ' ocr-1 ',
        maxPages: 20,
        images: true,
        languages: ['tur', 'eng', 'tr', 'not a language!', ''],
      }),
    ).toEqual({ mode: 'always', modelKey: 'ocr-1', maxPages: 20, images: true, languages: ['tr', 'en'] });
  });
});

describe('crawlerExtractionDeps', () => {
  const ctx = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };

  it('adds nothing for a plan without OCR', () => {
    expect(crawlerExtractionDeps(ctx, undefined, 'background')).toEqual({});
    expect(crawlerExtractionDeps(ctx, { ocr: { enabled: false } }, 'background')).toEqual({});
  });

  it('keeps the crawler on its direct OCR call when the converter library is too old for the engine', () => {
    detailedSupport.present = false;
    try {
      expect(crawlerExtractionDeps(ctx, { ocr: { enabled: true } }, 'background')).toEqual({});
    } finally {
      detailedSupport.present = true;
    }
  });

  it('cuts a crawler\'s language list to the limit of the shared settings', () => {
    const many = Array.from({ length: 30 }, (_, index) => `x${String.fromCharCode(97 + (index % 26))}${index < 26 ? '' : 'y'}`);
    const settings = crawlerOcrToSettings({ enabled: true, languages: many });
    expect(settings?.languages).toHaveLength(8);
  });

  it('binds the extraction engine to the crawler scope, with the budget of the caller', async () => {
    extractDocument.mockResolvedValue({ text: 'read text', raw: 'read text', report: { warnings: [] } });
    const signal = new AbortController().signal;
    const buffer = Buffer.from('%PDF');
    const background = crawlerExtractionDeps(ctx, { ocr: { enabled: true, modelKey: 'ocr-1' } }, 'background');
    const inline = crawlerExtractionDeps(ctx, { ocr: { enabled: true } }, 'inline');

    const text = await background.extractFile!({
      buffer,
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      ocr: { enabled: true, modelKey: 'ocr-1' },
      signal,
    });
    await inline.extractFile!({ buffer, fileName: 'a.pdf', ocr: { enabled: true } });

    expect(text).toBe('read text');
    expect(extractDocument).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        scope: { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' },
        source: 'crawler',
        fileName: 'a.pdf',
        data: buffer,
        contentType: 'application/pdf',
        ocr: { mode: 'auto', modelKey: 'ocr-1' },
        budget: 'background',
        signal,
      }),
    );
    expect(extractDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({ budget: 'inline', ocr: { mode: 'auto' } }));
    // The outer limit leaves room after the engine's own deadline for the native-text fallback.
    expect(background.ocrConversionTimeoutMs!).toBeGreaterThan(inline.ocrConversionTimeoutMs!);
    expect(inline.ocrConversionTimeoutMs!).toBeGreaterThan(60_000);
  });
});

describe('crawlerOcrProblem', () => {
  const ctx = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };

  it('has nothing to say about options without OCR, or OCR without a model', async () => {
    expect(await crawlerOcrProblem(ctx, undefined)).toBeUndefined();
    expect(await crawlerOcrProblem(ctx, { ocr: { enabled: false, modelKey: 'gone' } })).toBeUndefined();
    expect(await crawlerOcrProblem(ctx, { ocr: { enabled: true, languages: ['whatever you like'] } })).toBeUndefined();
    expect(validateOcrModelRef).not.toHaveBeenCalled();
  });

  it('rejects out-of-range numbers', async () => {
    expect(await crawlerOcrProblem(ctx, { ocr: { enabled: true, maxPages: 0 } })).toMatch(/^Invalid OCR options: .*maxPages/);
    expect(await crawlerOcrProblem(ctx, { ocr: { enabled: true, maxPages: 100_000 } })).toMatch(/maxPages/);
  });

  it('checks the named model against the project', async () => {
    validateOcrModelRef.mockResolvedValueOnce(undefined).mockResolvedValueOnce('Model "x" was not found in this project');

    expect(await crawlerOcrProblem(ctx, { ocr: { enabled: true, modelKey: 'ocr-1' } })).toBeUndefined();
    expect(validateOcrModelRef).toHaveBeenCalledWith(
      { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' },
      'ocr-1',
    );
    expect(await crawlerOcrProblem(ctx, { ocr: { enabled: true, modelKey: 'x' } })).toBe(
      'Invalid OCR model: Model "x" was not found in this project',
    );
  });
});
