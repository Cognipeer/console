/**
 * Web Search adapter — directly calls provider search HTTP endpoints.
 *
 * Mirrors the reranker adapter: searches bypass the provider runtime layer and
 * hit the provider HTTP APIs directly, keyed on the provider `driver`:
 *   - bing        → GET https://api.bing.microsoft.com/v7.0/search
 *   - brave-search→ GET https://api.search.brave.com/res/v1/web/search
 *   - serper      → POST https://google.serper.dev/search
 *   - tavily      → POST https://api.tavily.com/search
 *   - searxng     → GET {baseUrl}/search?format=json   (tenant URL → safeFetch)
 *   - duckduckgo  → GET https://html.duckduckgo.com/html/ (best-effort parse)
 */

import { createLogger } from '@/lib/core/logger';
import { withResilience } from '@/lib/core/resilience';
import { currentTurnSignal } from '@/lib/core/turnSignal';
import { getRequestContext } from '@/lib/core/requestContext';
import { safeFetch } from '@/lib/security/outboundFetch';
import {
  observeProviderTarget,
  providerRuntimeGuardObserves,
  providerRuntimeGuardOptions,
} from '@/lib/services/providers/runtimeGuard';
import type { IProviderRecord } from '@/lib/database';
import { DEFAULT_RESULTS, asSafeSearch, asString, clampCount } from './searchOptions';
import type { WebSearchInput, WebSearchResultItem } from './types';

const logger = createLogger('websearch-adapter');

interface AdapterCallResult {
  results: WebSearchResultItem[];
  answer?: string;
}

interface DriverCallInput extends WebSearchInput {
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  /** Aborts the provider request (the agent turn's Stop). */
  signal?: AbortSignal;
  /** Separates the circuit breaker of one route or connection from another of the same driver. */
  breakerScope?: string;
}

export async function callWebSearchProvider(
  record: IProviderRecord,
  credentials: Record<string, unknown>,
  input: WebSearchInput,
  options: { breakerScope?: string } = {},
): Promise<AdapterCallResult> {
  const settings = (record.settings ?? {}) as Record<string, unknown>;
  const call: DriverCallInput = {
    ...input,
    count: clampCount(input.count),
    language: input.language ?? asString(settings.language),
    country: input.country ?? asString(settings.country),
    safeSearch: input.safeSearch ?? asSafeSearch(settings.safeSearch),
    credentials,
    settings,
    breakerScope: options.breakerScope,
    // A search an agent runs ends with its turn: a Stop aborts the provider request in flight.
    signal: input.signal ?? currentTurnSignal(),
  };

  switch (record.driver) {
    case 'bing':
      return callBing(call);
    case 'brave-search':
      return callBrave(call);
    case 'serper':
      return callSerper(call);
    case 'tavily':
      return callTavily(call);
    case 'searxng':
      return callSearxng(call);
    case 'duckduckgo':
      return callDuckDuckGo(call);
    default:
      throw new Error(
        `Provider driver "${record.driver}" does not support web search. ` +
          'Use Bing, Brave Search, Serper, Tavily, SearxNG, or DuckDuckGo.',
      );
  }
}

/**
 * Every search call goes through the outbound guard: the target (including a configured endpoint) is validated and
 * pinned for the connection, and a redirect is handed back instead of followed, so credential headers stay with the
 * host they were configured for. `PROVIDER_RUNTIME_GUARD=warn` keeps the path each call took before the setting
 * existed: plain `fetch` with a log line for a target the guard would refuse, or, for a call that was already made
 * through the outbound guard (`guardedBefore`: the SearxNG search with its configured base URL), that guard with its
 * default options, so the default mode is not weaker than the release before it.
 */
async function searchFetch(url: string | URL, init: RequestInit, opts?: { guardedBefore?: boolean }): Promise<Response> {
  const target = String(url);
  const tenantId = getRequestContext()?.tenantId;
  if (providerRuntimeGuardObserves()) {
    if (opts?.guardedBefore) return safeFetch(target, init);
    observeProviderTarget(target, tenantId);
    return fetch(url, init);
  }
  return safeFetch(target, init, await providerRuntimeGuardOptions(target, tenantId));
}

function requireApiKey(input: DriverCallInput, providerLabel: string): string {
  const apiKey = asString(input.credentials.apiKey);
  if (!apiKey) throw new Error(`${providerLabel} web search requires an apiKey credential.`);
  return apiKey;
}

