/**
 * Unit tests — VLM OCR runtime: output limit per page and attempts per page.
 *
 * Covers the explicit `max_tokens` a page is sent with (the model maximum up to the non-streaming default cap; none
 * when the maximum is unknown; a configured limit that is already as large left alone), the one retry of a page cut
 * off at the limit with twice the limit (capped at the model maximum, summed usage, kept page when the retry cannot be
 * made) and the `truncated` mark a page that stays cut off carries, and the retry budget: the provider SDK's own
 * retries are off, transient failures are retried per page, and a page that ran out of attempts fails the extraction
 * with a verdict that keeps an outer retry from re-reading the pages already done. The per-page attempts leave the
 * circuit breaker alone (its state is process-wide and this layer has no tenant to scope it by).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  renderPdf: vi.fn(),
}));

const gateway = {
  requestTimeoutMs: 5_000,
  retryEnabled: true,
  retryMaxAttempts: 3,
  retryInitialDelayMs: 1,
  circuitBreakerEnabled: false,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 1_000,
};

vi.mock('@/lib/core/config', () => ({
  getConfig: () => ({ gateway }),
}));
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: vi.fn() }));
vi.mock('@/lib/providers/contracts/pdfRender', () => ({
  looksLikePdf: (input: { contentType?: string }) => input.contentType === 'application/pdf',
  renderPdfToPngDataUrls: h.renderPdf,
}));

import { createVlmOcrRuntime } from '@/lib/providers/contracts/vlmOcrHelpers';
import { NON_STREAM_DEFAULT_CAP } from '@/lib/services/models/outputLimits';
import { getAllCircuitStates, isRetryable, resetAllCircuits } from '@/lib/core/resilience';
import type { ModelProviderRuntime, ModelRuntimeConfig } from '@/lib/providers/domains/model';

const usage = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedInputTokens: 0,
  cachedWriteTokens: 0,
  cachedOutputTokens: 0,
  reasoningTokens: 0,
});

function reply(content: string, finishReason = 'stop', u = usage(30, 12)) {
  return { id: 'r', model: 'm', content, toolCalls: [], usage: u, finishReason, raw: { ok: true } };
}

const CLAUDE = 'claude-sonnet-5-5'; // 128000 in the built-in table
const IMAGE = { document: { kind: 'bytes', data: Buffer.from('AAAA'), contentType: 'image/png' } } as never;
const PDF = { document: { kind: 'bytes', data: Buffer.from('%PDF'), contentType: 'application/pdf' } } as never;

function config(overrides: Partial<ModelRuntimeConfig> = {}): ModelRuntimeConfig {
  return { modelId: 'gpt-4o', category: 'ocr', ...overrides };
}

function setup(modelConfig: ModelRuntimeConfig) {
  const complete = vi.fn();
  const createNativeChatClient = vi.fn().mockResolvedValue({ complete });
  const runtime: ModelProviderRuntime = { createNativeChatClient };
  return { complete, createNativeChatClient, ocr: createVlmOcrRuntime(runtime, modelConfig) };
}

/** `max_tokens` of the n-th provider call. */
function maxTokensOf(complete: ReturnType<typeof vi.fn>, n: number): unknown {
  return complete.mock.calls[n][0].maxTokens;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllCircuits();
  h.renderPdf.mockResolvedValue({
    dataUrls: ['data:image/png;base64,AAA1', 'data:image/png;base64,AAA2', 'data:image/png;base64,AAA3'],
    totalPages: 3,
    truncated: false,
  });
});

