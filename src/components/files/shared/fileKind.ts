/**
 * What kind of file a record is, as pure functions: the five classes of the
 * objects listing's type filter (the server's own classifier decides, so the
 * chip, the icon and the filter always agree) and what the file drawer can show inline.
 */

import { classifyFileKind, normalizeContentType } from '@/lib/database/fileTypeFilter';
import type { FileTypeFilter } from '../filesApi';

export type FileKind = FileTypeFilter;

/** The classes in the order a type filter lists them. */
export const FILE_KINDS: readonly FileKind[] = ['pdf', 'image', 'text', 'office', 'other'];

/** What is needed to classify a file: a record, an upload-queue entry (`{ contentType: file.type, name: file.name }`). */
export interface FileLike {
  contentType?: string | null;
  name?: string | null;
  /** Used for the extension when `name` is missing. */
  key?: string | null;
}

/**
 * pdf / image / text / office / other. The content type decides; the extension of the name is the fallback only
 * when the content type names none of the kinds (a missing or generic one such as `application/octet-stream`).
 * This is the very function the server filters a listing with (`classifyFileKind`).
 */
export function fileKindOf(file: FileLike): FileKind {
  return classifyFileKind(file.contentType, file.name || file.key);
}

/** How the file drawer shows a file inline. */
export type PreviewKind = 'image' | 'pdf' | 'text';

/** The inline preview route refuses anything larger (413 -> no preview). */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

const PREVIEW_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PREVIEW_TEXT_MIME = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

/**
 * The preview the server will give for the file, or null for "no preview". Only the safe types it serves
 * inline (PNG / JPEG / GIF / WebP, PDF, plain text, Markdown, CSV, JSON) up to 10 MB. Decided by the content
 * type alone: the extension is not consulted.
 */
export function previewKindOf(file: Pick<FileLike, 'contentType'> & { size?: number | null }): PreviewKind | null {
  if (typeof file.size === 'number' && file.size > PREVIEW_MAX_BYTES) return null;
  const mime = normalizeContentType(file.contentType);
  if (PREVIEW_IMAGE_MIME.has(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (PREVIEW_TEXT_MIME.has(mime)) return 'text';
  return null;
}

/**
 * Whether a file has a Markdown copy to read or download. The server decides by the copy itself (`markdownKey`), not
 * by the status of the last conversion: a re-conversion that fails or is skipped leaves the earlier copy in place,
 * and one that is still running does not take it away.
 */
export function hasMarkdownCopy(file: { markdownKey?: string | null }): boolean {
  return Boolean(file.markdownKey);
}

/**
 * Whether the Markdown copy of a file can be shown as text: there is a copy and it is small enough (the server
 * previews a Markdown copy as text whatever the original was; it judges the size of the copy, not of the original).
 */
export function canPreviewMarkdown(file: { markdownKey?: string | null; markdownSize?: number | null }): boolean {
  if (!hasMarkdownCopy(file)) return false;
  return !(typeof file.markdownSize === 'number' && file.markdownSize > PREVIEW_MAX_BYTES);
}

/**
 * The name the Markdown copy of a file is saved under: `report.pdf` -> `report.md`; a Markdown original keeps its
 * own name beside it (`notes.md` -> `notes.md.md`). The server names the copy the same way.
 */
export function markdownFileName(originalName: string): string {
  const slash = originalName.lastIndexOf('/');
  const folder = originalName.slice(0, slash + 1);
  const base = originalName.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot) : '';
  if (extension && extension.toLowerCase() !== '.md') {
    return `${folder}${base.slice(0, base.length - extension.length)}.md`;
  }
  return `${folder}${base}.md`;
}
