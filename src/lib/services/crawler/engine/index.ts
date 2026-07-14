/**
 * @cognipeer/crawler – engine entry point.
 *
 * Streams PageResult objects as an AsyncIterable so callers can apply
 * backpressure (write to DB / send webhook / ingest into RAG) without
 * holding the entire result set in memory.
 *
 * No imports from the rest of the console here – the directory will be
 * lifted into a separate npm package in a future phase.
 */

import { Semaphore, retry } from './concurrency';
import { deriveAttachmentFileName, fetchWithAxios, isFileByExtension } from './axiosFetcher';
import { PlaywrightSession } from './playwrightFetcher';
import { extractLinks, extractMeta, looksLikeJsShell } from './links';
import { fileToMarkdown, htmlToMarkdown } from './markdown';
import {
  getHostname,
  isSkippableExtension,
  matchesAny,
  normalizeUrl,
} from './normalize';
import { assertSafeUrl } from './ssrf';
import {
  DEFAULT_DOWNLOADABLE_MIMES,
  type CrawlEngineDeps,
  type CrawlPlan,
  type PageResult,
} from './types';

export * from './types';

/**
 * Run a crawl. Yields one PageResult per fetched URL (HTML, file or error).
 *
 * The crawler respects:
 *   - plan.maxDepth   (capped at 3 for safety)
 *   - plan.maxPages   (0 = unlimited; counts successful HTML/file pages
 *                      only — error pages are still yielded for visibility
 *                      but do not consume the budget, so a flaky/erroring
 *                      URL can't cause fewer than maxPages real pages to
 *                      come back while reachable URLs remain in the queue)
 *   - plan.scope      (sameDomain / allowList / blockList)
 *   - deps.signal     (abort mid-crawl; in-flight pages still yield)
 *   - plan.http.maxConcurrency (default 5, capped at 16)
 */
