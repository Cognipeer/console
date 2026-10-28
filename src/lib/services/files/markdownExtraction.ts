/**
 * How a file's Markdown copy is extracted: reading the optional `ocr` / `images` settings of a request, keeping them
 * on the record (`IFileRecord.markdownExtraction`) and adding what the run found.
 *
 * Everything here is optional on purpose. A file without settings is converted exactly as it was before OCR existed,
 * and nothing is written to its record.
 */

import type { IFileMarkdownExtraction } from '@/lib/database';
import { isOcrActive, normalizeOcrSettings } from '../extraction/settings';
import type { ExtractionReport, ExtractionScope, ImagePolicy, OcrSettings } from '../extraction/types';
import type { FileExtractionRequest } from './types';

const IMAGE_POLICIES: ReadonlySet<string> = new Set<ImagePolicy>(['inline', 'placeholder', 'omit']);

/** Warnings kept on the record: enough to explain a result, never a log. */
const MAX_WARNINGS = 5;
const MAX_WARNING_LENGTH = 120;

/** Details that are safe to keep after a code: a language code, or the page counts of a limit. */
const SAFE_WARNING_DETAILS: Record<string, RegExp> = {
  ocr_language_unavailable: /^[A-Za-z]{2,12}(?:[+_-][A-Za-z]{2,12})*$/,
  tesseract_lang_missing: /^[A-Za-z]{2,12}(?:[+_-][A-Za-z]{2,12})*$/,
  ocr_page_limit: /^\d{1,6} candidate pages, \d{1,6} processed$/,
  ocr_image_limit: /^\d{1,6}(?: [a-z ]{1,30})?(?:, \d{1,6}(?: [a-z ]{1,30})?)?$/,
};

/**
 * A warning as the record keeps it: its stable code, never the text after it. That text is what a provider or a
 * library said about a failure and can carry a request URL, a deployment name, a request id or a path; the engine
 * logs it server side.
 */
function recordedWarning(warning: string): string | undefined {
  const colon = warning.indexOf(':');
  const code = (colon === -1 ? warning : warning.slice(0, colon)).trim();
  if (!/^[a-z][a-z0-9_]{0,59}$/.test(code)) return undefined;
  const detail = colon === -1 ? '' : warning.slice(colon + 1).trim();
  const allowed = SAFE_WARNING_DETAILS[code];
  const kept = allowed && detail && allowed.test(detail) ? `${code}: ${detail}` : code;
  return kept.length > MAX_WARNING_LENGTH ? kept.slice(0, MAX_WARNING_LENGTH) : kept;
}

/** How often a long run touches its record so the screens do not take it for a lost job. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The settings that matter, compact: OCR only when it is on, pictures only when they are not kept inline (the
 * default). `undefined` when nothing is left, so a file without settings stays without.
 */
export function compactExtraction(
  source: { ocr?: OcrSettings | IFileMarkdownExtraction['ocr'] | null; images?: ImagePolicy | null } | null | undefined,
): FileExtractionRequest | undefined {
  if (!source) return undefined;
  const ocr = isOcrActive(source.ocr as OcrSettings | null | undefined) ? (source.ocr as OcrSettings) : undefined;
  const images = source.images && source.images !== 'inline' ? source.images : undefined;
  if (!ocr && !images) return undefined;
  return { ...(ocr ? { ocr } : {}), ...(images ? { images } : {}) };
}

/** What the record keeps after a run: its settings and, when OCR is on, what the run found. */
export function extractionWithResult(
  settings: IFileMarkdownExtraction | null | undefined,
  report: ExtractionReport,
): IFileMarkdownExtraction | undefined {
  const compact = compactExtraction(settings);
  if (!compact) return undefined;
  if (!compact.ocr) return compact;
  const warnings = [...new Set(report.warnings.map(recordedWarning).filter((w): w is string => !!w))].slice(0, MAX_WARNINGS);
  return {
    ...compact,
    result: {
      sourceType: report.sourceType,
      ...(report.engine ? { engine: report.engine } : {}),
      ...(report.modelKey ? { modelKey: report.modelKey } : {}),
      ...(report.pageCount !== undefined ? { pageCount: report.pageCount } : {}),
      ...(report.ocrPages && report.ocrPages.length > 0 ? { ocrPages: report.ocrPages.length } : {}),
      ...(report.ocrImages ? { ocrImages: report.ocrImages } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  };
}

export type ExtractionBodyResult =
  /** `present`: the body said something about extraction (so it replaces what the file has). */
  | { extraction: FileExtractionRequest | undefined; present: boolean }
  | { error: string };

/**
 * Reads the optional `ocr` and `images` fields of an upload or convert body. Errors are sentences for the caller (a
 * 400): a malformed setting, or an OCR model that is not in the project / cannot read documents.
 */
export async function parseExtractionBody(
  body: Record<string, unknown>,
  scope: ExtractionScope,
): Promise<ExtractionBodyResult> {
  const hasOcr = body.ocr !== undefined;
  const hasImages = body.images !== undefined;
  if (!hasOcr && !hasImages) return { extraction: undefined, present: false };

  let ocr: OcrSettings | undefined;
  if (hasOcr) {
    const parsed = normalizeOcrSettings(body.ocr);
    if (parsed.error) return { error: parsed.error };
    if (isOcrActive(parsed.value)) {
      ocr = parsed.value;
      if (ocr.modelKey) {
        const { validateOcrModelRef } = await import('../extraction');
        const problem = await validateOcrModelRef(scope, ocr.modelKey);
        if (problem) return { error: problem };
      }
    }
  }

  let images: ImagePolicy | undefined;
  if (hasImages && body.images !== null) {
    if (typeof body.images !== 'string' || !IMAGE_POLICIES.has(body.images)) {
      return { error: "images must be one of 'inline', 'placeholder', 'omit'" };
    }
    images = body.images as ImagePolicy;
  }
  return { extraction: compactExtraction({ ocr, images }), present: true };
}

/**
 * Touches a record at most every `HEARTBEAT_INTERVAL_MS` while a long run works on it (page by page OCR), so the
 * screens that take a conversion `pending` for five quiet minutes as lost do not. `stop()` ends the touches.
 */
export function startHeartbeat(touch: () => Promise<unknown>): { beat(): void; stop(): void } {
  let last = Date.now();
  const beat = () => {
    const now = Date.now();
    if (now - last < HEARTBEAT_INTERVAL_MS) return;
    last = now;
    void touch().catch(() => undefined);
  };
  // A single long call (one request for a whole document) reports no progress: the clock keeps the record alive.
  const timer = setInterval(beat, Math.floor(HEARTBEAT_INTERVAL_MS / 3));
  timer.unref?.();
  return { beat, stop: () => clearInterval(timer) };
}
