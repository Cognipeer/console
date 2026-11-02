/**
 * Realtime single-page fetch through a saved crawler — the engine behind the
 * agent `web_fetch` system tool.
 *
 * Runs the crawler's own plan (engine, headers/cookies/auth, markdown options)
 * for exactly one URL, persists nothing, and never follows links.
 *
 * The URL is chosen by the model, so it is confined to the hosts the crawler
 * was set up for (seed hosts + allowList, minus blockList). A crawler with
 * neither is open-web, which is only allowed when it carries no credentials —
 * otherwise a prompt-injected URL would receive the crawler's secrets.
 */

import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { createLogger } from '@/lib/core/logger';
import type { ICrawler } from '@/lib/database';
import { crawl } from './engine';
import { crawlerExtractionDeps } from './ocrExtractor';
import { getHostname, isSameOrSubdomain, matchesAny } from './engine/normalize';
import { loadCrawler, snapshotCrawlerPlan, withTenantDb } from './crawlerService';
import { snapshotToPlan } from './crawlerJobService';
import type { CrawlerContext } from './types';

const logger = createLogger('crawler:single-page');

/** Default cap on the returned body when the crawler sets no `maxBodyChars`. */
export const WEB_FETCH_MAX_CHARS = 50_000;

export interface FetchedPage {
  url: string;
  type: 'html' | 'file';
  title?: string;
  description?: string;
  httpStatus?: number;
  contentType?: string;
  content: string;
  truncated: boolean;
}

type Scoped = Pick<ICrawler, 'seeds' | 'scope' | 'http'>;

export function crawlerHasCredentials(http: ICrawler['http'] | undefined): boolean {
  if (!http) return false;
  return Boolean(
    http.sealed
    || http.bearerToken
    || http.basicAuth
    || http.cookies?.length
    || (http.headers && Object.keys(http.headers).length > 0),
  );
}

/** Whether the crawler pins the agent to specific hosts (seeds or allowList). */
export function crawlerHasHostScope(crawler: Pick<Scoped, 'seeds' | 'scope'>): boolean {
  return (crawler.scope?.allowList?.length ?? 0) > 0 || (crawler.seeds?.length ?? 0) > 0;
}

/** Returns the refusal reason, or null when the crawler may fetch `url`. */
export function refuseCrawlerUrl(crawler: Scoped, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http(s) URLs can be fetched';
  }
  const host = parsed.hostname.toLowerCase();
  const { allowList, blockList, includeSubdomains } = crawler.scope ?? {};
  if (blockList && matchesAny(host, blockList)) return `Host "${host}" is blocked for this crawler`;

  if (!crawlerHasHostScope(crawler)) {
    return crawlerHasCredentials(crawler.http)
      ? 'This crawler has credentials but no seed URLs or allow list, so it cannot fetch arbitrary URLs'
      : null;
  }
  const allowed = matchesAny(host, allowList)
    || (crawler.seeds ?? []).some((seed) => isSameOrSubdomain(host, getHostname(seed), Boolean(includeSubdomains)));
  return allowed ? null : `Host "${host}" is outside this crawler's seed hosts and allow list`;
}

export async function fetchPageWithCrawler(
  ctx: CrawlerContext,
  crawlerKey: string,
  url: string,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  await assertServiceEnabled({ tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId }, 'crawler');
  const db = await withTenantDb(ctx.tenantDbName);
  const crawler = await loadCrawler(db, ctx, crawlerKey);
  if (!crawler) throw new Error(`Crawler "${crawlerKey}" not found`);
  if (crawler.status !== 'active') throw new Error(`Crawler "${crawler.key}" is not active`);

  const refusal = refuseCrawlerUrl(crawler, url);
  if (refusal) throw new Error(refusal);

  const plan = {
    ...snapshotToPlan(snapshotCrawlerPlan(crawler, { seeds: [url] })),
    maxDepth: 0,
    maxPages: 1,
    autoCrawl: false,
  };

  for await (const page of crawl(plan, {
    logger,
    signal,
    // An agent is waiting on this page: the inline OCR budget applies.
    ...crawlerExtractionDeps(ctx, plan.markdownOptions, 'inline'),
  })) {
    if (page.type === 'error') throw new Error(page.errorMessage ?? 'Fetch failed');
    const cap = (plan.markdownOptions?.maxBodyChars ?? 0) > 0
      ? plan.markdownOptions!.maxBodyChars!
      : WEB_FETCH_MAX_CHARS;
    const body = page.body ?? '';
    return {
      url: page.url,
      type: page.type,
      title: page.title,
      description: page.description,
      httpStatus: page.httpStatus,
      contentType: page.contentType,
      content: body.slice(0, cap),
      truncated: body.length > cap,
    };
  }
  throw new Error('The page was skipped (blocked host, unsupported file type or cancelled)');
}