export async function* crawl(
  plan: CrawlPlan,
  deps: CrawlEngineDeps,
): AsyncGenerator<PageResult, void, void> {
  const { logger } = deps;
  const downloadableMimes = plan.downloadableMimes?.length
    ? plan.downloadableMimes
    : DEFAULT_DOWNLOADABLE_MIMES;
  const maxDepth = Math.min(Math.max(0, Math.floor(plan.maxDepth ?? 0)), 3);
  const maxPages = Number.isFinite(plan.maxPages) && plan.maxPages > 0
    ? Math.floor(plan.maxPages)
    : 0;
  const concurrency = Math.min(
    Math.max(1, plan.http.maxConcurrency ?? 5),
    16,
  );
  const retries = Math.max(1, plan.http.retries ?? 2);

  const seeds = (plan.seeds ?? []).map(normalizeUrl).filter(Boolean);
  if (seeds.length === 0) {
    logger.warn('Crawl plan has no seeds; nothing to do');
    return;
  }

  const visited = new Set<string>();
  const semaphore = new Semaphore(concurrency);
  const session = plan.engine !== 'axios'
    ? new PlaywrightSession(plan.http, downloadableMimes)
    : null;

  // ── per-URL fetch with engine auto-selection ─────────────────────
  async function fetchOne(url: string): Promise<{
    type: 'html' | 'file';
    httpStatus: number;
    contentType: string;
    html?: string;
    htmlBytes?: number;
    fileBytes?: number;
    fileBuffer?: Buffer;
  }> {
    if (isFileByExtension(url, downloadableMimes)) {
      return retry(() => fetchWithAxios(url, plan.http, downloadableMimes, deps.signal), retries);
    }
    if (plan.engine === 'axios') {
      return retry(() => fetchWithAxios(url, plan.http, downloadableMimes, deps.signal), retries);
    }
    if (plan.engine === 'playwright') {
      if (!session) throw new Error('Playwright session unavailable');
      return retry(() => session.fetch(url, deps.signal), retries);
    }
    // auto: axios first, escalate to playwright if shell-like
    try {
      const r = await retry(
        () => fetchWithAxios(url, plan.http, downloadableMimes, deps.signal),
        retries,
      );
      if (r.type === 'html' && r.html && looksLikeJsShell(r.html)) {
        // The axios response looks like a JS-rendered shell or a bot/WAF
        // challenge interstitial (see looksLikeJsShell) — its content is
        // not the real page. Previously, if the Playwright fallback also
        // failed (browser unavailable, still-challenged, timeout, ...),
        // this silently returned the incomplete/garbage axios result as a
        // normal "successful" page — the exact cause of pages coming back
        // with wrong/incomplete content instead of being reported as
        // failed. Throw instead so the caller reports it as an error page
        // (visible in the Runs/Errors UI) rather than pretending success.
        if (!session) {
          throw new Error(
            `${url} looks JS-rendered or bot-challenged but no Playwright session is available`,
          );
        }
        try {
          return await retry(() => session.fetch(url, deps.signal), retries);
        } catch (err) {
          throw new Error(
            `Playwright fallback failed for JS-shell/challenge page ${url}: ${(err as Error).message}`,
          );
        }
      }
      return r;
    } catch (err) {
      if (!session) throw err;
      try {
        return await retry(() => session.fetch(url, deps.signal), retries);
      } catch (pwErr) {
        throw new Error(
          `All engines failed for ${url}: ${(pwErr as Error).message}`,
        );
      }
    }
  }

  // ── BFS frontier ─────────────────────────────────────────────────
  interface Frontier {
    url: string;
    depth: number;
    parent?: string;
    rootDomain: string;
  }
  const queue: Frontier[] = [];
  for (const seed of seeds) {
    queue.push({ url: seed, depth: 0, rootDomain: getHostname(seed) });
  }

  let yielded = 0;

  try {
    while (queue.length > 0) {
      if (deps.signal?.aborted) {
        logger.warn('Crawl aborted via signal');
        break;
      }
      if (maxPages > 0 && yielded >= maxPages) break;

      // Pull a batch sized by concurrency
      const batch = queue.splice(0, concurrency);
      const tasks = batch.map(async (item) => {
        if (visited.has(item.url)) return null;
        if (isSkippableExtension(item.url)) return null;
        // An in-flight batch can be up to `concurrency` (up to 16) fetches;
        // without this check a cancel/abort requested while this batch is
        // running would only be honored once every task in it settles
        // (potentially minutes later on a slow/unreachable host). Bail out
        // of not-yet-started work immediately instead.
        if (deps.signal?.aborted) return null;
        visited.add(item.url);

        // Scope checks at fetch time too (seeds may bypass extract filter)
        const host = getHostname(item.url);
        if (plan.scope.blockList && matchesAny(host, plan.scope.blockList)) {
          return null;
        }
        try {
          assertSafeUrl(item.url, plan.http.allowPrivateNetwork);
        } catch (err) {
          return errorPage(item, (err as Error).message);
        }

        await semaphore.acquire();
        try {
          const fetched = await fetchOne(item.url);
          if (fetched.type === 'file') {
            let attachmentBody: string | undefined;
            if (fetched.fileBuffer) {
              attachmentBody = await fileToMarkdown({
                buffer: fetched.fileBuffer,
                fileName: deriveAttachmentFileName(item.url, fetched.contentType),
                options: plan.markdownOptions,
              }).catch((err: unknown) => {
                logger.warn('Attachment markdown conversion failed', {
                  url: item.url,
                  error: (err as Error).message,
                });
                return undefined;
              });
            }
            return {
              url: item.url,
              parentUrl: item.parent,
              depth: item.depth,
              type: 'file' as const,
              httpStatus: fetched.httpStatus,
              contentType: fetched.contentType,
              body: attachmentBody,
              bytes: fetched.fileBytes,
              fetchedAt: new Date(),
            };
          }
          const html = fetched.html ?? '';
          const meta = extractMeta(html);
          const body = await htmlToMarkdown({
            html,
            options: plan.markdownOptions,
          });
          // Discover children only if autoCrawl and we have depth budget
          let children: string[] = [];
          if (plan.autoCrawl && maxDepth > 0 && item.depth < maxDepth) {
            children = extractLinks({
              html,
              pageUrl: item.url,
              rootDomain: item.rootDomain,
              scope: plan.scope,
              visited,
            });
          }
          const result: PageResult = {
            url: item.url,
            parentUrl: item.parent,
            depth: item.depth,
            type: 'html',
            httpStatus: fetched.httpStatus,
            contentType: fetched.contentType,
            title: meta.title || undefined,
            description: meta.description || undefined,
            body,
            bytes: fetched.htmlBytes,
            fetchedAt: new Date(),
          };
          return { result, children, item };
        } catch (err) {
          return errorPage(item, (err as Error).message);
        } finally {
          semaphore.release();
        }
      });

      const settled = await Promise.all(tasks);
      // Process every result in this batch before honoring maxPages — a
      // `return` triggered mid-loop (as soon as the Nth success was seen)
      // used to silently drop any later entries in the SAME `settled` array,
      // including error pages that had already been fetched (network cost
      // already paid) but would then vanish with no error reported anywhere.
      // Instead, finish yielding the whole batch and only stop pulling new
      // batches afterwards.
      let limitReached = false;
      for (const r of settled) {
        if (!r) continue;
        if ('result' in r) {
          yield r.result;
          yielded++;
          if (maxPages > 0 && yielded >= maxPages) {
            limitReached = true;
            continue;
          }
          for (const child of r.children) {
            if (visited.has(child)) continue;
            queue.push({
              url: child,
              depth: r.item.depth + 1,
              parent: r.item.url,
              rootDomain: r.item.rootDomain,
            });
          }
        } else {
          // Error page: still surfaced to the caller (so it shows up in the
          // run's error count / logs) but intentionally NOT counted against
          // `maxPages` — otherwise a handful of broken/blocked URLs would
          // silently shrink the number of real pages a run returns below
          // what was requested, even though more crawlable URLs remain.
          yield r;
        }
      }
      if (limitReached) return;
    }
  } finally {
    if (session) {
      await session.close();
    }
  }
}

function errorPage(
  item: { url: string; depth: number; parent?: string },
  message: string,
): PageResult {
  return {
    url: item.url,
    parentUrl: item.parent,
    depth: item.depth,
    type: 'error',
    errorMessage: message,
    fetchedAt: new Date(),
  };
}
