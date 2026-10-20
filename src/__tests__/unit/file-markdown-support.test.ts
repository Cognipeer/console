/**
 * Which files get a Markdown copy (`markdownSupport`): the formats the converter reads that carry text. The name's
 * extension decides, as it does inside the converter.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { isFileServiceError } from '@/lib/services/files/errors';
import {
  assertMarkdownConvertible,
  assertMarkdownSize,
  isMarkdownConvertible,
  markdownConversionLimitBytes,
  markdownConversionTooLarge,
} from '@/lib/services/files/markdownSupport';

const originalConfig = getConfigSource();
afterEach(() => setConfigSource(originalConfig));

describe('isMarkdownConvertible', () => {
  it.each([
    'report.pdf', 'letter.doc', 'letter.docx', 'deck.pptx', 'sheet.xlsx', 'sheet.xls', 'book.epub', 'mail.msg',
    'page.html', 'page.htm', 'feed.xml', 'feed.rss', 'feed.atom', 'notes.txt', 'table.csv', 'data.json', 'conf.yaml', 'conf.yml', 'nb.ipynb',
  ])('converts %s', (name) => {
    expect(isMarkdownConvertible(name)).toBe(true);
  });

  it('goes by the extension, whatever the case and the folders', () => {
    expect(isMarkdownConvertible('REPORT.PDF')).toBe(true);
    expect(isMarkdownConvertible('archive.v2.final.docx')).toBe(true);
    expect(isMarkdownConvertible('dir.pdf/readme')).toBe(false);
  });

  it.each([
    'photo.png', 'photo.jpg', 'photo.jpeg', 'anim.gif', 'song.mp3', 'clip.wav', 'bundle.zip',
    'notes.md', 'notes.markdown', 'program.exe', 'script.py', 'data.bin', 'README', '.env', '',
  ])('leaves %s without a copy', (name) => {
    expect(isMarkdownConvertible(name)).toBe(false);
  });

  it('knows no name for nothing', () => {
    expect(isMarkdownConvertible(undefined)).toBe(false);
    expect(isMarkdownConvertible(null)).toBe(false);
  });
});

describe('assertMarkdownConvertible', () => {
  it('passes a convertible file and refuses any other with 415 conversion_unsupported', () => {
    expect(() => assertMarkdownConvertible('a.pdf')).not.toThrow();
    try {
      assertMarkdownConvertible('a.png');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isFileServiceError(error)).toBe(true);
      expect(error).toMatchObject({ code: 'conversion_unsupported', status: 415 });
    }
  });
});

describe('the size limit', () => {
  it('is the upload limit', () => {
    setConfigSource({ get: (key: string) => (key === 'FILE_UPLOAD_MAX_MB' ? '2' : process.env[key]) } as ConfigSource);
    expect(markdownConversionLimitBytes()).toBe(2 * 1024 * 1024);
    expect(markdownConversionTooLarge(2 * 1024 * 1024)).toBe(false);
    expect(markdownConversionTooLarge(2 * 1024 * 1024 + 1)).toBe(true);
  });

  it('refuses a file over it with 413 conversion_too_large, naming the limit', () => {
    setConfigSource({ get: (key: string) => (key === 'FILE_UPLOAD_MAX_MB' ? '2' : process.env[key]) } as ConfigSource);
    expect(() => assertMarkdownSize(1024)).not.toThrow();
    try {
      assertMarkdownSize(3 * 1024 * 1024);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'conversion_too_large', status: 413 });
      expect((error as Error).message).toContain('2 MB');
    }
  });
});
