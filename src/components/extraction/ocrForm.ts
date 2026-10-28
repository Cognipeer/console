/**
 * The OCR settings form as pure functions: the value every consumer edits (the same shape the API stores as
 * `OcrSettings`), how an edit lands in it, and the one-line summary. No React, and nothing from the server side of
 * the extraction engine (its settings module reads the environment), so a screen and a test can import it freely.
 */

import type { OcrMode, OcrSettings } from '@/lib/services/extraction/types';

export type { OcrMode, OcrSettings };

/** Languages offered when the person has not chosen any (the engine's own default is the same). */
export const DEFAULT_OCR_LANGUAGES: readonly string[] = ['tr', 'en'];

/** The API accepts ISO 639-1 / 639-3 codes, optionally with a script or region (`zh_cn`). */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[a-z]+)?$/i;

export const OCR_MODES: readonly OcrMode[] = ['off', 'auto', 'always'];

/** OCR is switched on in this value. Absent, `null` and `mode: 'off'` are all "off". */
export function ocrIsOn(value: OcrSettings | null | undefined): value is OcrSettings {
  return !!value && (value.mode === 'auto' || value.mode === 'always');
}

/** The mode a form shows for a stored value. */
export function ocrModeOf(value: OcrSettings | null | undefined): OcrMode {
  return ocrIsOn(value) ? value.mode : 'off';
}

/** Normalises what a person typed into the languages field: trimmed, lower case, no empties, no repeats. */
export function cleanLanguages(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of raw) {
    const code = entry.trim().toLowerCase();
    if (code) seen.add(code);
  }
  return [...seen];
}

/** The language codes the API would refuse. */
export function invalidLanguages(languages: readonly string[] | undefined): string[] {
  return (languages ?? []).filter((code) => !LANGUAGE_PATTERN.test(code));
}

/**
 * Keeps only what was set: no `undefined` keys (a Mongo `$set` would store them as null), and nothing at all when OCR
 * is off, so a form that never touched OCR sends nothing.
 */
export function compactOcr(value: OcrSettings | null | undefined): OcrSettings | undefined {
  if (!ocrIsOn(value)) return undefined;
  const languages = value.languages ? cleanLanguages(value.languages) : [];
  const modelKey = value.modelKey?.trim();
  return {
    mode: value.mode,
    ...(modelKey ? { modelKey } : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(typeof value.maxPages === 'number' && Number.isFinite(value.maxPages) && value.maxPages > 0
      ? { maxPages: Math.floor(value.maxPages) }
      : {}),
    ...(value.images === true ? { images: true } : {}),
  };
}

/** Merges an edit into the value. Setting a key to `undefined` removes it; turning OCR off clears everything. */
export function patchOcr(value: OcrSettings | null | undefined, patch: Partial<OcrSettings>): OcrSettings | undefined {
  const merged: Record<string, unknown> = { ...(ocrIsOn(value) ? value : {}), ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  // The first switch from off to on has no mode in the stored value: the patch carries it.
  return merged.mode ? compactOcr(merged as unknown as OcrSettings) : undefined;
}

/** Whether two values mean the same thing (off is off, whichever way it is written). */
export function sameOcr(a: OcrSettings | null | undefined, b: OcrSettings | null | undefined): boolean {
  return JSON.stringify(compactOcr(a) ?? null) === JSON.stringify(compactOcr(b) ?? null);
}

/** What `useOcrModelOptions` reports: the models a project can read documents with. */
export interface OcrModelChoice {
  value: string;
  label: string;
}

export interface OcrModelOptions {
  /** Models of category `ocr`. */
  ocr: OcrModelChoice[];
  /** Vision LLMs: category `llm` with `isMultimodal`. */
  vision: OcrModelChoice[];
  loading: boolean;
  /** The lists could not be loaded (the person may still keep a model that is already chosen). */
  failed: boolean;
}

export const NO_OCR_MODELS: OcrModelOptions = { ocr: [], vision: [], loading: false, failed: false };

interface ModelListRow {
  key?: unknown;
  name?: unknown;
  isMultimodal?: unknown;
}

/** The choices out of a `GET /api/models` answer; `visionOnly` keeps the multimodal ones (the `llm` list). */
export function modelChoices(rows: readonly ModelListRow[] | undefined, visionOnly: boolean): OcrModelChoice[] {
  const choices: OcrModelChoice[] = [];
  for (const row of rows ?? []) {
    if (typeof row.key !== 'string' || !row.key) continue;
    if (visionOnly && row.isMultimodal !== true) continue;
    choices.push({ value: row.key, label: typeof row.name === 'string' && row.name ? row.name : row.key });
  }
  return choices;
}

/**
 * The model a value names when it is not among the loaded choices, or undefined. Unknown while the lists load or when
 * they could not be loaded (nothing to compare with); no model named = the local engine, which is always there.
 */
export function missingOcrModel(value: OcrSettings | null | undefined, options: OcrModelOptions): string | undefined {
  if (!ocrIsOn(value) || !value.modelKey) return undefined;
  if (options.loading || options.failed) return undefined;
  const known = options.ocr.some((o) => o.value === value.modelKey) || options.vision.some((o) => o.value === value.modelKey);
  return known ? undefined : value.modelKey;
}

/** Shape of the translator the summary needs (`useTranslations('ocrSettings')`). */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "Auto · Local engine · tr, en", or "Off". */
export function describeOcr(t: Translate, value: OcrSettings | null | undefined, options?: OcrModelOptions): string {
  if (!ocrIsOn(value)) return t('summary.off');
  const model = value.modelKey
    ? [...(options?.ocr ?? []), ...(options?.vision ?? [])].find((choice) => choice.value === value.modelKey)?.label ?? value.modelKey
    : t('summary.local');
  const languages = (value.languages?.length ? value.languages : DEFAULT_OCR_LANGUAGES).join(', ');
  return [
    value.mode === 'always' ? t('summary.always') : t('summary.auto'),
    model,
    languages,
    ...(value.images ? [t('summary.images')] : []),
  ].join(' · ');
}

/** The "OCR · n pages" label of a finished run, or undefined when it did not use OCR. */
export function ocrResultLabel(
  t: Translate,
  result: { sourceType?: string; ocrPages?: number; pageCount?: number; ocrImages?: number } | null | undefined,
): string | undefined {
  if (!result || result.sourceType === 'converted') return undefined;
  const pages = result.ocrPages ?? 0;
  if (pages > 0) {
    if (typeof result.pageCount === 'number' && result.pageCount >= pages && result.sourceType === 'mixed') {
      return t('result.pagesOf', { count: pages, total: result.pageCount });
    }
    return pages === 1 ? t('result.pageOne') : t('result.pages', { count: pages });
  }
  if ((result.ocrImages ?? 0) > 0 || result.sourceType === 'ocr') return t('result.images');
  return undefined;
}
