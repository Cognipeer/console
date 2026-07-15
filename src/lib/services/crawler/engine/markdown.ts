/**
 * Wraps @cognipeer/to-markdown with a cheerio-text fallback so the engine
 * never fails the page when markdown conversion errors out.
 */

import * as cheerio from 'cheerio';
import { decodeHTML } from 'entities';
import { convertToMarkdown } from '@cognipeer/to-markdown';
import type { CrawlMarkdownOptions } from './types';

export interface MarkdownInput {
  html: string;
  fileName?: string;
  options?: CrawlMarkdownOptions;
}

export async function htmlToMarkdown(input: MarkdownInput): Promise<string> {
  const { html, fileName = 'page.html', options } = input;
  const prepared = preprocessHtml(html, options);
  try {
    const base64 = Buffer.from(prepared, 'utf8').toString('base64');
    const dataUri = `data:text/html;base64,${base64}`;
    const result = await convertToMarkdown(dataUri, {
      fileName,
      ...(options?.ocr ? { ocr: options.ocr } : {}),
    });
    if (typeof result === 'string') return finalizeBody(result, options);
    if (result && typeof result === 'object' && 'markdown' in result) {
      const md = (result as { markdown?: unknown }).markdown;
      if (typeof md === 'string') return finalizeBody(md, options);
    }
    return finalizeBody(cheerioFallback(prepared), options);
  } catch {
    return finalizeBody(cheerioFallback(prepared), options);
  }
}

/**
 * Post-process the converter output into the stored body: clean up known
 * markdown defects, optionally flatten to plain text, then cap the length.
 * Shared by both HTML and file conversion so every stored body is consistent.
 */
function finalizeBody(raw: string, options?: CrawlMarkdownOptions): string {
  let body = raw;
  if (options?.outputFormat === 'text') {
    body = markdownToText(body);
  } else if (options?.cleanup ?? true) {
    body = cleanupMarkdown(body);
  }
  return capBody(body, options);
}

/**
 * Repair the recurring defects in @cognipeer/to-markdown's output (see
 * [[crawler-markdown-defects]]): literal HTML entities the converter passed
 * through (`&nbsp;`, `&amp;`, …), dead `[text](#)` / `javascript:` anchors,
 * empty images, and runs of blank lines / marker-only lines. Conservative on
 * purpose — it never touches real headings, links or list structure, so it
 * can run by default without corrupting good pages.
 */