// ── Bing ────────────────────────────────────────────────────────────────

async function callBing(input: DriverCallInput): Promise<AdapterCallResult> {
  const apiKey = requireApiKey(input, 'Bing');
  const endpoint =
    asString(input.settings.endpoint) ?? 'https://api.bing.microsoft.com/v7.0/search';
  const url = new URL(endpoint);
  url.searchParams.set('q', input.query);
  url.searchParams.set('count', String(input.count));
  if (input.offset) url.searchParams.set('offset', String(input.offset));
  if (input.country) url.searchParams.set('mkt', input.country);
  if (input.safeSearch) {
    url.searchParams.set(
      'safeSearch',
      { off: 'Off', moderate: 'Moderate', strict: 'Strict' }[input.safeSearch],
    );
  }

  const response = await withResilience(
    () => searchFetch(url, { headers: { 'Ocp-Apim-Subscription-Key': apiKey }, signal: input.signal }),
    { key: breakerKey('bing', input) },
  );
  if (!response.ok) {
    throw searchFailure('Bing', response);
  }
  const json = (await response.json()) as {
    webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; datePublished?: string }> };
  };
  const items = json.webPages?.value ?? [];
  return {
    results: items.map((item, idx) => ({
      title: item.name ?? '',
      url: item.url ?? '',
      snippet: item.snippet ?? '',
      position: idx + 1,
      publishedAt: item.datePublished,
    })),
  };
}

// ── Brave ───────────────────────────────────────────────────────────────

async function callBrave(input: DriverCallInput): Promise<AdapterCallResult> {
  const apiKey = requireApiKey(input, 'Brave');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', input.query);
  url.searchParams.set('count', String(input.count));
  if (input.offset) url.searchParams.set('offset', String(input.offset));
  if (input.country) url.searchParams.set('country', input.country);
  if (input.language) url.searchParams.set('search_lang', input.language);
  if (input.safeSearch) url.searchParams.set('safesearch', input.safeSearch);

  const response = await withResilience(
    () =>
      searchFetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal: input.signal,
      }),
    { key: breakerKey('brave', input) },
  );
  if (!response.ok) {
    throw searchFailure('Brave', response);
  }
  const json = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }> };
  };
  const items = json.web?.results ?? [];
  return {
    results: items.map((item, idx) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
      position: idx + 1,
      publishedAt: item.page_age,
    })),
  };
}

// ── Serper ──────────────────────────────────────────────────────────────

async function callSerper(input: DriverCallInput): Promise<AdapterCallResult> {
  const apiKey = requireApiKey(input, 'Serper');
  const body: Record<string, unknown> = {
    q: input.query,
    num: input.count,
  };
  if (input.country) body.gl = input.country;
  if (input.language) body.hl = input.language;
  if (input.offset && input.count) {
    body.page = Math.floor(input.offset / input.count) + 1;
  }

  const response = await withResilience(
    () =>
      searchFetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: input.signal,
      }),
    { key: breakerKey('serper', input) },
  );
  if (!response.ok) {
    throw searchFailure('Serper', response);
  }
  const json = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string; position?: number }>;
    answerBox?: { answer?: string; snippet?: string };
  };
  const items = json.organic ?? [];
  return {
    results: items.map((item, idx) => ({
      title: item.title ?? '',
      url: item.link ?? '',
      snippet: item.snippet ?? '',
      position: item.position ?? idx + 1,
      publishedAt: item.date,
    })),
    answer: json.answerBox?.answer ?? json.answerBox?.snippet,
  };
}

// ── Tavily ──────────────────────────────────────────────────────────────

async function callTavily(input: DriverCallInput): Promise<AdapterCallResult> {
  const apiKey = requireApiKey(input, 'Tavily');
  const body: Record<string, unknown> = {
    query: input.query,
    max_results: input.count,
    search_depth: asString(input.settings.searchDepth) ?? 'basic',
    include_answer: input.settings.includeAnswer === true,
  };

  const response = await withResilience(
    () =>
      searchFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: input.signal,
      }),
    { key: breakerKey('tavily', input) },
  );
  if (!response.ok) {
    throw searchFailure('Tavily', response);
  }
  const json = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>;
    answer?: string;
  };
  const items = json.results ?? [];
  return {
    results: items.map((item, idx) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.content ?? '',
      position: idx + 1,
      publishedAt: item.published_date,
      score: item.score,
    })),
    answer: typeof json.answer === 'string' ? json.answer : undefined,
  };
}

