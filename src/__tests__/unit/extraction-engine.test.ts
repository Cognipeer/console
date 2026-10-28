/**
 * The document extraction engine (`services/extraction/engine` + `modelOcr`): the converter library is a stand-in, as
 * are the OCR model call, the quota helpers and the local engine. What is under test is the call shape the library
 * receives, what is handed to the OCR model, and what becomes of failures, deadlines and aborts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  convert: vi.fn(),
  detailed: vi.fn(),
  handleOcrRequest: vi.fn(),
  getModelByKey: vi.fn(),
  checkBudget: vi.fn(),
  settleUsageBudget: vi.fn(),
  prepare: vi.fn(),
  slot: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: hoisted.convert,
  convertToMarkdownDetailed: hoisted.detailed,
}));
vi.mock('@/lib/core/config', () => ({ getConfig: () => hoisted.config }));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));
vi.mock('@/lib/database', () => ({
  runWithTenantScope: (_tenant: string, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({ handleOcrRequest: hoisted.handleOcrRequest }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: (_pricing: unknown, usage: { pages?: number }) => ({ currency: 'USD', totalCost: (usage.pages ?? 0) * 0.01 }),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkBudget: hoisted.checkBudget,
  settleUsageBudget: hoisted.settleUsageBudget,
}));
vi.mock('@/lib/services/extraction/localOcr', () => ({
  getLocalOcrEngine: () => ({ id: 'tesseract', prepare: hoisted.prepare }),
  withLocalOcrSlot: (signal: unknown, work: () => Promise<unknown>) => hoisted.slot(signal, work),
}));

import { extractDocument } from '@/lib/services/extraction/engine';
import { MARKDOWN_OCR_PROMPT } from '@/lib/services/extraction/modelOcr';
import type { ExtractionRequest, OcrSettings } from '@/lib/services/extraction/types';
import type { DetailedConversionOptions, OcrHandler, OcrDocumentHandler } from '@/lib/services/extraction/toMarkdownApi';

const SCOPE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' };
const PDF = Buffer.from('%PDF-1.4 stand-in');

const request = (overrides: Partial<ExtractionRequest> = {}): ExtractionRequest => ({
  scope: SCOPE,
  source: 'files',
  fileName: 'scan.pdf',
  data: PDF,
  ...overrides,
});

const detailedResult = (overrides: Record<string, unknown> = {}) => ({
  markdown: '# native\n\nOCR text',
  extension: '.pdf',
  pages: [
    { page: 1, source: 'text', chars: 100 },
    { page: 2, source: 'ocr', chars: 40, reason: 'no-text' },
  ],
  warnings: [],
  stats: { pageCount: 2, ocrCalls: 1, ocrPages: 1, ocrImages: 0, ocrMs: 12, renderMs: 3 },
  ...overrides,
});

const optionsOf = (call = 0): DetailedConversionOptions => hoisted.detailed.mock.calls[call][1];

const makeModel = (overrides: Record<string, unknown> = {}) => ({
  key: 'mistral',
  category: 'ocr',
  providerDriver: 'mistral-ocr',
  providerKey: 'prov',
  modelId: 'mistral-ocr-latest',
  settings: {},
  pricing: { pagePer1K: 1 },
  ...overrides,
});

const ocrResponse = (overrides: Record<string, unknown> = {}) => ({
  response: { text: 'page text', pages: undefined, usage: { pages: 1 } },
  usage: { pages: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  model: makeModel(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.config = {};
  hoisted.convert.mockReset().mockResolvedValue('# native');
  hoisted.detailed.mockReset().mockResolvedValue(detailedResult());
  hoisted.handleOcrRequest.mockReset().mockResolvedValue(ocrResponse());
  hoisted.getModelByKey.mockReset().mockResolvedValue(makeModel());
  hoisted.checkBudget.mockReset().mockResolvedValue({ allowed: true });
  hoisted.settleUsageBudget.mockReset().mockResolvedValue(undefined);
  hoisted.slot.mockReset().mockImplementation((_signal: unknown, work: () => Promise<unknown>) => work());
  hoisted.prepare.mockReset().mockResolvedValue({
    options: { provider: 'tesseract', lang: 'tur+eng', tesseract: { langPath: '/tess', offline: true } },
    languages: ['tr', 'en'],
    warnings: [],
  });
});

describe('with OCR off', () => {
  it('makes the exact call the library has always received', async () => {
    const result = await extractDocument(request({ fileName: 'report.pdf' }));

    expect(hoisted.convert).toHaveBeenCalledTimes(1);
    expect(hoisted.convert).toHaveBeenCalledWith(PDF, { fileName: 'report.pdf' });
    expect(hoisted.detailed).not.toHaveBeenCalled();
    expect(result.text).toBe('# native');
    expect(result.raw).toBe('# native');
    expect(result.report).toEqual({ sourceType: 'converted', warnings: [] });
  });

  it.each([[undefined], [null], [{ mode: 'off' as const }]])('ignores %j', async (ocr) => {
    await extractDocument(request({ ocr }));
    expect(hoisted.convert).toHaveBeenCalledWith(PDF, { fileName: 'scan.pdf' });
    expect(hoisted.detailed).not.toHaveBeenCalled();
  });

  it('adds the images policy only when it is not inline', async () => {
    await extractDocument(request({ fileName: 'a.docx', data: Buffer.from('x'), images: 'inline' }));
    expect(hoisted.convert).toHaveBeenLastCalledWith(expect.anything(), { fileName: 'a.docx' });

    await extractDocument(request({ fileName: 'a.docx', data: Buffer.from('x'), images: 'placeholder' }));
    expect(hoisted.convert).toHaveBeenLastCalledWith(expect.anything(), { fileName: 'a.docx', images: 'placeholder' });

    await extractDocument(request({ fileName: 'a.docx', data: Buffer.from('x'), images: 'omit' }));
    expect(hoisted.convert).toHaveBeenLastCalledWith(expect.anything(), { fileName: 'a.docx', images: 'omit' });
    expect(hoisted.detailed).not.toHaveBeenCalled();
  });

  it('does not use OCR for a file it does not apply to, even when it is on', async () => {
    await extractDocument(request({ fileName: 'sheet.xlsx', data: Buffer.from('x'), ocr: { mode: 'always' } }));
    await extractDocument(request({ fileName: 'a.docx', data: Buffer.from('x'), ocr: { mode: 'auto' } }));

    expect(hoisted.detailed).not.toHaveBeenCalled();
    expect(hoisted.convert).toHaveBeenCalledTimes(2);
  });

  it('accepts what a test double or an older build answers: a string or an object that carries the text', async () => {
    hoisted.convert.mockResolvedValueOnce({ markdown: '# from object' });
    expect((await extractDocument(request())).text).toBe('# from object');
  });
});

describe('with OCR on and the local engine', () => {
  it('maps auto mode and the settings to the library options', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    await extractDocument(
      request({ ocr: { mode: 'auto', maxPages: 7, languages: ['tr'] }, signal: controller.signal, onProgress, budget: 'background' }),
    );

    expect(hoisted.convert).not.toHaveBeenCalled();
    expect(hoisted.prepare).toHaveBeenCalledWith(['tr']);
    const options = optionsOf();
    expect(options.fileName).toBe('scan.pdf');
    expect(options).not.toHaveProperty('images');
    expect(options.ocr).toMatchObject({
      provider: 'tesseract',
      lang: 'tur+eng',
      tesseract: { langPath: '/tess', offline: true },
      pdfMode: 'auto-page',
      maxPages: 7,
      concurrency: 1,
      timeoutMs: 180_000,
      onError: 'skip',
    });
    expect(options.ocr).not.toHaveProperty('embeddedImages');
    expect(options.ocr?.signal).toBeInstanceOf(AbortSignal);
    expect(options.ocr?.signal?.aborted).toBe(false);

    options.ocr?.onProgress?.({ kind: 'pdf-page', completed: 1, total: 4, page: 1 });
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 4 });
  });

  it('maps always mode, the default page limit, the images switch and the images policy', async () => {
    await extractDocument(request({ ocr: { mode: 'always', images: true }, images: 'placeholder' }));

    const options = optionsOf();
    expect(options.images).toBe('placeholder');
    expect(options.ocr).toMatchObject({
      pdfMode: 'always',
      maxPages: 100,
      embeddedImages: { minWidth: 64, minHeight: 64, maxImages: 30 },
    });
  });

  it('does not pass the images policy when it is inline, and sends the default languages', async () => {
    await extractDocument(request({ ocr: { mode: 'auto' }, images: 'inline' }));
    expect(optionsOf()).not.toHaveProperty('images');
    expect(hoisted.prepare).toHaveBeenCalledWith(['tr', 'en']);
  });

  it('caps the page limit at the configured hard limit and uses the configured concurrency', async () => {
    hoisted.config = { ocr: { maxPagesLimit: 30, maxPages: 10, localConcurrency: 2 } };
    await extractDocument(request({ ocr: { mode: 'auto', maxPages: 500 } }));
    expect(optionsOf().ocr).toMatchObject({ maxPages: 30, concurrency: 2 });
  });

  it('keeps the warnings of the engine and of the library, and reports what was read', async () => {
    hoisted.prepare.mockResolvedValue({
      options: { provider: 'tesseract', lang: 'eng', tesseract: { langPath: '/tess', offline: true } },
      languages: ['en'],
      warnings: ['ocr_language_unavailable: xx'],
    });
    hoisted.detailed.mockResolvedValue(detailedResult({ warnings: ['ocr_page_failed: page 3: boom'] }));

    const result = await extractDocument(request({ ocr: { mode: 'auto' } }));

    expect(result.text).toBe('# native\n\nOCR text');
    expect(result.report).toEqual({
      sourceType: 'mixed',
      engine: 'local',
      pageCount: 2,
      ocrPages: [2],
      ocrCalls: 1,
      ocrMs: 12,
      warnings: ['ocr_language_unavailable: xx', 'ocr_page_failed: page 3: boom'],
    });
  });

  it('reports a fully scanned document, a document without OCR and an image file', async () => {
    hoisted.detailed.mockResolvedValueOnce(
      detailedResult({ pages: [{ page: 1, source: 'ocr', chars: 5 }, { page: 2, source: 'ocr', chars: 5 }] }),
    );
    expect((await extractDocument(request({ ocr: { mode: 'always' } }))).report.sourceType).toBe('ocr');

    hoisted.detailed.mockResolvedValueOnce(
      detailedResult({ pages: [{ page: 1, source: 'text', chars: 90 }], stats: { pageCount: 1, ocrCalls: 0, ocrPages: 0, ocrImages: 0, ocrMs: 0, renderMs: 0 } }),
    );
    const native = await extractDocument(request({ ocr: { mode: 'auto' } }));
    expect(native.report).toEqual({ sourceType: 'converted', pageCount: 1, warnings: [] });

    hoisted.detailed.mockResolvedValueOnce(
      detailedResult({ extension: '.png', pages: undefined, stats: { ocrCalls: 1, ocrPages: 0, ocrImages: 1, ocrMs: 9, renderMs: 0 } }),
    );
    const image = await extractDocument(request({ fileName: 'photo.png', ocr: { mode: 'auto' } }));
    expect(image.report).toMatchObject({ sourceType: 'ocr', engine: 'local', ocrImages: 1 });
  });

  it('keeps the native text when the local engine has nothing to read with', async () => {
    hoisted.prepare.mockRejectedValue(new Error('no language data'));

    const result = await extractDocument(request({ ocr: { mode: 'auto' } }));

    expect(hoisted.detailed).not.toHaveBeenCalled();
    expect(hoisted.convert).toHaveBeenCalledWith(PDF, { fileName: 'scan.pdf' });
    expect(result.report.warnings).toEqual(['ocr_unavailable: no language data']);
  });

  it('keeps the native text when OCR fails, and says so', async () => {
    hoisted.detailed.mockRejectedValue(new Error('PDF OCR failed: boom'));

    const result = await extractDocument(request({ ocr: { mode: 'auto' } }));

    expect(hoisted.convert).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('# native');
    expect(result.report).toEqual({ sourceType: 'converted', warnings: ['ocr_failed: PDF OCR failed: boom'] });
  });

  it('reads the library without OCR support as a plain conversion with a warning', async () => {
    vi.resetModules();
    vi.doMock('@cognipeer/to-markdown', () => ({ convertToMarkdown: hoisted.convert }));
    const { extractDocument: extractWithOldLibrary } = await import('@/lib/services/extraction/engine');

    const result = await extractWithOldLibrary(request({ ocr: { mode: 'auto' } }));

    expect(hoisted.convert).toHaveBeenCalledWith(PDF, { fileName: 'scan.pdf' });
    expect(hoisted.detailed).not.toHaveBeenCalled();
    expect(result.text).toBe('# native');
    expect(result.report.sourceType).toBe('converted');
    expect(result.report.warnings).toEqual([expect.stringMatching(/^ocr_unavailable:/)]);
    vi.doUnmock('@cognipeer/to-markdown');
  });
});

describe('with OCR on and a project model', () => {
  const ocr: OcrSettings = { mode: 'auto', modelKey: 'mistral', languages: ['tr', 'en'] };

  it('hands the library a handler that calls the model with the project, attribution and resilience', async () => {
    hoisted.getModelByKey.mockResolvedValue(makeModel({ category: 'llm', isMultimodal: true, providerDriver: 'openai' }));
    await extractDocument(request({ ocr }));

    expect(hoisted.getModelByKey).toHaveBeenCalledWith('tenant_acme', 'mistral', 'proj-1');
    const options = optionsOf().ocr!;
    expect(options.provider).toBe('handler');
    expect(options).not.toHaveProperty('documentHandler');
    expect(options).toMatchObject({ pdfMode: 'auto-page', concurrency: 4 });

    const image = Buffer.from('png-bytes');
    const out = await (options.handler as OcrHandler)(image, { page: 2, mimeType: 'image/png' });

    expect(out).toEqual({ text: 'page text' });
    expect(hoisted.handleOcrRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.handleOcrRequest).toHaveBeenCalledWith({
      tenantDbName: 'tenant_acme',
      modelKey: 'mistral',
      projectId: 'proj-1',
      input: {
        document: { kind: 'bytes', data: image, contentType: 'image/png', fileName: 'scan.pdf' },
        language: 'tr',
        prompt: MARKDOWN_OCR_PROMPT,
      },
      allowVisionLlm: true,
      attribution: { userId: 'user-1', projectId: 'proj-1' },
      resilience: { timeoutMs: 180_000, retry: { maxAttempts: 2 } },
      logErrors: true,
      // The text of a page never goes to the usage log; the call stops with the document.
      logContent: false,
      signal: expect.any(AbortSignal),
    });
  });

  it('settles the realized cost after each call, under the ocr domain', async () => {
    await extractDocument(request({ ocr }));
    await (optionsOf().ocr!.handler as OcrHandler)(Buffer.from('x'), {});

    expect(hoisted.checkBudget).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'ocr', resourceKey: 'mistral', tenantDbName: 'tenant_acme', projectId: 'proj-1' }),
    );
    expect(hoisted.settleUsageBudget).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'ocr', resourceKey: 'mistral' }),
      { currency: 'USD', totalCost: 0.01 },
    );
  });

  it('does not override the prompt of a model that has its own, nor send one to a native driver', async () => {
    hoisted.getModelByKey.mockResolvedValue(
      makeModel({ category: 'ocr', providerDriver: 'openai', settings: { ocr: { mode: 'vlm', prompt: 'Read it my way' } } }),
    );
    await extractDocument(request({ ocr }));
    await (optionsOf().ocr!.handler as OcrHandler)(Buffer.from('x'), {});
    expect(hoisted.handleOcrRequest.mock.calls[0][0].input).not.toHaveProperty('prompt');

    hoisted.handleOcrRequest.mockClear();
    hoisted.getModelByKey.mockResolvedValue(makeModel({ providerDriver: 'aws-textract' }));
    await extractDocument(request({ ocr }));
    await (optionsOf(1).ocr!.handler as OcrHandler)(Buffer.from('x'), {});
    expect(hoisted.handleOcrRequest.mock.calls[0][0].input).not.toHaveProperty('prompt');
  });

  it('gives document-level drivers a handler that reads the selected pages in one call', async () => {
    hoisted.handleOcrRequest.mockResolvedValue(
      ocrResponse({
        response: {
          text: 'a\n\nb',
          pages: [{ pageNumber: 2, text: 'second' }, { pageNumber: 5, text: 'fifth' }],
          usage: { pages: 2 },
        },
      }),
    );
    await extractDocument(request({ ocr, budget: 'background' }));

    const options = optionsOf().ocr!;
    expect(options.documentHandler).toBeTypeOf('function');
    const pages = await (options.documentHandler as OcrDocumentHandler)(PDF, { pages: [2, 5], pageCount: 9, fileName: 'scan.pdf' });

    expect(pages).toEqual([{ page: 2, text: 'second' }, { page: 5, text: 'fifth' }]);
    expect(hoisted.handleOcrRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { document: { kind: 'bytes', data: PDF, contentType: 'application/pdf', fileName: 'scan.pdf' }, pages: [2, 5], language: 'tr' },
        resilience: { timeoutMs: 900_000, retry: { enabled: false } },
        logErrors: true,
      }),
    );
  });

  it('numbers the pages of a document-level answer that carries no page numbers', async () => {
    hoisted.handleOcrRequest.mockResolvedValue(
      ocrResponse({ response: { text: 'only', pages: [{ text: 'x' }, { text: 'y' }], usage: {} } }),
    );
    await extractDocument(request({ ocr }));
    const pages = await (optionsOf().ocr!.documentHandler as OcrDocumentHandler)(PDF, { pages: [3, 4], pageCount: 4 });
    expect(pages).toEqual([{ page: 3, text: 'x' }, { page: 4, text: 'y' }]);
  });

  it('keeps the native text when the budget is used up, without calling the model', async () => {
    hoisted.checkBudget.mockResolvedValue({ allowed: false, reason: 'Daily budget exceeded' });

    const result = await extractDocument(request({ ocr }));

    expect(hoisted.detailed).not.toHaveBeenCalled();
    expect(hoisted.handleOcrRequest).not.toHaveBeenCalled();
    expect(hoisted.convert).toHaveBeenCalledWith(PDF, { fileName: 'scan.pdf' });
    expect(result.report).toEqual({ sourceType: 'converted', warnings: ['ocr_budget_exceeded: Daily budget exceeded'] });
  });

  it('keeps the native text when the model is missing or cannot read documents', async () => {
    hoisted.getModelByKey.mockResolvedValueOnce(null);
    const missing = await extractDocument(request({ ocr }));
    expect(missing.report.warnings).toEqual([expect.stringMatching(/^ocr_model_unavailable: .*not found/)]);

    hoisted.getModelByKey.mockResolvedValueOnce(makeModel({ category: 'llm', isMultimodal: false }));
    const plainLlm = await extractDocument(request({ ocr }));
    expect(plainLlm.report.warnings).toEqual([expect.stringMatching(/^ocr_model_unavailable: .*vision/)]);

    expect(hoisted.detailed).not.toHaveBeenCalled();
    expect(hoisted.convert).toHaveBeenCalledTimes(2);
  });

  it('needs a project to use a model', async () => {
    const result = await extractDocument(request({ ocr, scope: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1' } }));
    expect(result.report.warnings).toEqual([expect.stringMatching(/^ocr_model_unavailable: .*project/)]);
  });
});

describe('deadline and abort', () => {
  /** A library that never answers until its signal aborts, as a hung OCR provider would. */
  const hangUntilAborted = () =>
    hoisted.detailed.mockImplementation(
      (_buffer: Buffer, options: DetailedConversionOptions) =>
        new Promise((_resolve, reject) => {
          options.ocr!.signal!.addEventListener('abort', () => reject(options.ocr!.signal!.reason), { once: true });
        }),
    );

  it('re-reads the document without OCR when the deadline is reached', async () => {
    hoisted.config = { ocr: { inlineTimeoutMs: 20 } };
    hangUntilAborted();

    const result = await extractDocument(request({ ocr: { mode: 'auto' }, images: 'placeholder' }));

    expect(hoisted.convert).toHaveBeenCalledTimes(1);
    expect(hoisted.convert).toHaveBeenCalledWith(PDF, { fileName: 'scan.pdf', images: 'placeholder' });
    expect(result.text).toBe('# native');
    expect(result.report.sourceType).toBe('converted');
    expect(result.report.warnings).toEqual([expect.stringMatching(/^ocr_timeout:/)]);
  });

  it('uses the longer document budget for a background job', async () => {
    hoisted.config = { ocr: { inlineTimeoutMs: 10, documentTimeoutMs: 60_000 } };
    let seen: AbortSignal | undefined;
    hoisted.detailed.mockImplementation(async (_buffer: Buffer, options: DetailedConversionOptions) => {
      seen = options.ocr!.signal;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return detailedResult();
    });

    const result = await extractDocument(request({ ocr: { mode: 'auto' }, budget: 'background' }));

    expect(seen?.aborted).toBe(false);
    expect(result.report.sourceType).toBe('mixed');
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it('propagates an abort by the caller as an AbortError and does not read the document again', async () => {
    const controller = new AbortController();
    hangUntilAborted();

    const pending = extractDocument(request({ ocr: { mode: 'auto' }, signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it('does not start when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(extractDocument(request({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(hoisted.convert).not.toHaveBeenCalled();
    expect(hoisted.detailed).not.toHaveBeenCalled();
  });
});

describe('the local OCR slot', () => {
  it('starts the document clock when the slot is granted, not while the document waits for it', async () => {
    hoisted.config = { ocr: { inlineTimeoutMs: 120 } };
    hoisted.slot.mockImplementation(async (_signal: unknown, work: () => Promise<unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return work();
    });
    hoisted.detailed.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return detailedResult();
    });

    const result = await extractDocument(request({ ocr: { mode: 'auto' } }));

    expect(result.report.sourceType).toBe('mixed');
    expect(result.report.warnings).toEqual([]);
    expect(hoisted.convert).not.toHaveBeenCalled();
  });

  it('keeps the native text with an ocr_busy warning when no slot becomes free in time', async () => {
    hoisted.config = { ocr: { inlineTimeoutMs: 20 } };
    hoisted.slot.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );

    const result = await extractDocument(request({ ocr: { mode: 'auto' } }));

    expect(hoisted.detailed).not.toHaveBeenCalled();
    expect(hoisted.convert).toHaveBeenCalledTimes(1);
    expect(result.report.warnings).toEqual(['ocr_busy']);
  });
});

describe('model calls and the end of a document', () => {
  const ocr: OcrSettings = { mode: 'auto', modelKey: 'mistral' };

  it('stops a call in flight when the library aborts it, without a retry or a booked cost', async () => {
    await extractDocument(request({ ocr }));
    hoisted.handleOcrRequest.mockImplementation(
      (params: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          params.signal.addEventListener('abort', () => reject(params.signal.reason), { once: true });
        }),
    );
    const controller = new AbortController();

    const call = (optionsOf().ocr!.handler as OcrHandler)(Buffer.from('x'), { signal: controller.signal });
    controller.abort();

    await expect(call).rejects.toBeDefined();
    expect(hoisted.handleOcrRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.settleUsageBudget).not.toHaveBeenCalled();
  });

  it('stops reading pages when the budget runs out during the document, and says so', async () => {
    hoisted.checkBudget.mockReset().mockResolvedValueOnce({ allowed: true }).mockResolvedValue({ allowed: false, reason: 'daily cap' });
    let failures = 0;
    hoisted.detailed.mockImplementation(async (_buffer: Buffer, options: DetailedConversionOptions) => {
      for (let page = 1; page <= 8; page += 1) {
        try {
          await (options.ocr!.handler as OcrHandler)(Buffer.from('x'), { page });
        } catch {
          failures += 1;
        }
      }
      return detailedResult();
    });

    const result = await extractDocument(request({ ocr }));

    // The budget is read again after every fifth call; the pages after that are not sent.
    expect(hoisted.handleOcrRequest).toHaveBeenCalledTimes(5);
    expect(failures).toBe(3);
    expect(result.report.warnings).toContain('ocr_budget_exceeded: daily cap');
  });
});