export function cleanupMarkdown(md: string): string {
  let out = decodeHTML(md);
  // Normalize non-breaking / unicode spaces the decode produced (e.g. &nbsp;
  // → U+00A0) to plain spaces so downstream whitespace handling is uniform.
  out = out.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');
  // Dead anchor / javascript links → keep just the visible text. The URL may
  // itself contain balanced parens (javascript:void(0)), so allow one level.
  out = out.replace(/\[([^\]]*)\]\((?:#[^)]*|javascript:[^)\s(]*(?:\([^)]*\))?[^)]*)\)/gi, '$1');
  // Empty images (no alt AND placeholder/empty src is noise in prose).
  out = out.replace(/!\[\s*\]\([^)]*\)/g, '');
  // Collapse horizontal whitespace runs (but keep newlines).
  out = out.replace(/[^\S\n]{2,}/g, ' ');
  // Trim trailing whitespace on every line.
  out = out.replace(/[^\S\n]+$/gm, '');
  // Drop lines that are only a heading/list/quote marker with no content.
  out = out.replace(/^[^\S\n]*(?:#{1,6}|[-*+]|>)[^\S\n]*$/gm, '');
  // Collapse 3+ consecutive newlines to a single blank line.
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Flatten markdown to clean plain text: strip heading/emphasis/list/quote
 * markers, reduce links to their text, drop images, and turn table rows into
 * space-separated cells. Runs entity-decode + whitespace collapse too, so the
 * converter's structure defects don't survive into the text output.
 */
export function markdownToText(md: string): string {
  let t = decodeHTML(md);
  t = t.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ');                  // NBSP / unicode spaces → space
  t = t.replace(/```[^\n]*\n?/g, '');            // fenced code delimiters
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');    // images
  // Links → text (URL may carry escaped/balanced parens: javascript:void\(0\)).
  t = t.replace(/\[([^\]]*)\]\((?:\\.|\([^)]*\)|[^)])*\)/g, '$1');
  t = t.replace(/^[^\S\n]*#{1,6}[^\S\n]*/gm, ''); // ATX headings
  t = t.replace(/^[^\S\n]*>[^\S\n]?/gm, '');      // blockquotes
  t = t.replace(/^[^\S\n]*[-*+][^\S\n]+/gm, '');  // bullet markers
  t = t.replace(/^[^\S\n]*\d+\.[^\S\n]+/gm, '');  // ordered markers
  t = t.replace(/^[-*_]{3,}[^\S\n]*$/gm, '');     // horizontal rules
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');       // bold
  t = t.replace(/(\*|_)(.*?)\1/g, '$2');          // italic
  t = t.replace(/`([^`]+)`/g, '$1');              // inline code
  // Tables: the converter collapses whole tables onto ONE line, so per-line
  // handling misses them. Strip |---|--- separator cells and turn every
  // remaining pipe into a space globally — lossy, but text output is about
  // clean readable prose, not structure.
  t = t.replace(/\|[\s:-]*(?=\|)/g, ' ');   // separator cells (| --- |)
  t = t.replace(/\|/g, ' ');                 // remaining cell pipes
  t = t.replace(/[^\S\n]{2,}/g, ' ');
  t = t.replace(/[^\S\n]+$/gm, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * Clean the raw HTML before markdown conversion: strip inline base64 images,
 * remove caller-specified chrome selectors, and (optionally) narrow to the main
 * content region. Best-effort — any failure returns the original HTML so a
 * parse hiccup never loses the page.
 */
function preprocessHtml(html: string, options?: CrawlMarkdownOptions): string {
  const stripDataImages = options?.stripDataImages ?? true;
  const hasWork =
    stripDataImages ||
    options?.mainContentOnly ||
    options?.contentSelector ||
    (options?.removeSelectors?.length ?? 0) > 0;
  if (!hasWork) return html;
  try {
    const $ = cheerio.load(html);
    // Always drop non-content chrome that only adds noise to extracted text.
    $('script, style, noscript, template').remove();
    if (stripDataImages) {
      // Remove <img src="data:..."> and CSS data: backgrounds; these are the
      // dominant source of multi-hundred-KB bodies.
      $('img').each((_, el) => {
        const src = $(el).attr('src') ?? '';
        if (src.startsWith('data:')) $(el).remove();
      });
      $('[style*="data:"]').each((_, el) => { $(el).removeAttr('style'); });
    }
    for (const sel of options?.removeSelectors ?? []) {
      try { $(sel).remove(); } catch { /* ignore bad selector */ }
    }
    const selector = options?.contentSelector
      || (options?.mainContentOnly ? pickMainContentSelector($) : undefined);
    if (selector) {
      const region = $(selector).first();
      if (region.length && region.html()) {
        return `<!doctype html><html><body>${region.html()}</body></html>`;
      }
    }
    return $.html();
  } catch {
    return html;
  }
}

/**
 * Tiny readability-style heuristic: prefer semantic main-content containers,
 * else the block with the most text. Returns a selector string or undefined.
 */
function pickMainContentSelector($: cheerio.CheerioAPI): string | undefined {
  for (const sel of ['main', 'article', '[role="main"]', '#content', '#main', '.content', '.main-content']) {
    if ($(sel).first().length) return sel;
  }
  return undefined;
}

/** Truncate over-long bodies to keep the DB / RAG chunker from choking. */
function capBody(md: string, options?: CrawlMarkdownOptions): string {
  const cap = options?.maxBodyChars ?? 0;
  if (cap > 0 && md.length > cap) {
    return `${md.slice(0, cap)}\n\n<!-- truncated: ${md.length - cap} more chars -->`;
  }
  return md;
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
    if (typeof result === 'string') return result ? finalizeBody(result, options) : undefined;
    if (result && typeof result === 'object' && 'markdown' in result) {
      const md = (result as { markdown?: unknown }).markdown;
      if (typeof md === 'string') return md ? finalizeBody(md, options) : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
