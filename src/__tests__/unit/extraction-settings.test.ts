/**
 * OCR settings (`services/extraction/settings`): what a submitted setting may hold, which layer wins, which files OCR
 * applies to, and the tunables read from the configuration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock('@/lib/core/config', () => ({ getConfig: () => hoisted.config }));

import {
  effectiveOcr,
  isImageFile,
  isOcrActive,
  isOcrCandidate,
  normalizeOcrSettings,
  ocrDefaults,
  ocrLanguages,
  toIsoLanguage,
  toTesseractLanguage,
} from '@/lib/services/extraction/settings';

beforeEach(() => {
  hoisted.config = {};
});

describe('normalizeOcrSettings', () => {
  it('clears with null and reports nothing for undefined', () => {
    expect(normalizeOcrSettings(null)).toEqual({ value: null });
    expect(normalizeOcrSettings(undefined)).toEqual({});
  });

  it('accepts a minimal setting and returns it compact', () => {
    expect(normalizeOcrSettings({ mode: 'auto' })).toEqual({ value: { mode: 'auto' } });
    const { value } = normalizeOcrSettings({ mode: 'always', modelKey: null, languages: undefined, maxPages: undefined });
    expect(value).toEqual({ mode: 'always' });
    expect(Object.keys(value as object)).toEqual(['mode']);
  });

  it('keeps every field of a full setting', () => {
    expect(
      normalizeOcrSettings({ mode: 'auto', modelKey: ' mistral-ocr ', languages: ['tr', 'en'], maxPages: 20, images: true }),
    ).toEqual({ value: { mode: 'auto', modelKey: 'mistral-ocr', languages: ['tr', 'en'], maxPages: 20, images: true } });
  });

  it('treats an empty model key as the local engine', () => {
    expect(normalizeOcrSettings({ mode: 'auto', modelKey: '  ' })).toEqual({ value: { mode: 'auto' } });
  });

  it('lowercases languages, maps tesseract codes to ISO and removes duplicates', () => {
    expect(normalizeOcrSettings({ mode: 'auto', languages: ['TR', 'tur', 'eng', 'en', 'pt_BR'] }).value?.languages).toEqual([
      'tr',
      'en',
      'pt_br',
    ]);
  });

  it.each([
    [{}, /mode/],
    [{ mode: 'sometimes' }, /mode/],
    [{ mode: 1 }, /mode/],
    [{ mode: 'auto', modelKey: 5 }, /modelKey must be a string/],
    [{ mode: 'auto', modelKey: 'x'.repeat(121) }, /at most 120/],
    [{ mode: 'auto', languages: 'tr' }, /array/],
    [{ mode: 'auto', languages: ['t'] }, /invalid language/],
    [{ mode: 'auto', languages: ['tr!'] }, /invalid language/],
    [{ mode: 'auto', languages: [5] }, /invalid language/],
    [{ mode: 'auto', languages: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii'] }, /at most 8/],
    [{ mode: 'auto', maxPages: 0 }, /maxPages/],
    [{ mode: 'auto', maxPages: 1.5 }, /maxPages/],
    [{ mode: 'auto', maxPages: '10' }, /maxPages/],
    [{ mode: 'auto', maxPages: 501 }, /between 1 and 500/],
    [{ mode: 'auto', images: 'yes' }, /images must be a boolean/],
    [{ mode: 'auto', engine: 'x' }, /ocr\.engine is not a known setting/],
    ['auto', /object/],
    [[], /object/],
  ])('rejects %j', (input, message) => {
    const result = normalizeOcrSettings(input);
    expect(result.value).toBeUndefined();
    expect(result.error).toMatch(message);
  });

  it('takes the page limit from the configuration', () => {
    hoisted.config = { ocr: { maxPagesLimit: 50 } };
    expect(normalizeOcrSettings({ mode: 'auto', maxPages: 50 }).value?.maxPages).toBe(50);
    expect(normalizeOcrSettings({ mode: 'auto', maxPages: 51 }).error).toMatch(/between 1 and 50/);
  });
});

describe('isOcrActive and effectiveOcr', () => {
  it('is active for auto and always only', () => {
    expect(isOcrActive({ mode: 'auto' })).toBe(true);
    expect(isOcrActive({ mode: 'always' })).toBe(true);
    expect(isOcrActive({ mode: 'off' })).toBe(false);
    expect(isOcrActive(null)).toBe(false);
    expect(isOcrActive(undefined)).toBe(false);
  });

  it('takes the first layer that is not undefined, and null switches OCR off explicitly', () => {
    const request = { mode: 'always' } as const;
    const fromModule = { mode: 'auto' } as const;
    expect(effectiveOcr(request, fromModule)).toBe(request);
    expect(effectiveOcr(undefined, fromModule)).toBe(fromModule);
    expect(effectiveOcr(null, fromModule)).toBeNull();
    expect(effectiveOcr(undefined, undefined)).toBeUndefined();
    expect(effectiveOcr()).toBeUndefined();
  });
});

describe('isOcrCandidate', () => {
  const on = { mode: 'auto' } as const;

  it.each(['scan.pdf', 'SCAN.PDF', 'photo.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.tif', 'a.tiff'])(
    'is a candidate when OCR is on: %s',
    (name) => {
      expect(isOcrCandidate(name, undefined, on)).toBe(true);
    },
  );

  it('is never a candidate when OCR is off or absent', () => {
    expect(isOcrCandidate('scan.pdf', undefined, { mode: 'off' })).toBe(false);
    expect(isOcrCandidate('scan.pdf', undefined, null)).toBe(false);
    expect(isOcrCandidate('scan.pdf', undefined, undefined)).toBe(false);
  });

  it('recognises a PDF or an image by its content type when the name says nothing', () => {
    expect(isOcrCandidate('upload', 'application/pdf', on)).toBe(true);
    expect(isOcrCandidate('upload', 'application/pdf; charset=binary', on)).toBe(true);
    expect(isOcrCandidate('upload', 'image/png', on)).toBe(true);
    expect(isOcrCandidate('upload', 'text/plain', on)).toBe(false);
  });

  it('reads Word and PowerPoint files only when images are asked for', () => {
    expect(isOcrCandidate('a.docx', undefined, on)).toBe(false);
    expect(isOcrCandidate('a.docx', undefined, { mode: 'auto', images: true })).toBe(true);
    expect(isOcrCandidate('a.pptx', undefined, { mode: 'auto', images: true })).toBe(true);
    expect(isOcrCandidate('a.xlsx', undefined, { mode: 'auto', images: true })).toBe(false);
    expect(isOcrCandidate('a.txt', undefined, { mode: 'auto', images: true })).toBe(false);
  });

  it('isImageFile tells images from the rest', () => {
    expect(isImageFile('a.TIFF')).toBe(true);
    expect(isImageFile('a.pdf')).toBe(false);
    expect(isImageFile('a', 'image/jpeg')).toBe(true);
  });
});

describe('languages', () => {
  it('maps between ISO and tesseract codes', () => {
    expect(toTesseractLanguage('tr')).toBe('tur');
    expect(toTesseractLanguage('EN')).toBe('eng');
    expect(toTesseractLanguage('xx')).toBe('xx');
    expect(toIsoLanguage('tur')).toBe('tr');
    expect(toIsoLanguage('Eng')).toBe('en');
  });

  it('uses the settings languages, else the configured default', () => {
    expect(ocrLanguages({ mode: 'auto', languages: ['de'] })).toEqual(['de']);
    expect(ocrLanguages({ mode: 'auto' })).toEqual(['tr', 'en']);
    expect(ocrLanguages(undefined)).toEqual(['tr', 'en']);
    hoisted.config = { ocr: { defaultLanguages: ['fr'] } };
    expect(ocrLanguages({ mode: 'auto' })).toEqual(['fr']);
  });
});

describe('ocrDefaults', () => {
  it('has the documented defaults when the configuration has no ocr block', () => {
    expect(ocrDefaults()).toEqual({
      languages: ['tr', 'en'],
      maxPages: 100,
      maxPagesLimit: 500,
      modelConcurrency: 4,
      localConcurrency: 1,
      localMaxDocs: 1,
      callTimeoutMs: 180_000,
      documentTimeoutMs: 900_000,
      inlineTimeoutMs: 120_000,
      tessdataDir: '',
    });
  });

  it('reads the configured values, ignores invalid ones and caps maxPages at the limit', () => {
    hoisted.config = {
      ocr: {
        defaultLanguages: [],
        maxPages: 900,
        maxPagesLimit: 200,
        modelConcurrency: 0,
        localConcurrency: 3,
        callTimeoutMs: 'soon',
        tessdataDir: '/data/tess',
      },
    };
    expect(ocrDefaults()).toMatchObject({
      languages: ['tr', 'en'],
      maxPages: 200,
      maxPagesLimit: 200,
      modelConcurrency: 4,
      localConcurrency: 3,
      callTimeoutMs: 180_000,
      tessdataDir: '/data/tess',
    });
  });

  it('survives a configuration that cannot be read', () => {
    hoisted.config = new Proxy({}, { get: () => { throw new Error('no config'); } });
    expect(ocrDefaults().maxPages).toBe(100);
  });
});
