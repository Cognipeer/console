/**
 * The Document Store's extraction settings (`files/markdownExtraction`): what is kept of a request's settings, what a
 * run adds to the record, how the body of an upload is read, and the heartbeat of a long run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compactExtraction,
  extractionWithResult,
  HEARTBEAT_INTERVAL_MS,
  parseExtractionBody,
  startHeartbeat,
} from '@/lib/services/files/markdownExtraction';

const SCOPE = { tenantDbName: 'db', tenantId: 't', projectId: 'p' };

describe('compactExtraction', () => {
  it('keeps OCR only when it is on, and pictures only when they are not kept inline', () => {
    expect(compactExtraction({ ocr: { mode: 'auto', languages: ['tr'] }, images: 'placeholder' })).toEqual({ ocr: { mode: 'auto', languages: ['tr'] }, images: 'placeholder' });
    expect(compactExtraction({ ocr: { mode: 'off' }, images: 'inline' })).toBeUndefined();
    expect(compactExtraction({ images: 'omit' })).toEqual({ images: 'omit' });
  });

  it('has nothing for nothing', () => {
    expect(compactExtraction(undefined)).toBeUndefined();
    expect(compactExtraction(null)).toBeUndefined();
    expect(compactExtraction({})).toBeUndefined();
    expect(compactExtraction({ ocr: null, images: null })).toBeUndefined();
  });
});

describe('extractionWithResult', () => {
  const report = {
    sourceType: 'ocr' as const, engine: 'model' as const, modelKey: 'm1', pageCount: 3, ocrPages: [1, 2, 3], ocrImages: 2, ocrCalls: 5, ocrMs: 900,
    warnings: ['ocr_timeout: slow'],
  };

  it('adds the result next to the settings: counts instead of lists, no timings', () => {
    expect(extractionWithResult({ ocr: { mode: 'always', modelKey: 'm1' } }, report)).toEqual({
      ocr: { mode: 'always', modelKey: 'm1' },
      result: { sourceType: 'ocr', engine: 'model', modelKey: 'm1', pageCount: 3, ocrPages: 3, ocrImages: 2, warnings: ['ocr_timeout: slow'] },
    });
  });

  it('drops the result of an earlier run and writes none when OCR is not on', () => {
    expect(extractionWithResult({ ocr: { mode: 'auto' }, result: { sourceType: 'mixed' } }, { sourceType: 'converted', warnings: [] })).toEqual({
      ocr: { mode: 'auto' },
      result: { sourceType: 'converted' },
    });
    expect(extractionWithResult({ images: 'omit', result: { sourceType: 'mixed' } }, report)).toEqual({ images: 'omit' });
  });

  it('is nothing for a file without settings', () => {
    expect(extractionWithResult(undefined, report)).toBeUndefined();
    expect(extractionWithResult(null, report)).toBeUndefined();
  });

  it('keeps a bounded number of short warnings', () => {
    const many = Array.from({ length: 50 }, (_v, i) => `w${i}: ${'x'.repeat(1000)}`);

    const kept = extractionWithResult({ ocr: { mode: 'auto' } }, { sourceType: 'converted', warnings: many })!.result!.warnings!;

    expect(kept).toHaveLength(20);
    expect(kept.every((w) => w.length <= 303)).toBe(true);
  });
});

describe('parseExtractionBody', () => {
  const validate = vi.fn();
  beforeEach(() => {
    validate.mockReset();
  });

  it('says nothing was given when the body names neither field', async () => {
    expect(await parseExtractionBody({ fileName: 'a.pdf' }, SCOPE)).toEqual({ extraction: undefined, present: false });
  });

  it('is present but empty for ocr: null and for OCR that is off (they replace what a file has)', async () => {
    expect(await parseExtractionBody({ ocr: null }, SCOPE)).toEqual({ extraction: undefined, present: true });
    expect(await parseExtractionBody({ ocr: { mode: 'off' } }, SCOPE)).toEqual({ extraction: undefined, present: true });
    expect(await parseExtractionBody({ images: null }, SCOPE)).toEqual({ extraction: undefined, present: true });
  });

  it('reads the settings and the picture policy', async () => {
    expect(await parseExtractionBody({ ocr: { mode: 'auto', maxPages: 5, images: true }, images: 'placeholder' }, SCOPE)).toEqual({
      extraction: { ocr: { mode: 'auto', maxPages: 5, images: true }, images: 'placeholder' },
      present: true,
    });
  });

  it('reports a malformed setting as a sentence', async () => {
    expect(await parseExtractionBody({ ocr: 7 }, SCOPE)).toEqual({ error: 'ocr must be an object' });
    expect(await parseExtractionBody({ images: 'big' }, SCOPE)).toEqual({ error: "images must be one of 'inline', 'placeholder', 'omit'" });
  });

  it('does not look at a model when OCR has none', async () => {
    const result = await parseExtractionBody({ ocr: { mode: 'auto' } }, SCOPE);

    expect('error' in result).toBe(false);
  });
});

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('touches the record at most once per interval, however often progress is reported', () => {
    const touch = vi.fn().mockResolvedValue(undefined);
    const heartbeat = startHeartbeat(touch);

    for (let i = 0; i < 10; i += 1) heartbeat.beat();
    expect(touch).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + HEARTBEAT_INTERVAL_MS + 1);
    heartbeat.beat();
    heartbeat.beat();
    expect(touch).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  it('keeps the record alive on its own while a single call reports no progress, and stops when told', async () => {
    const touch = vi.fn().mockResolvedValue(undefined);
    const heartbeat = startHeartbeat(touch);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 100);
    expect(touch).toHaveBeenCalledTimes(2);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it('does not fail a run because a touch failed', async () => {
    const touch = vi.fn().mockRejectedValue(new Error('db down'));
    const heartbeat = startHeartbeat(touch);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 100);

    expect(touch).toHaveBeenCalled();
    heartbeat.stop();
  });
});
