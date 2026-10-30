/**
 * The crawler's bridge to the document extraction engine. `crawler/engine/*` imports nothing from the console, so the
 * host (job runner, single-page fetch) binds the engine to a scope here and injects the result through
 * `CrawlEngineDeps`. The bridge is built only for plans whose `markdownOptions.ocr` is enabled; a crawl without OCR
 * never touches it.
 */

import { getConvertToMarkdownDetailed } from '@/lib/services/extraction/toMarkdownApi';
import { isOcrActive, normalizeOcrSettings, ocrDefaults, toIsoLanguage } from '@/lib/services/extraction/settings';
import type { OcrSettings } from '@/lib/services/extraction/types';
import type { CrawlEngineDeps, CrawlFileExtraction, CrawlMarkdownOptions } from './engine';
import type { CrawlerContext } from './types';

type CrawlerOcr = NonNullable<CrawlMarkdownOptions['ocr']>;

const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[a-z]+)?$/i;

/** The same limit the shared OCR settings have: a crawler's list of free-text codes is cut here. */
const MAX_LANGUAGES = 8;

/** Longest a crawler waits beyond the engine's own deadline: room for the native-text fallback after a timeout. */
const FALLBACK_GRACE_MS = 30_000;

/**
 * The extraction engine's OCR settings for a crawler's. Languages the crawler stored as free text (a tesseract code,
 * `eng`, or anything else) are kept when they look like a language code and dropped otherwise: they never fail a
 * crawl. `undefined` when the crawler's OCR is off.
 */
export function crawlerOcrToSettings(ocr: CrawlerOcr | undefined): OcrSettings | undefined {
  if (!ocr?.enabled) return undefined;
  const languages = (ocr.languages ?? [])
    .map((language) => (typeof language === 'string' ? language.trim() : ''))
    .filter((language) => LANGUAGE_PATTERN.test(language))
    .map(toIsoLanguage);
  const distinct = [...new Set(languages)].slice(0, MAX_LANGUAGES);
  const settings: OcrSettings = {
    mode: ocr.mode === 'always' ? 'always' : 'auto',
    ...(ocr.modelKey?.trim() ? { modelKey: ocr.modelKey.trim() } : {}),
    ...(distinct.length > 0 ? { languages: distinct } : {}),
    ...(typeof ocr.maxPages === 'number' ? { maxPages: ocr.maxPages } : {}),
    ...(ocr.images ? { images: true } : {}),
  };
  return settings;
}

/**
 * Engine deps (`extractFile`, `ocrConversionTimeoutMs`) for a plan, or none when the plan's OCR is off.
 * `budget` is `'background'` for a crawl job and `'inline'` for a fetch somebody is waiting on.
 */
export function crawlerExtractionDeps(
  ctx: CrawlerContext,
  markdownOptions: CrawlMarkdownOptions | undefined,
  budget: 'background' | 'inline',
): Pick<CrawlEngineDeps, 'extractFile' | 'ocrConversionTimeoutMs'> {
  if (!markdownOptions?.ocr?.enabled) return {};
  // A converter library without the extraction API (older than 3.6) cannot be driven by the engine: the crawler then
  // keeps calling the library directly with its OCR options, as it always did, instead of losing OCR.
  if (!getConvertToMarkdownDetailed()) return {};
  const defaults = ocrDefaults();
  const deadline = budget === 'background' ? defaults.documentTimeoutMs : defaults.inlineTimeoutMs;
  return {
    ocrConversionTimeoutMs: deadline + FALLBACK_GRACE_MS,
    extractFile: async (input: CrawlFileExtraction) => {
      const settings = crawlerOcrToSettings(input.ocr);
      const { extractDocument } = await import('@/lib/services/extraction');
      const result = await extractDocument({
        scope: { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        source: 'crawler',
        fileName: input.fileName,
        data: input.buffer,
        contentType: input.contentType,
        ocr: settings,
        budget,
        signal: input.signal,
      });
      return result.text;
    },
  };
}

/**
 * Save-time check of a crawler's OCR options (create, update, ad-hoc run): the numbers and mode are in range and the
 * OCR model, when one is named, exists in the project and can read documents. Returns a sentence for a 400, or
 * `undefined`. Options with OCR off, or none, are never checked.
 */
export async function crawlerOcrProblem(
  ctx: CrawlerContext,
  markdownOptions: { ocr?: CrawlerOcr } | undefined,
): Promise<string | undefined> {
  const ocr = markdownOptions?.ocr;
  if (!ocr?.enabled) return undefined;
  // Languages are not judged here: the crawler has always taken them as free text.
  const candidate: Record<string, unknown> = {
    mode: ocr.mode ?? 'auto',
    ...(ocr.modelKey !== undefined ? { modelKey: ocr.modelKey } : {}),
    ...(ocr.maxPages !== undefined ? { maxPages: ocr.maxPages } : {}),
    ...(ocr.images !== undefined ? { images: ocr.images } : {}),
  };
  const { value, error } = normalizeOcrSettings(candidate);
  if (error) return `Invalid OCR options: ${error}`;
  if (!isOcrActive(value) || !value.modelKey) return undefined;
  const { validateOcrModelRef } = await import('@/lib/services/extraction');
  const problem = await validateOcrModelRef(
    { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
    value.modelKey,
  );
  return problem ? `Invalid OCR model: ${problem}` : undefined;
}
