/**
 * Which files a Markdown copy makes sense for, and how large one may be.
 *
 * The converter (`@cognipeer/to-markdown`) picks its reader by the file name's extension and, for any extension it
 * does not know, reads the bytes as text: a binary file then yields a "copy" that is noise. The background
 * conversion (the Document Store's upload and "Convert" action) therefore only runs for the formats the converter
 * has a reader for AND that carry text to extract. Left out on purpose: images and audio (the reader reports size,
 * format and tags, no text), archives (the reader unpacks every entry in memory), and Markdown itself (the file is
 * its own text version).
 */

import path from 'node:path';
import { isImageFile, isOcrActive } from '../extraction/settings';
import type { OcrSettings } from '../extraction/types';
import { FileServiceError } from './errors';
import { uploadMaxBytes, uploadMaxMb } from './uploadLimits';

const CONVERTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.doc', '.docx', '.pptx', '.xlsx', '.xls', '.epub', '.msg',
  '.html', '.htm', '.xml', '.rss', '.atom',
  '.txt', '.csv', '.json', '.yaml', '.yml', '.ipynb',
]);

/**
 * Whether a file of this name gets a Markdown copy. The name decides: it is what the converter reads. An image
 * has no text for the converter to read, so it is convertible only when OCR is on (`options.ocr`): the text is then
 * what OCR reads from it.
 */
export function isMarkdownConvertible(
  fileName: string | null | undefined,
  options: { ocr?: OcrSettings | null } = {},
): boolean {
  if (!fileName) return false;
  if (CONVERTIBLE_EXTENSIONS.has(path.extname(fileName).toLowerCase())) return true;
  return isOcrActive(options.ocr) && isImageFile(fileName);
}

export function assertMarkdownConvertible(
  fileName: string | null | undefined,
  options: { ocr?: OcrSettings | null } = {},
): void {
  if (!isMarkdownConvertible(fileName, options)) {
    throw new FileServiceError('conversion_unsupported', 415, 'Markdown conversion is not available for this type of file.');
  }
}

/** The largest file the conversion reads: the upload limit, which is what every file it converted used to pass. */
export function markdownConversionLimitBytes(): number {
  return uploadMaxBytes();
}

export function markdownConversionTooLarge(size: number): boolean {
  return size > markdownConversionLimitBytes();
}

export function assertMarkdownSize(size: number): void {
  if (markdownConversionTooLarge(size)) {
    throw new FileServiceError(
      'conversion_too_large',
      413,
      `The file is larger than the ${uploadMaxMb()} MB limit for Markdown conversion.`,
    );
  }
}
