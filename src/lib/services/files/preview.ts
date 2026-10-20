/**
 * Which files the Document Store shows in the browser, and how.
 *
 * A preview is served inline from the console's own origin, so it is limited to types a browser renders without
 * running anything: a few image formats, PDF and plain-text formats. Text is always sent as `text/plain` (a
 * stored `text/markdown` or `application/json` is shown as text, never interpreted), and SVG, HTML and every
 * other active or unknown type is refused. The routes add the headers that keep the response inert
 * (`nosniff`, `Content-Security-Policy: sandbox`).
 */

import { normalizeContentType } from '@/lib/database/fileTypeFilter';
import { FileServiceError } from './errors';

/** The largest object a preview reads into memory. */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

const PREVIEW_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PREVIEW_TEXT_TYPES: readonly string[] = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];

/** What text is served as: the browser shows it, whatever the stored type says. */
export const PREVIEW_TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';

export type PreviewVariant = 'original' | 'markdown';

export interface PreviewPlan {
  /** The `Content-Type` of the response. */
  contentType: string;
}

function refusal(reason: 'unsupported_type' | 'too_large', message: string): FileServiceError {
  return new FileServiceError('preview_unsupported', 415, message, { details: { reason } });
}

/**
 * How to serve a file (or its Markdown copy) inline, or why not. `size` is what the record says; the caller
 * checks the bytes it actually read with `assertPreviewSize` as well.
 */
export function planPreview(input: { contentType?: string | null; size?: number | null; variant?: PreviewVariant }): PreviewPlan {
  const contentType = input.variant === 'markdown'
    ? PREVIEW_TEXT_CONTENT_TYPE
    : previewContentType(normalizeContentType(input.contentType));
  if (!contentType) {
    throw refusal('unsupported_type', 'This file type cannot be previewed. Download it instead.');
  }
  assertPreviewSize(input.size);
  return { contentType };
}

function previewContentType(type: string): string | undefined {
  if (type === 'application/pdf' || PREVIEW_IMAGE_TYPES.includes(type)) return type;
  if (PREVIEW_TEXT_TYPES.includes(type)) return PREVIEW_TEXT_CONTENT_TYPE;
  return undefined;
}

export function assertPreviewSize(size: number | null | undefined): void {
  if (typeof size === 'number' && size > PREVIEW_MAX_BYTES) {
    throw refusal('too_large', `This file is too large to preview (the limit is ${PREVIEW_MAX_BYTES / (1024 * 1024)} MB). Download it instead.`);
  }
}
