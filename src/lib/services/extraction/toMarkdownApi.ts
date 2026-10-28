/**
 * The part of `@cognipeer/to-markdown` 3.6 the engine uses, declared here because the version installed with Console
 * may be older: its types lack `convertToMarkdownDetailed` and the OCR options of 3.6. The engine therefore never
 * names those exports directly. It asks `getConvertToMarkdownDetailed()`, which answers `undefined` when the
 * installed library does not have them, and OCR requests then degrade to the plain conversion.
 */

import * as toMarkdown from '@cognipeer/to-markdown';

export type OcrImageKind = 'pdf-page' | 'image' | 'tiff-page' | 'embedded-image';

export interface OcrProgressEvent {
  kind: OcrImageKind;
  completed: number;
  total: number;
  page?: number;
}

export interface OcrHandlerContext {
  page?: number;
  pageCount?: number;
  mimeType?: string;
  sourceExtension?: string;
  fileName?: string;
  imageWidth?: number;
  imageHeight?: number;
  kind?: OcrImageKind;
  index?: number;
  sourcePath?: string;
  slide?: number;
  /** ISO 639-1 languages the caller asked for. */
  langHint?: string[];
  signal?: AbortSignal;
}

export interface OcrHandlerResult {
  text: string;
  markdown?: string;
  confidence?: number;
}

export type OcrHandler = (buffer: Buffer, context: OcrHandlerContext) => Promise<string | OcrHandlerResult>;

export interface OcrDocumentHandlerContext {
  /** 1-based pages to read. */
  pages: number[];
  pageCount: number;
  fileName?: string;
  langHint?: string[];
  signal?: AbortSignal;
}

export type OcrDocumentHandler = (
  pdf: Buffer,
  context: OcrDocumentHandlerContext,
) => Promise<Array<{ page: number; text: string; markdown?: string }>>;

export interface TesseractOptions {
  langPath?: string;
  cachePath?: string;
  /** Never download language data: requires `langPath`. */
  offline?: boolean;
  psm?: number;
  oem?: number;
  gzip?: boolean;
}

export interface EmbeddedImageOcrOptions {
  minWidth?: number;
  minHeight?: number;
  maxImages?: number;
  dedupe?: boolean;
}

/** The OCR options of 3.6 the engine sets (a subset of the library's `OCROptions`). */
export interface OcrOptions {
  provider?: 'tesseract' | 'handler';
  lang?: string;
  pdfMode?: 'auto' | 'auto-page' | 'always' | 'never';
  handler?: OcrHandler;
  documentHandler?: OcrDocumentHandler;
  tesseract?: TesseractOptions;
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: OcrProgressEvent) => void;
  onError?: 'comment' | 'skip' | 'throw';
  embeddedImages?: boolean | EmbeddedImageOcrOptions;
}

export interface DetailedConversionOptions {
  fileName?: string;
  images?: 'inline' | 'placeholder' | 'omit';
  /** Image files: the `ImageSize:` / `Format:` lines (default true). */
  imageMetadata?: boolean;
  /** Image files: the `## Extracted Text` heading over the OCR text (default true). */
  imageTextHeading?: boolean;
  ocr?: OcrOptions;
}

export interface PageReport {
  page: number;
  source: 'text' | 'ocr' | 'empty' | 'error' | 'skipped';
  chars: number;
  reason?: 'no-text' | 'low-text' | 'garbled' | 'always' | 'auto';
  error?: string;
  ms?: number;
}

export interface ImageReport {
  index: number;
  kind: OcrImageKind;
  path?: string;
  width?: number;
  height?: number;
  ocr: boolean;
  chars?: number;
  skipped?: 'small' | 'duplicate' | 'limit';
  error?: string;
}

export interface DetailedConversion {
  markdown: string;
  extension: string;
  pages?: PageReport[];
  images?: ImageReport[];
  /** `"code: detail"` strings. */
  warnings: string[];
  stats: { pageCount?: number; ocrCalls: number; ocrPages: number; ocrImages: number; ocrMs: number; renderMs: number };
}

export type ConvertToMarkdownDetailed = (
  input: Buffer,
  options?: DetailedConversionOptions,
) => Promise<DetailedConversion>;

// The name is held in a variable on purpose: a literal `toMarkdown.convertToMarkdownDetailed` is resolved (and
// complained about) by the bundler when the installed version lacks it, and a test double of the library throws
// when an export it does not define is read. `in` tells the two cases apart without reading.
const DETAILED_EXPORT = 'convertToMarkdownDetailed';

/** `convertToMarkdownDetailed` of the installed library, or `undefined` when it is older than 3.6. */
export function getConvertToMarkdownDetailed(): ConvertToMarkdownDetailed | undefined {
  try {
    if (!(DETAILED_EXPORT in toMarkdown)) return undefined;
    const candidate = (toMarkdown as unknown as Record<string, unknown>)[DETAILED_EXPORT];
    return typeof candidate === 'function' ? (candidate as ConvertToMarkdownDetailed) : undefined;
  } catch {
    return undefined;
  }
}

/** The plain conversion (all the library versions have it). */
export function convertPlain(input: Buffer, options: { fileName?: string; images?: 'inline' | 'placeholder' | 'omit' }) {
  return toMarkdown.convertToMarkdown(input, options);
}
