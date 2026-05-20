/**
 * Link / meta extraction from an HTML string using cheerio.
 */

import * as cheerio from 'cheerio';
import {
  getHostname,
  isSameOrSubdomain,
  isSkippableExtension,
  isSupportedHttpUrl,
  matchesAny,
  normalizeUrl,
} from './normalize';
import type { CrawlScope } from './types';

export interface ExtractedMeta {
  title: string;
  description: string;
}

export function extractMeta(html: string): ExtractedMeta {
  const $ = cheerio.load(html);
  const title =
    $("meta[property='og:title']").attr('content') ||
    $('title').first().text() ||
    '';
  const description =
    $("meta[name='description']").attr('content') ||
    $("meta[property='og:description']").attr('content') ||
    '';
  return { title: title.trim(), description: description.trim() };
}

export interface ExtractLinksInput {
  html: string;
  pageUrl: string;
  rootDomain: string;
  scope: CrawlScope;
  visited: Set<string>;
}

export function extractLinks({
  html,
  pageUrl,
  rootDomain,
  scope,
  visited,
}: ExtractLinksInput): string[] {
  const $ = cheerio.load(html);
  const raw = $('a[href]')
    .map((_, el) => $(el).attr('href') ?? '')
    .get();

  const seen = new Set<string>();
  const out: string[] = [];

  for (const lnk of raw) {
    try {
      const resolved = new URL(lnk, pageUrl);
      const resolvedStr = resolved.toString();
      if (!isSupportedHttpUrl(resolvedStr)) continue;

      const norm = normalizeUrl(resolvedStr);
      if (visited.has(norm) || seen.has(norm)) continue;
      if (isSkippableExtension(norm)) continue;

      const host = getHostname(norm);

      if (scope.blockList && matchesAny(host, scope.blockList)) continue;
      if (scope.allowList && scope.allowList.length > 0) {
        if (!matchesAny(host, scope.allowList)) continue;
      } else if (scope.sameDomainOnly) {
        if (!isSameOrSubdomain(host, rootDomain, scope.includeSubdomains)) continue;
      }

      seen.add(norm);
      out.push(norm);
    } catch {
      // invalid URL; skip
    }
  }

  return out;
}

/**
 * Heuristic that fires when the body returned by axios is almost certainly
 * a JS-rendered shell (SPA loading screen). Used to decide whether to
 * fall back to Playwright in `auto` mode.
 */
export function looksLikeJsShell(html: string): boolean {
  try {
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, svg').remove();
    const textLen = $('body').text().replace(/\s+/g, ' ').trim().length;
    return textLen < 100;
  } catch {
    return false;
  }
}
