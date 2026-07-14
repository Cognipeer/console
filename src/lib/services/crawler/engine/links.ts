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
 * a JS-rendered shell (SPA loading screen) OR an anti-bot interstitial
 * (Cloudflare/Akamai/DDoS-Guard/reCAPTCHA "checking your browser" page).
 * Both cases return HTTP 200 with plausible-looking HTML but none of the
 * real page content, and both are only escaped by rendering with a real
 * browser engine (Playwright) — used to decide whether to escalate in
 * `auto` mode.
 */
const BOT_CHALLENGE_PATTERNS = [
  /just a moment/i,
  /checking your browser/i,
  /attention required.{0,20}cloudflare/i,
  /cloudflare.{0,20}ray id/i,
  /enable javascript and cookies to continue/i,
  /ddos-guard/i,
  /\bincapsula\b/i,
  /distil networks/i,
  /perimeterx/i,
  /captcha-delivery\.com/i,
  /please verify you are a human/i,
  /verifying you are human/i,
  /access denied.{0,40}(reference|error) #/i,
  // Seen on tefas.gov.tr (and other Akamai/Radware-fronted sites): a bare
  // 200 response whose entire body is this one sentence — the real page
  // never gets served, JS challenge or not, incl. to a real headless
  // Chromium (see the re-check of the Playwright result in engine/index.ts).
  /please enable javascript to view the page content/i,
  /your support id is\s*:/i,
];

export function looksLikeJsShell(html: string): boolean {
  try {
    const $ = cheerio.load(html);

    // Strong signal: known SPA root containers (Angular/React/Vue/Next)
    // rendered empty because the framework bundle hasn't executed yet.
    // Catches shells that otherwise have enough surrounding chrome text
    // (nav/footer/cookie banner) to pass a text-length check alone.
    const spaRootSelectors = ['app-root', '#root', '#app', '#__next', '[data-reactroot]'];
    for (const selector of spaRootSelectors) {
      const el = $(selector).first();
      if (el.length > 0 && el.children().length === 0 && el.text().trim().length < 20) {
        return true;
      }
    }

    // Bot-detection interstitials are usually short pages built almost
    // entirely from a couple of known vendor snippets. A production-only
    // symptom (page returns 200 but "wrong"/empty content, while the same
    // URL crawls fine from a local/residential IP) is a classic sign the
    // target site is challenging the crawler's (datacenter) IP instead of
    // serving the real page — retrying with Playwright at least gives the
    // challenge's JS a chance to run and, on some vendors, pass.
    if (BOT_CHALLENGE_PATTERNS.some((re) => re.test(html))) {
      return true;
    }

    $('script, style, noscript, iframe, svg').remove();
    const textLen = $('body').text().replace(/\s+/g, ' ').trim().length;
    // 200 rather than 100: many shells ship enough static nav/footer/cookie
    // banner text to clear a lower bar while the real content is still
    // client-rendered.
    return textLen < 200;
  } catch {
    return false;
  }
}
