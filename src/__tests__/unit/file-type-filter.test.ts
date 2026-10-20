/**
 * Unit tests - the Document Store's type filter: which kind a file is.
 *
 * `classifyFileKind` is the rule written as a function; the two database providers each turn the same rule table
 * into a query (the parity test in integration/files-bucket-stats-and-type-filter-parity.test.ts holds them to it).
 */

import { describe, expect, it } from 'vitest';
import {
  FILE_KIND_RULES,
  FILE_TYPE_FILTERS,
  classifyFileKind,
  isFileTypeFilter,
  normalizeContentType,
} from '@/lib/database/fileTypeFilter';

describe('normalizeContentType', () => {
  it('drops parameters, trims and lower-cases', () => {
    expect(normalizeContentType('Text/Plain; charset=UTF-8')).toBe('text/plain');
    expect(normalizeContentType('  application/PDF  ')).toBe('application/pdf');
    expect(normalizeContentType('image/png;')).toBe('image/png');
  });

  it('reads nothing as the empty string', () => {
    expect(normalizeContentType(undefined)).toBe('');
    expect(normalizeContentType(null)).toBe('');
    expect(normalizeContentType('')).toBe('');
  });
});

describe('isFileTypeFilter', () => {
  it('accepts exactly the kinds a picker offers', () => {
    expect([...FILE_TYPE_FILTERS]).toEqual(['pdf', 'image', 'text', 'office', 'other']);
    for (const kind of FILE_TYPE_FILTERS) expect(isFileTypeFilter(kind)).toBe(true);
  });

  it('refuses anything else', () => {
    for (const value of ['', 'PDF', 'video', 'all', undefined, null, 1, {}, ['pdf']]) expect(isFileTypeFilter(value)).toBe(false);
  });
});

describe('classifyFileKind', () => {
  it.each([
    ['application/pdf', 'a.bin', 'pdf'],
    ['application/pdf; qs=0.5', 'a.bin', 'pdf'],
    ['image/png', 'a.bin', 'image'],
    ['image/svg+xml', 'logo', 'image'],
    ['IMAGE/JPEG', 'a', 'image'],
    ['text/plain', 'a.bin', 'text'],
    ['text/markdown; charset=utf-8', 'a', 'text'],
    ['text/html', 'a', 'text'],
    ['application/json', 'a', 'text'],
    ['application/msword', 'a', 'office'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a', 'office'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a', 'office'],
    ['application/vnd.ms-excel', 'a', 'office'],
    ['application/vnd.ms-powerpoint', 'a', 'office'],
    ['application/vnd.oasis.opendocument.text', 'a', 'office'],
    ['application/zip', 'a.zip', 'other'],
    ['video/mp4', 'a.mp4', 'other'],
    ['audio/mpeg', 'a.mp3', 'other'],
  ] as const)('%s (%s) is %s', (contentType, name, kind) => {
    expect(classifyFileKind(contentType, name)).toBe(kind);
  });

  it('falls back to the extension of the name when the content type names no kind', () => {
    expect(classifyFileKind(undefined, 'Report.PDF')).toBe('pdf');
    expect(classifyFileKind('', 'photo.JPG')).toBe('image');
    expect(classifyFileKind('application/octet-stream', 'notes.md')).toBe('text');
    expect(classifyFileKind(null, 'budget.xlsx')).toBe('office');
    expect(classifyFileKind('application/octet-stream', 'deck.pptx')).toBe('office');
    expect(classifyFileKind(undefined, 'data.csv')).toBe('text');
  });

  it('lets the content type win over the extension', () => {
    expect(classifyFileKind('application/pdf', 'not-really.txt')).toBe('pdf');
    expect(classifyFileKind('text/plain', 'scan.pdf')).toBe('text');
    expect(classifyFileKind('image/png', 'x.docx')).toBe('image');
  });

  it('puts what neither places under other', () => {
    expect(classifyFileKind(undefined, 'archive.zip')).toBe('other');
    expect(classifyFileKind('application/octet-stream', 'no-extension')).toBe('other');
    expect(classifyFileKind(undefined, undefined)).toBe('other');
    expect(classifyFileKind(null, null)).toBe('other');
  });

  it('gives a file one kind only: no content type, and no extension, is claimed by two kinds', () => {
    const kinds = Object.keys(FILE_KIND_RULES) as Array<keyof typeof FILE_KIND_RULES>;
    for (const kind of kinds) {
      for (const mimeType of FILE_KIND_RULES[kind].mimeTypes) expect(classifyFileKind(mimeType, '')).toBe(kind);
      for (const prefix of FILE_KIND_RULES[kind].mimePrefixes) expect(classifyFileKind(`${prefix}x`, '')).toBe(kind);
      for (const extension of FILE_KIND_RULES[kind].extensions) expect(classifyFileKind(undefined, `file${extension}`)).toBe(kind);
    }
    const everyExtension = kinds.flatMap((kind) => FILE_KIND_RULES[kind].extensions);
    expect(new Set(everyExtension).size).toBe(everyExtension.length);
    const everyMimeType = kinds.flatMap((kind) => FILE_KIND_RULES[kind].mimeTypes);
    expect(new Set(everyMimeType).size).toBe(everyMimeType.length);
  });
});
