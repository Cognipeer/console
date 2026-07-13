/**
 * Wraps @cognipeer/to-markdown with a cheerio-text fallback so the engine
 * never fails the page when markdown conversion errors out.
 */

import * as cheerio from 'cheerio';
import { convertToMarkdown } from '@cognipeer/to-markdown';
import type { CrawlMarkdownOptions } from './types';

export interface MarkdownInput {
  html: string;
  fileName?: string;
  options?: CrawlMarkdownOptions;
}

export async function htmlToMarkdown(input: MarkdownInput): Promise<string> {
  const { html, fileName = 'page.html', options } = input;
  try {
    const base64 = Buffer.from(html, 'utf8').toString('base64');
    const dataUri = `data:text/html;base64,${base64}`;
    const result = await convertToMarkdown(dataUri, {
      fileName,
      ...(options?.ocr ? { ocr: options.ocr } : {}),
    });
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'markdown' in result) {
      const md = (result as { markdown?: unknown }).markdown;
      if (typeof md === 'string') return md;
    }
    return cheerioFallback(html);
  } catch {
    return cheerioFallback(html);
  }
}

function cheerioFallback(html: string): string {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, svg').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

export interface FileMarkdownInput {
  buffer: Buffer;
  fileName: string;
  options?: CrawlMarkdownOptions;
}

/**
 * Converts a downloaded attachment (PDF/DOCX/XLSX/…) to markdown text so it
 * can be persisted alongside HTML pages and ingested into RAG. Returns
 * `undefined` (rather than throwing) when the converter cannot extract any
 * content — the caller still keeps the file metadata (bytes/contentType).
 */
export async function fileToMarkdown(input: FileMarkdownInput): Promise<string | undefined> {
  const { buffer, fileName, options } = input;
  try {
    const result = await convertToMarkdown(buffer, {
      fileName,
      ...(options?.ocr ? { ocr: options.ocr } : {}),
    });
    if (typeof result === 'string') return result || undefined;
    if (result && typeof result === 'object' && 'markdown' in result) {
      const md = (result as { markdown?: unknown }).markdown;
      if (typeof md === 'string') return md || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
