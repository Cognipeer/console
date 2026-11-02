/**
 * The shared OCR settings form (components/extraction): its pure rules, the fields in English and Turkish, the crawler's
 * way between its stored option and the form, the Knowledge Engine section, and the strings.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import OcrSettingsFields from '@/components/extraction/OcrSettingsFields';
import ExtractionFields from '@/components/rag/ExtractionFields';
import { englishOcrText } from '@/components/extraction/ocrEnglish';
import {
  cleanLanguages,
  compactOcr,
  describeOcr,
  invalidLanguages,
  missingOcrModel,
  modelChoices,
  NO_OCR_MODELS,
  ocrIsOn,
  ocrModeOf,
  ocrResultLabel,
  patchOcr,
  sameOcr,
  type OcrModelOptions,
} from '@/components/extraction/ocrForm';
import { crawlerOcrToSettings, settingsToCrawlerOcr } from '@/components/crawler/crawlerOcr';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const models: OcrModelOptions = {
  ocr: [{ value: 'doc-ocr', label: 'Document OCR' }],
  vision: [{ value: 'vision', label: 'Vision LLM' }],
  loading: false,
  failed: false,
};

describe('the OCR value', () => {
  it('is on only for auto and every page; absent, null and off are all off', () => {
    expect(ocrIsOn(undefined)).toBe(false);
    expect(ocrIsOn(null)).toBe(false);
    expect(ocrIsOn({ mode: 'off' })).toBe(false);
    expect(ocrIsOn({ mode: 'auto' })).toBe(true);
    expect(ocrIsOn({ mode: 'always' })).toBe(true);
    expect(ocrModeOf({ mode: 'off', modelKey: 'x' })).toBe('off');
    expect(ocrModeOf({ mode: 'always' })).toBe('always');
  });

  it('keeps only what was set: no undefined keys, nothing at all when off', () => {
    expect(compactOcr(undefined)).toBeUndefined();
    expect(compactOcr({ mode: 'off', modelKey: 'x' })).toBeUndefined();
    const value = compactOcr({ mode: 'auto', modelKey: '  ', languages: [], maxPages: undefined, images: false });
    expect(value).toEqual({ mode: 'auto' });
    expect(Object.keys(value!)).toEqual(['mode']);
    expect(compactOcr({ mode: 'always', modelKey: ' m ', languages: [' TR ', 'tr', 'en'], maxPages: 12.9, images: true }))
      .toEqual({ mode: 'always', modelKey: 'm', languages: ['tr', 'en'], maxPages: 12, images: true });
    expect(compactOcr({ mode: 'auto', maxPages: 0 })).toEqual({ mode: 'auto' });
  });

  it('merges an edit: a key set to undefined goes, switching on starts from the patch, off clears all', () => {
    expect(patchOcr(undefined, { mode: 'auto' })).toEqual({ mode: 'auto' });
    expect(patchOcr({ mode: 'auto', modelKey: 'm', maxPages: 5 }, { modelKey: undefined })).toEqual({ mode: 'auto', maxPages: 5 });
    expect(patchOcr({ mode: 'auto', modelKey: 'm' }, { mode: 'always' })).toEqual({ mode: 'always', modelKey: 'm' });
    expect(patchOcr(undefined, { maxPages: 5 })).toBeUndefined();
    expect(patchOcr({ mode: 'auto' }, { mode: 'off' })).toBeUndefined();
  });

  it('compares values by meaning', () => {
    expect(sameOcr(undefined, { mode: 'off' })).toBe(true);
    expect(sameOcr({ mode: 'auto', languages: ['tr'] }, { mode: 'auto', languages: ['TR'] })).toBe(true);
    expect(sameOcr({ mode: 'auto' }, { mode: 'always' })).toBe(false);
  });

  it('normalises and checks the language codes the API takes', () => {
    expect(cleanLanguages([' TR', 'en ', '', 'tr'])).toEqual(['tr', 'en']);
    expect(invalidLanguages(['tr', 'eng', 'zh_cn'])).toEqual([]);
    expect(invalidLanguages(['t', 'turkish', 'a b'])).toEqual(['t', 'turkish', 'a b']);
    expect(invalidLanguages(undefined)).toEqual([]);
  });
});

describe('the model choices', () => {
  it('lists OCR models as they are and keeps only the multimodal chat models', () => {
    const rows = [{ key: 'a', name: 'A', isMultimodal: true }, { key: 'b', name: 'B' }, { key: '', name: 'empty' }, { name: 'nokey' }, { key: 'c' }];
    expect(modelChoices(rows, false).map((c) => c.value)).toEqual(['a', 'b', 'c']);
    expect(modelChoices(rows, true).map((c) => c.value)).toEqual(['a']);
    expect(modelChoices(rows, false)[2]).toEqual({ value: 'c', label: 'c' });
    expect(modelChoices(undefined, true)).toEqual([]);
  });

  it('finds a model that is named but not available — only once the lists are known', () => {
    expect(missingOcrModel({ mode: 'auto', modelKey: 'gone' }, models)).toBe('gone');
    expect(missingOcrModel({ mode: 'auto', modelKey: 'vision' }, models)).toBeUndefined();
    expect(missingOcrModel({ mode: 'auto' }, models)).toBeUndefined();
    expect(missingOcrModel({ mode: 'off', modelKey: 'gone' }, models)).toBeUndefined();
    expect(missingOcrModel({ mode: 'auto', modelKey: 'gone' }, { ...models, loading: true })).toBeUndefined();
    expect(missingOcrModel({ mode: 'auto', modelKey: 'gone' }, { ...models, failed: true })).toBeUndefined();
    expect(missingOcrModel({ mode: 'auto', modelKey: 'gone' }, NO_OCR_MODELS)).toBe('gone');
  });
});

describe('the one-line summary and the result badge', () => {
  it('describes the setting in the translator it is given', () => {
    expect(describeOcr(englishOcrText, undefined)).toBe('Off');
    expect(describeOcr(englishOcrText, { mode: 'auto' })).toBe('Auto · Local engine · tr, en');
    expect(describeOcr(englishOcrText, { mode: 'always', modelKey: 'doc-ocr', languages: ['de'], images: true }, models))
      .toBe('Every page · Document OCR · de · with images');
    expect(describeOcr(englishOcrText, { mode: 'auto', modelKey: 'unlisted' })).toBe('Auto · unlisted · tr, en');
  });

  it('labels a run by the pages it read, and says nothing for a plain one', () => {
    const label = (result: Parameters<typeof ocrResultLabel>[1]) => ocrResultLabel(englishOcrText, result);
    expect(label(undefined)).toBeUndefined();
    expect(label({ sourceType: 'converted', pageCount: 3 })).toBeUndefined();
    expect(label({ sourceType: 'mixed', ocrPages: 2, pageCount: 6 })).toBe('OCR · 2/6 pages');
    expect(label({ sourceType: 'ocr', ocrPages: 6, pageCount: 6 })).toBe('OCR · 6 pages');
    expect(label({ sourceType: 'ocr', ocrPages: 1 })).toBe('OCR · 1 page');
    expect(label({ sourceType: 'mixed', ocrImages: 3 })).toBe('OCR · images');
    // An image file read whole carries no page count.
    expect(label({ sourceType: 'ocr' })).toBe('OCR · images');
    expect(label({ sourceType: 'mixed' })).toBeUndefined();
  });
});

describe('OcrSettingsFields', () => {
  const fields = (props: Record<string, unknown>, locale: 'en' | 'tr' = 'en') =>
    render(h(OcrSettingsFields, { value: undefined, onChange: noop, models, ...props }), locale);

  it('shows only the mode while OCR is off', () => {
    for (const value of [undefined, null, { mode: 'off' as const }]) {
      const html = fields({ value });
      expect(html).toContain('Read scanned pages (OCR)');
      for (const label of ['Off', 'Auto (scanned pages only)', 'Every page']) expect(html).toContain(label);
      expect(html).not.toContain('Engine');
      expect(html).not.toContain('Maximum pages per document');
    }
  });

  it('shows the engine, languages (default tr, en) and page cap once it is on', () => {
    const html = fields({ value: { mode: 'auto' } });
    for (const text of ['Engine', 'Local engine (CPU, Tesseract)', 'Languages', 'Maximum pages per document', 'Pages that already have text are kept as they are']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('>tr<');
    expect(html).toContain('>en<');
    expect(html).not.toContain('Also read images');
    expect(fields({ value: { mode: 'always' } })).toContain('Every page is read as a picture');
  });

  it('offers “Also read images” only where the consumer asks for it, and shows the stored values', () => {
    const html = fields({ value: { mode: 'auto', modelKey: 'doc-ocr', languages: ['de'], maxPages: 30, images: true }, showImages: true });
    expect(html).toContain('Also read images');
    expect(html).toContain('value="Document OCR"');
    expect(html).toContain('>de<');
    expect(html).toContain('value="30"');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
  });

  it('says so when the chosen model is not in the project, and keeps showing the stored key', () => {
    const html = fields({ value: { mode: 'auto', modelKey: 'gone' } });
    expect(html).toContain('The model “gone” is not in this project or cannot read documents.');
    expect(html).toContain('value="gone"');
    // An error the host knows better wins over the check.
    expect(fields({ value: { mode: 'auto', modelKey: 'doc-ocr' }, modelError: 'Pick another.' })).toContain('Pick another.');
    // Nothing is claimed while the lists are still loading.
    expect(fields({ value: { mode: 'auto', modelKey: 'gone' }, models: { ...models, loading: true } })).not.toContain('is not in this project');
  });

  it('flags language codes the API would refuse', () => {
    expect(fields({ value: { mode: 'auto', languages: ['tr', 'turkish'] } })).toContain('Use language codes such as tr, en or de: “turkish”.');
  });

  it('can be disabled', () => {
    const html = fields({ value: { mode: 'auto' }, disabled: true, showImages: true });
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(3);
    expect(radios.every((tag) => tag.includes('disabled'))).toBe(true);
    expect(fields({ value: { mode: 'auto' } }).match(/<input[^>]*type="radio"[^>]*>/g)!.some((tag) => tag.includes('disabled'))).toBe(false);
  });

  it('speaks Turkish, or English whatever the language is for the pages written in English', () => {
    const turkish = fields({ value: { mode: 'auto' }, showImages: true }, 'tr');
    for (const text of ['Taranmış sayfaları oku (OCR)', 'Motor', 'Yerel motor (CPU, Tesseract)', 'Diller', 'Belge başına en çok sayfa', 'Resimleri de oku']) {
      expect(turkish).toContain(text);
    }
    const literal = fields({ value: { mode: 'auto' }, english: true }, 'tr');
    expect(literal).toContain('Read scanned pages (OCR)');
    expect(literal).not.toContain('Taranmış');
  });
});

describe('the Knowledge Engine section', () => {
  it('is the shared fields in English with the note about what a change reaches', () => {
    const html = render(h(ExtractionFields, { value: { mode: 'auto' }, onChange: noop }), 'tr');
    expect(html).toContain('Read scanned pages (OCR)');
    expect(html).not.toContain('Taranmış');
    expect(html).toContain('Applies to files uploaded from now on.');
    expect(html).toContain('Re-extract');
  });
});

describe('the crawler’s stored option', () => {
  it('shows an enabled option in the fields, and nothing for an off or absent one', () => {
    expect(crawlerOcrToSettings(undefined)).toBeUndefined();
    expect(crawlerOcrToSettings({ enabled: false, languages: ['eng'] })).toBeUndefined();
    // The option as it was before models existed (no mode) keeps meaning “scanned pages only”.
    expect(crawlerOcrToSettings({ enabled: true, languages: ['eng', 'tur'] })).toEqual({ mode: 'auto', languages: ['eng', 'tur'] });
    expect(crawlerOcrToSettings({ enabled: true, mode: 'always', modelKey: 'm', maxPages: 9, images: true }))
      .toEqual({ mode: 'always', modelKey: 'm', maxPages: 9, images: true });
  });

  it('goes back unchanged, so saving the HTTP settings keeps it', () => {
    const stored = { enabled: true as const, mode: 'always' as const, modelKey: 'doc-ocr', languages: ['tr', 'en'], maxPages: 40, images: true };
    expect(settingsToCrawlerOcr(crawlerOcrToSettings(stored))).toEqual(stored);
    const legacy = { enabled: true as const, languages: ['eng'] };
    expect(settingsToCrawlerOcr(crawlerOcrToSettings(legacy))).toEqual({ enabled: true, mode: 'auto', languages: ['eng'] });
  });

  it('sends no option at all when OCR is off, with no undefined keys when it is on', () => {
    expect(settingsToCrawlerOcr(undefined)).toBeUndefined();
    expect(settingsToCrawlerOcr({ mode: 'off' })).toBeUndefined();
    const minimal = settingsToCrawlerOcr({ mode: 'auto' });
    expect(minimal).toEqual({ enabled: true, mode: 'auto' });
    expect(Object.keys(minimal!)).toEqual(['enabled', 'mode']);
  });
});

describe('strings', () => {
  const flatten = (node: unknown, path = ''): Array<[string, string]> =>
    typeof node === 'string'
      ? [[path, node]]
      : node && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, value]) => flatten(value, path ? `${path}.${key}` : key))
        : [];
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('ocrSettings has the same keys and placeholders in English and Turkish, none empty, none copied', () => {
    const english = Object.fromEntries(flatten(en.ocrSettings));
    const turkish = Object.fromEntries(flatten(tr.ocrSettings));
    expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
    // Terms that read the same in both languages.
    const same = new Set(['engine.groupOcr']);
    for (const key of Object.keys(english)) {
      expect(turkish[key]!.trim(), key).not.toBe('');
      expect(placeholders(turkish[key]!), key).toEqual(placeholders(english[key]!));
      if (!same.has(key)) expect(turkish[key], key).not.toBe(english[key]);
    }
  });

  it('every key the fields and the summary ask for exists', () => {
    for (const key of ['mode.label', 'engine.local', 'languages.invalid', 'maxPages.label', 'images.label', 'summary.off', 'result.pagesOf']) {
      expect(englishOcrText(key), key).not.toBe(key);
    }
    expect(englishOcrText('no.such.key')).toBe('no.such.key');
  });

  it('keeps the placeholders of a message the fields fill in', () => {
    expect(englishOcrText('result.pagesOf', { count: 2, total: 9 })).toBe('OCR · 2/9 pages');
    expect(englishOcrText('result.pagesOf', { count: 2 })).toBe('OCR · 2/{total} pages');
  });
});
