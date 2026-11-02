/**
 * OCR settings: what a stored or submitted setting may hold, which setting wins, which files OCR applies to, and the
 * tunables of the engine. Pure apart from reading the configuration.
 */

import path from 'node:path';
import { getConfig } from '@/lib/core/config';
import type { OcrMode, OcrSettings } from './types';

export interface OcrDefaults {
  /** ISO 639-1 languages tried when a setting names none. */
  languages: string[];
  maxPages: number;
  maxPagesLimit: number;
  modelConcurrency: number;
  localConcurrency: number;
  localMaxDocs: number;
  callTimeoutMs: number;
  documentTimeoutMs: number;
  inlineTimeoutMs: number;
  tessdataDir: string;
}

const FALLBACK_DEFAULTS: OcrDefaults = {
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
};

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * The engine's tunables from the configuration (`OCR_*`). A configuration without an `ocr` block (a test's partial
 * mock, or none at all) yields the defaults.
 */
export function ocrDefaults(): OcrDefaults {
  let block: Partial<Record<string, unknown>> | undefined;
  try {
    block = (getConfig() as unknown as { ocr?: Partial<Record<string, unknown>> } | undefined)?.ocr;
  } catch {
    block = undefined;
  }
  if (!block) return { ...FALLBACK_DEFAULTS, languages: [...FALLBACK_DEFAULTS.languages] };
  const languages = Array.isArray(block.defaultLanguages)
    ? block.defaultLanguages.filter((l): l is string => typeof l === 'string' && l.length > 0)
    : [];
  const maxPagesLimit = positive(block.maxPagesLimit, FALLBACK_DEFAULTS.maxPagesLimit);
  return {
    languages: languages.length > 0 ? languages : [...FALLBACK_DEFAULTS.languages],
    maxPages: Math.min(positive(block.maxPages, FALLBACK_DEFAULTS.maxPages), maxPagesLimit),
    maxPagesLimit,
    modelConcurrency: positive(block.modelConcurrency, FALLBACK_DEFAULTS.modelConcurrency),
    localConcurrency: positive(block.localConcurrency, FALLBACK_DEFAULTS.localConcurrency),
    localMaxDocs: positive(block.localMaxDocs, FALLBACK_DEFAULTS.localMaxDocs),
    callTimeoutMs: positive(block.callTimeoutMs, FALLBACK_DEFAULTS.callTimeoutMs),
    documentTimeoutMs: positive(block.documentTimeoutMs, FALLBACK_DEFAULTS.documentTimeoutMs),
    inlineTimeoutMs: positive(block.inlineTimeoutMs, FALLBACK_DEFAULTS.inlineTimeoutMs),
    tessdataDir: typeof block.tessdataDir === 'string' ? block.tessdataDir : '',
  };
}

const MODES: ReadonlySet<string> = new Set<OcrMode>(['off', 'auto', 'always']);
const KNOWN_KEYS: ReadonlySet<string> = new Set(['mode', 'modelKey', 'languages', 'maxPages', 'images']);
const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[a-z]+)?$/i;
const MAX_LANGUAGES = 8;
const MAX_MODEL_KEY_LENGTH = 120;

/** Tesseract codes people may submit, as the ISO 639-1 code the settings keep. */
const TESSERACT_TO_ISO: Readonly<Record<string, string>> = {
  tur: 'tr', eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', rus: 'ru', ara: 'ar',
  fas: 'fa', ell: 'el', pol: 'pl', ukr: 'uk', aze: 'az', ron: 'ro', bul: 'bg', ces: 'cs', hun: 'hu', swe: 'sv',
  dan: 'da', fin: 'fi', nor: 'no', jpn: 'ja', kor: 'ko', heb: 'he', hin: 'hi',
};

const ISO_TO_TESSERACT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TESSERACT_TO_ISO).map(([tesseract, iso]) => [iso, tesseract]),
);

/** A language as the settings keep it: lowercase ISO 639-1 where a tesseract code names one. */
export function toIsoLanguage(language: string): string {
  const lower = language.trim().toLowerCase();
  return TESSERACT_TO_ISO[lower] ?? lower;
}

/** A language as Tesseract names it (`tr` -> `tur`); anything unknown passes through. */
export function toTesseractLanguage(language: string): string {
  const lower = language.trim().toLowerCase();
  return ISO_TO_TESSERACT[lower] ?? lower;
}