describe('VLM OCR — attempts', () => {
  it('turns the provider SDK retries off and keeps the other options', async () => {
    const { complete, createNativeChatClient, ocr } = setup(
      config({ options: { disableStreaming: true, maxRetries: 5 } }),
    );
    complete.mockResolvedValue(reply('{"text":"hello"}'));
    await ocr.extract(IMAGE);

    expect(createNativeChatClient.mock.calls[0][0].options).toEqual({ disableStreaming: true, maxRetries: 0 });
  });

  it('gives each attempt its own abort signal', async () => {
    const { complete, ocr } = setup(config());
    complete.mockResolvedValue(reply('{"text":"hello"}'));
    await ocr.extract(IMAGE);

    expect(complete.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a transient failure of a page, not the document', async () => {
    const { complete, createNativeChatClient, ocr } = setup(config());
    complete
      .mockResolvedValueOnce(reply('{"text":"page one"}'))
      .mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))
      .mockResolvedValueOnce(reply('{"text":"page two"}'))
      .mockResolvedValueOnce(reply('{"text":"page three"}'));

    const result = await ocr.extract(PDF);

    // 3 pages + the one retried attempt; page one was read once.
    expect(complete).toHaveBeenCalledTimes(4);
    expect(result.text).toBe('page one\n\npage two\n\npage three');
    expect(result.pages?.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(createNativeChatClient).toHaveBeenCalledTimes(1);
  });

  it('fails with a verdict that keeps an outer retry from re-reading the finished pages, once the attempts are spent', async () => {
    const { complete, ocr } = setup(config());
    complete
      .mockResolvedValueOnce(reply('{"text":"page one"}'))
      .mockRejectedValue(Object.assign(new Error('Service unavailable'), { status: 503 }));

    const error = await ocr.extract(PDF).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Service unavailable');
    // Page one once, then page two's three attempts.
    expect(complete).toHaveBeenCalledTimes(4);
    expect((error as { retryable?: boolean }).retryable).toBe(false);
    expect(isRetryable(error)).toBe(false);
  });

  it('does not retry a request the provider refused for good', async () => {
    const { complete, ocr } = setup(config());
    complete.mockRejectedValue(Object.assign(new Error('Invalid API key'), { status: 401 }));

    await expect(ocr.extract(IMAGE)).rejects.toThrow('Invalid API key');
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps its attempts out of the circuit breaker: a name shared by every tenant would fail them all', async () => {
    gateway.circuitBreakerEnabled = true;
    gateway.circuitBreakerThreshold = 1;
    try {
      const { complete, ocr } = setup(config());
      complete.mockRejectedValue(Object.assign(new Error('Service unavailable'), { status: 503 }));
      await expect(ocr.extract(IMAGE)).rejects.toThrow('Service unavailable');

      // Nothing was recorded under a key of this layer, so no circuit can be open for the next reader.
      expect([...getAllCircuitStates().keys()].filter((key) => key.startsWith('vlm-ocr:'))).toEqual([]);
      complete.mockResolvedValue(reply('{"text":"hello"}'));
      await expect(ocr.extract(IMAGE)).resolves.toMatchObject({ text: 'hello' });
    } finally {
      gateway.circuitBreakerEnabled = false;
      gateway.circuitBreakerThreshold = 5;
    }
  });
});

describe('VLM OCR — output limit of a page', () => {
  it('asks a model with a known maximum for it, up to the non-streaming default cap', async () => {
    const { complete, ocr } = setup(config({ modelId: CLAUDE }));
    complete.mockResolvedValue(reply('{"text":"hello"}'));
    await ocr.extract(IMAGE);

    expect(maxTokensOf(complete, 0)).toBe(NON_STREAM_DEFAULT_CAP);
  });

  it('a declared maximum below the cap is the limit', async () => {
    const { complete, ocr } = setup(config({ modelSettings: { maxOutputTokens: 4000 } }));
    complete.mockResolvedValue(reply('{"text":"hello"}'));
    await ocr.extract(IMAGE);

    expect(maxTokensOf(complete, 0)).toBe(4000);
  });

  it('sends nothing when the maximum is unknown: the model record own limit applies', async () => {
    const { complete, ocr } = setup(config());
    complete.mockResolvedValue(reply('{"text":"hello"}'));
    await ocr.extract(IMAGE);

    expect(complete.mock.calls[0][0]).not.toHaveProperty('maxTokens');
  });

  it('leaves a configured limit that is already as large alone, and raises a smaller one', async () => {
    const large = setup(config({ modelId: CLAUDE, modelSettings: { maxTokens: 30000 } }));
    large.complete.mockResolvedValue(reply('{"text":"hello"}'));
    await large.ocr.extract(IMAGE);
    expect(large.complete.mock.calls[0][0]).not.toHaveProperty('maxTokens');

    const small = setup(config({ modelId: CLAUDE, modelSettings: { maxTokens: 1024 } }));
    small.complete.mockResolvedValue(reply('{"text":"hello"}'));
    await small.ocr.extract(IMAGE);
    expect(maxTokensOf(small.complete, 0)).toBe(NON_STREAM_DEFAULT_CAP);
  });
});