// ── SearxNG (self-hosted, tenant-provided URL → SSRF guard) ─────────────

async function callSearxng(input: DriverCallInput): Promise<AdapterCallResult> {
  const baseUrl = asString(input.settings.baseUrl);
  if (!baseUrl) throw new Error('SearxNG web search requires a baseUrl setting.');

  const url = new URL(`${baseUrl.replace(/\/$/, '')}/search`);
  url.searchParams.set('q', input.query);
  url.searchParams.set('format', 'json');
  if (input.language) url.searchParams.set('language', input.language);
  const engines = asString(input.settings.engines);
  if (engines) url.searchParams.set('engines', engines);
  if (input.safeSearch) {
    url.searchParams.set('safesearch', { off: '0', moderate: '1', strict: '2' }[input.safeSearch]);
  }
  if (input.offset && input.count) {
    url.searchParams.set('pageno', String(Math.floor(input.offset / input.count) + 1));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const username = asString(input.credentials.authUsername);
  const password = asString(input.credentials.authPassword);
  if (username || password) {
    headers.Authorization = `Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')}`;
  }

  const response = await withResilience(
    () => searchFetch(url, { headers, signal: input.signal }, { guardedBefore: true }),
    { key: breakerKey('searxng', input) },
  );
  if (!response.ok) {
    throw searchFailure('SearxNG', response);
  }
  const json = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string; engine?: string; score?: number }>;
    answers?: Array<string | { answer?: string }>;
  };
  const items = (json.results ?? []).slice(0, input.count);
  const firstAnswer = (json.answers ?? [])[0];
  return {
    results: items.map((item, idx) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.content ?? '',
      position: idx + 1,
      publishedAt: item.publishedDate ?? undefined,
      source: item.engine,
      score: item.score,
    })),
    answer:
      typeof firstAnswer === 'string'
        ? firstAnswer
        : firstAnswer && typeof firstAnswer === 'object'
          ? firstAnswer.answer
          : undefined,
  };
}

// ── DuckDuckGo (keyless, best-effort HTML parse) ────────────────────────

async function callDuckDuckGo(input: DriverCallInput): Promise<AdapterCallResult> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', input.query);
  const region = input.country;
  if (region) url.searchParams.set('kl', region);
  if (input.safeSearch) {
    url.searchParams.set('kp', { off: '-2', moderate: '-1', strict: '1' }[input.safeSearch]);
  }

  const response = await withResilience(
    () =>
      searchFetch(url, {
        headers: {
          // The HTML endpoint rejects requests without a browser-like UA.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html',
        },
        signal: input.signal,
      }),
    { key: breakerKey('duckduckgo', input) },
  );
  if (!response.ok) {
    throw searchFailure('DuckDuckGo', response);
  }
  const html = await response.text();
  return { results: parseDuckDuckGoHtml(html, input.count ?? DEFAULT_RESULTS) };
}

/**
 * Extracts organic results from the html.duckduckgo.com markup. The layout is
 * intentionally simple (`result__a` anchors + `result__snippet`), but it is
 * not a stable API — treat this driver as best-effort.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const anchorRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe =
    /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/td>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/g;

  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtml(snippetMatch[1] ?? snippetMatch[2] ?? snippetMatch[3] ?? ''));
  }

  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null && results.length < limit) {
    const href = decodeDuckDuckGoHref(match[1]);
    if (!href) continue;
    results.push({
      title: stripHtml(match[2]),
      url: href,
      snippet: snippets[results.length] ?? '',
      position: results.length + 1,
    });
  }
  return results;
}

/** DDG links are redirect URLs like //duckduckgo.com/l/?uddg=<encoded>&rut=… */
function decodeDuckDuckGoHref(href: string): string | undefined {
  try {
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(normalized, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    return undefined;
  } catch {
    return undefined;
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x?\d+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The failed-search error: the HTTP status only (the upstream body is never echoed), carried as `status` so a caller
 * can tell a capacity fault from a caller-side one.
 */
function searchFailure(label: string, response: Response): Error {
  return Object.assign(new Error(`${label} search failed (${response.status})`), { status: response.status });
}

function breakerKey(driver: string, input: DriverCallInput): string {
  return input.breakerScope ? `websearch:${driver}:${input.breakerScope}` : `websearch:${driver}`;
}

export const _logger = logger;