/**
 * Validates a submitted OCR setting. `null` clears (explicitly off); an object is checked and returned compact (no
 * undefined keys, languages as lowercase ISO codes without duplicates). Unknown keys are an error: a typo must not
 * silently turn a setting into nothing.
 */
export function normalizeOcrSettings(raw: unknown): { value?: OcrSettings | null; error?: string } {
  if (raw === null) return { value: null };
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'ocr must be an object' };
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) return { error: `ocr.${key} is not a known setting` };
  }
  if (typeof input.mode !== 'string' || !MODES.has(input.mode)) {
    return { error: "ocr.mode must be one of 'off', 'auto', 'always'" };
  }
  const value: OcrSettings = { mode: input.mode as OcrMode };

  if (input.modelKey !== undefined && input.modelKey !== null) {
    if (typeof input.modelKey !== 'string') return { error: 'ocr.modelKey must be a string' };
    const key = input.modelKey.trim();
    if (key.length > MAX_MODEL_KEY_LENGTH) {
      return { error: `ocr.modelKey must be at most ${MAX_MODEL_KEY_LENGTH} characters` };
    }
    // An empty key is the local engine, the same as no key.
    if (key.length > 0) value.modelKey = key;
  }

  if (input.languages !== undefined && input.languages !== null) {
    if (!Array.isArray(input.languages)) return { error: 'ocr.languages must be an array of language codes' };
    if (input.languages.length > MAX_LANGUAGES) return { error: `ocr.languages may hold at most ${MAX_LANGUAGES} languages` };
    const seen = new Set<string>();
    for (const entry of input.languages) {
      if (typeof entry !== 'string' || !LANGUAGE_PATTERN.test(entry.trim())) {
        return { error: `ocr.languages holds an invalid language code: ${JSON.stringify(entry)}` };
      }
      seen.add(toIsoLanguage(entry));
    }
    if (seen.size > 0) value.languages = [...seen];
  }

  if (input.maxPages !== undefined && input.maxPages !== null) {
    const limit = ocrDefaults().maxPagesLimit;
    if (typeof input.maxPages !== 'number' || !Number.isInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > limit) {
      return { error: `ocr.maxPages must be an integer between 1 and ${limit}` };
    }
    value.maxPages = input.maxPages;
  }

  if (input.images !== undefined && input.images !== null) {
    if (typeof input.images !== 'boolean') return { error: 'ocr.images must be a boolean' };
    value.images = input.images;
  }

  return { value };
}

/** OCR is on for these settings. */
export function isOcrActive(settings: OcrSettings | null | undefined): settings is OcrSettings {
  return Boolean(settings) && settings!.mode !== 'off';
}

/**
 * The setting that applies: the first layer that is not `undefined`. `null` is a layer too: it switches OCR off
 * explicitly and hides the layers below it.
 */
export function effectiveOcr(...layers: Array<OcrSettings | null | undefined>): OcrSettings | null | undefined {
  for (const layer of layers) {
    if (layer !== undefined) return layer;
  }
  return undefined;
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/x-ms-bmp',
]);

/** The file is an image the engine can read text from. */
export function isImageFile(fileName: string, contentType?: string): boolean {
  if (IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase())) return true;
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return Boolean(type && IMAGE_CONTENT_TYPES.has(type));
}

/**
 * OCR can add text for this file: a PDF, an image, and (when `settings.images` is on) a Word or PowerPoint file
 * whose embedded pictures are read.
 */
export function isOcrCandidate(fileName: string, contentType: string | undefined, settings: OcrSettings | null | undefined): boolean {
  if (!isOcrActive(settings)) return false;
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.pdf' || contentType?.split(';')[0]?.trim().toLowerCase() === 'application/pdf') return true;
  if (isImageFile(fileName, contentType)) return true;
  return settings.images === true && (extension === '.docx' || extension === '.pptx');
}

/** The languages a setting asks for, as ISO codes; the configured default when it names none. */
export function ocrLanguages(settings: OcrSettings | null | undefined): string[] {
  const named = settings?.languages?.map(toIsoLanguage).filter(Boolean) ?? [];
  return named.length > 0 ? [...new Set(named)] : ocrDefaults().languages.map(toIsoLanguage);
}