describe('VLM OCR — a page cut off at the output limit', () => {
  it('is asked for again once with twice the limit; the retry is the page, usage of both is summed', async () => {
    const { complete, ocr } = setup(config({ modelId: CLAUDE }));
    complete
      .mockResolvedValueOnce(reply('{"text":"partial pa', 'length', usage(30, 12)))
      .mockResolvedValueOnce(reply('{"text":"the whole page"}', 'stop', usage(40, 20)));

    const result = await ocr.extract(IMAGE);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(maxTokensOf(complete, 0)).toBe(NON_STREAM_DEFAULT_CAP);
    expect(maxTokensOf(complete, 1)).toBe(NON_STREAM_DEFAULT_CAP * 2);
    expect(result.text).toBe('the whole page');
    // A clean read: no page carries a mark.
    expect(result.pages).toBeUndefined();
    expect(result.usage).toMatchObject({ inputTokens: 70, outputTokens: 32, totalTokens: 102 });
  });

  it('never asks for more than the model maximum', async () => {
    const { complete, ocr } = setup(config({ modelSettings: { maxOutputTokens: 30000 } }));
    complete
      .mockResolvedValueOnce(reply('cut', 'length'))
      .mockResolvedValueOnce(reply('{"text":"whole"}'));

    await ocr.extract(IMAGE);

    expect(maxTokensOf(complete, 0)).toBe(NON_STREAM_DEFAULT_CAP);
    expect(maxTokensOf(complete, 1)).toBe(30000);
  });

  it('is not asked for again when it already ran at the model maximum: it comes back truncated', async () => {
    const { complete, ocr } = setup(config({ modelSettings: { maxOutputTokens: 8000 } }));
    complete.mockResolvedValue(reply('{"text":"partial pa', 'length'));

    const result = await ocr.extract(IMAGE);

    expect(complete).toHaveBeenCalledTimes(1);
    // The text is what the model got out before the cut; the page says it is not complete.
    expect(result.text).toBe('{"text":"partial pa');
    expect(result.pages).toEqual([{ pageNumber: 1, text: '{"text":"partial pa', truncated: true }]);
  });

  it('comes back truncated when the larger retry is cut off too', async () => {
    const { complete, ocr } = setup(config({ modelId: CLAUDE }));
    complete
      .mockResolvedValueOnce(reply('first cut', 'length', usage(30, 12)))
      .mockResolvedValueOnce(reply('second, longer cut', 'length', usage(30, 24)));

    const result = await ocr.extract(IMAGE);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('second, longer cut');
    expect(result.pages).toEqual([{ pageNumber: 1, text: 'second, longer cut', truncated: true }]);
    expect(result.usage).toMatchObject({ outputTokens: 36 });
  });

  it('marks the pages a reply named when the whole image was cut off', async () => {
    const { complete, ocr } = setup(config({ modelSettings: { maxOutputTokens: 8000 } }));
    complete.mockResolvedValue(
      reply('{"text":"a b","pages":[{"pageNumber":1,"text":"a"},{"pageNumber":2,"text":"b"}]}', 'length'),
    );

    const result = await ocr.extract(IMAGE);

    expect(result.pages).toEqual([
      { pageNumber: 1, text: 'a', truncated: true },
      { pageNumber: 2, text: 'b', truncated: true },
    ]);
  });

  it('keeps the cut-off page when the larger limit is refused', async () => {
    const { complete, ocr } = setup(config({ modelId: CLAUDE }));
    complete
      .mockResolvedValueOnce(reply('cut text', 'length', usage(30, 12)))
      .mockRejectedValueOnce(Object.assign(new Error('max_tokens: 42666 > 32000'), { status: 400 }));

    const result = await ocr.extract(IMAGE);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('cut text');
    expect(result.pages).toEqual([{ pageNumber: 1, text: 'cut text', truncated: true }]);
    // Only the call that answered was billed.
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 12 });
  });

  it('with no maximum known, doubles the limit the model ran under (what it wrote before the cut)', async () => {
    const { complete, ocr } = setup(config());
    complete
      .mockResolvedValueOnce(reply('cut', 'length', usage(30, 1024)))
      .mockResolvedValueOnce(reply('{"text":"whole"}'));

    await ocr.extract(IMAGE);

    expect(complete.mock.calls[0][0]).not.toHaveProperty('maxTokens');
    expect(maxTokensOf(complete, 1)).toBe(2048);
  });

  it('cannot size a retry from a response that reports no output tokens: the page comes back truncated', async () => {
    const { complete, ocr } = setup(config());
    complete.mockResolvedValue(reply('cut', 'length', usage(30, 0)));

    const result = await ocr.extract(IMAGE);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.pages).toEqual([{ pageNumber: 1, text: 'cut', truncated: true }]);
  });

  it('marks only the pages of a document that stayed cut off', async () => {
    const { complete, ocr } = setup(config({ modelId: CLAUDE }));
    complete
      .mockResolvedValueOnce(reply('{"text":"page one"}'))
      .mockResolvedValueOnce(reply('page two, cut', 'length'))
      .mockResolvedValueOnce(reply('page two, cut again', 'length'))
      .mockResolvedValueOnce(reply('{"text":"page three"}'));

    const result = await ocr.extract(PDF);

    expect(complete).toHaveBeenCalledTimes(4);
    expect(result.pages).toEqual([
      { pageNumber: 1, text: 'page one' },
      { pageNumber: 2, text: 'page two, cut again', truncated: true },
      { pageNumber: 3, text: 'page three' },
    ]);
    expect(result.pages?.[0]).not.toHaveProperty('truncated');
  });
});
