/**
 * What kind of file a record is, for the Document Store's type filter.
 *
 * One table of rules, read by both database providers (each turns it into its own query) and by
 * `classifyFileKind`, the same decision as a function: a record is classified by its content type, and by
 * the extension of its name only when the content type names none of the kinds (a missing type, or a
 * generic one such as `application/octet-stream`). So a file has exactly one kind, and `other` is whatever
 * neither the type nor the extension places.
 */

import type { FileTypeFilter } from './provider/types';

/** The kinds a listing can be narrowed to, in the order a picker shows them. */
export const FILE_TYPE_FILTERS: readonly FileTypeFilter[] = ['pdf', 'image', 'text', 'office', 'other'];

export function isFileTypeFilter(value: unknown): value is FileTypeFilter {
  return typeof value === 'string' && (FILE_TYPE_FILTERS as readonly string[]).includes(value);
}

export interface FileKindRule {
  /** The content type (parameters dropped, lower case) is exactly one of these. */
  mimeTypes: readonly string[];
  /** The content type starts with one of these. */
  mimePrefixes: readonly string[];
  /** The name ends with one of these (dot included, lower case); used only when no kind claims the content type. */
  extensions: readonly string[];
}

export const FILE_KIND_RULES: Readonly<Record<Exclude<FileTypeFilter, 'other'>, FileKindRule>> = {
  pdf: {
    mimeTypes: ['application/pdf'],
    mimePrefixes: [],
    extensions: ['.pdf'],
  },
  image: {
    mimeTypes: [],
    mimePrefixes: ['image/'],
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.tif', '.tiff', '.ico', '.heic'],
  },
  text: {
    mimeTypes: ['application/json'],
    mimePrefixes: ['text/'],
    extensions: ['.md', '.txt', '.csv', '.json'],
  },
  office: {
    // Word, Excel and PowerPoint (the legacy binary formats and Office Open XML, templates and macro variants
    // included) and OpenDocument.
    mimeTypes: ['application/msword'],
    mimePrefixes: [
      'application/vnd.ms-word',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.',
      'application/vnd.oasis.opendocument.',
    ],
    extensions: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp'],
  },
};

const RULED_KINDS = Object.keys(FILE_KIND_RULES) as Array<Exclude<FileTypeFilter, 'other'>>;

/** `text/plain; charset=utf-8` -> `text/plain`. */
export function normalizeContentType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

function kindOfContentType(contentType: string): Exclude<FileTypeFilter, 'other'> | undefined {
  if (!contentType) return undefined;
  return RULED_KINDS.find((kind) => {
    const rule = FILE_KIND_RULES[kind];
    return rule.mimeTypes.includes(contentType) || rule.mimePrefixes.some((prefix) => contentType.startsWith(prefix));
  });
}

function kindOfName(name: string): Exclude<FileTypeFilter, 'other'> | undefined {
  const lower = name.toLowerCase();
  return RULED_KINDS.find((kind) => FILE_KIND_RULES[kind].extensions.some((extension) => lower.endsWith(extension)));
}

/** The kind of a file: its content type first, the extension of its name when the content type says nothing. */
export function classifyFileKind(contentType: string | null | undefined, name: string | null | undefined): FileTypeFilter {
  return kindOfContentType(normalizeContentType(contentType)) ?? kindOfName(name ?? '') ?? 'other';
}
