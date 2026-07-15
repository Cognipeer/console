/**
 * Playwright-based fetcher. Spins up one chromium browser per crawl run,
 * reused across all pages, and a fresh BrowserContext so cookies/headers
 * are scoped to the crawl plan.
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright';
import mime from 'mime-types';
import { looksLikeJsShell } from './links';
import { parseContentTypeBase } from './normalize';
import { assertSafeUrl } from './ssrf';
import type { CrawlHttpConfig } from './types';
import { DEFAULT_ACCEPT_LANGUAGE, DEFAULT_USER_AGENT } from './types';

// Matches the axios fetcher's cap so a single huge attachment can't blow up
// memory when harvested through the browser download path.
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

// Interstitial JS-challenge handling (F5/Shape "TSPD" BIG-IP, Akamai, DDoS-
// Guard, …). These vendors answer the first request with a 200 whose body is
// an obfuscated script that computes a cookie and then RELOADS the page; only
// the second request (carrying that cookie) returns the real content. A single
// navigation therefore captures the challenge page, not the site. When the
// rendered HTML still looks like a challenge we wait for the script to set its
// cookie, then reload IN THE SAME CONTEXT (cookies persist) and re-capture,
// a few times, before giving up.
const CHALLENGE_MAX_RELOADS = 3;
const CHALLENGE_COOKIE_WAIT_MS = 3500;

export interface PlaywrightFetchResult {
  type: 'html' | 'file';
  httpStatus: number;
  contentType: string;
  html?: string;
  htmlBytes?: number;
  fileBytes?: number;
  /** Raw bytes of a downloaded attachment. Present when `type === 'file'`. */
  fileBuffer?: Buffer;
}

export class PlaywrightSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<void> | null = null;

  constructor(
    private readonly http: CrawlHttpConfig,
    private readonly downloadableMimes: string[],
  ) {}

  private async ensure(): Promise<void> {
    if (this.context) return;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          // Vanilla headless Chromium is trivially fingerprinted by common
          // WAF/anti-bot vendors (Cloudflare, Akamai, DataDome, ...), which
          // then serve a 200-status "checking your browser" / challenge page
          // instead of the real content — this is by far the most common
          // reason a page crawls fine locally (residential IP, real Chrome)
          // but comes back wrong from production (datacenter IP, headless
          // flag detectable). This flag removes the most obvious tell
          // (the automation-controlled infobar / `--enable-automation`
          // behavior bundled into the default launch flags).
          '--disable-blink-features=AutomationControlled',
        ],
      });
      this.context = await this.browser.newContext({
        userAgent: this.http.userAgent ?? DEFAULT_USER_AGENT,
        locale: this.http.acceptLanguage?.split(',')[0]?.trim() || 'tr-TR',
        extraHTTPHeaders: {
          'Accept-Language': this.http.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE,
          ...(this.http.headers ?? {}),
          ...(this.http.bearerToken
            ? { Authorization: `Bearer ${this.http.bearerToken}` }
            : {}),
        },
        httpCredentials: this.http.basicAuth,
        ignoreHTTPSErrors: this.http.allowInsecureTls ?? false,
      });
      // Patch the most commonly-checked automation fingerprints before any
      // page script runs. `navigator.webdriver` in particular is the single
      // most widely used signal bot-detection scripts read to distinguish
      // Playwright/Puppeteer from a real browser.
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // Chromium in headless mode omits `Notification`/`chrome` runtime
        // globals a normal Chrome install always has.
        (window as unknown as { chrome?: unknown }).chrome = { runtime: {} };
      });
      if (this.http.cookies?.length) {
        await this.context.addCookies(
          this.http.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path ?? '/',
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expires: c.expires,
            // Playwright requires either domain or url
            url: c.domain ? undefined : undefined,
          })) as Parameters<BrowserContext['addCookies']>[0],
        );
      }
      // Block heavy resources to speed crawls up, and re-validate every
      // navigation (including server redirects and client-side location
      // changes) against the SSRF guard: Chromium follows redirect chains
      // itself, so the original URL passing `assertSafeUrl()` in the caller
      // is not enough — a public seed can 3xx straight to a private/
      // metadata host and the browser would navigate there transparently.
      await this.context.route('**/*', (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          try {
            assertSafeUrl(request.url(), this.http.allowPrivateNetwork);
          } catch {
            return route.abort('blockedbyclient').catch(() => undefined);
          }
        }
        const type = request.resourceType();
        // Stylesheets are intentionally NOT blocked (despite being "heavy"):
        // a real browser always requests its page's CSS, and some anti-bot
        // checks flag the request pattern of a client that never fetches any
        // stylesheet as automated traffic. Images/media/fonts stay blocked —
        // they don't affect extracted text content and blocking them is a
        // much weaker bot signal (many real browsers also skip fonts/media
        // when e.g. data-saver mode is on).
        if (['image', 'media', 'font'].includes(type)) {
          return route.abort().catch(() => undefined);
        }
        return route.continue().catch(() => undefined);
      });
    })();
    await this.launching;
  }

  async fetch(url: string, signal?: AbortSignal): Promise<PlaywrightFetchResult> {
    await this.ensure();
    if (!this.context) throw new Error('Playwright context not initialized');
    if (signal?.aborted) throw new Error(`Fetch aborted for ${url}`);
    const timeout = this.http.timeoutMs ?? 30_000;
    const page = await this.context.newPage();
    // Playwright has no native AbortSignal support: closing the page while
    // `page.goto()` is in flight is what makes an external cancel actually
    // interrupt a stuck/slow navigation immediately, instead of blocking the
    // whole crawl batch (and the job's "Cancel" button) until the full
    // navigation `timeout` elapses.
    const onExternalAbort = () => {
      page.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', onExternalAbort);
    // Some attachment endpoints (e.g. `/EkGetir/…` on bddk.org.tr) respond with
    // `Content-Disposition: attachment` and no renderable document, so Chromium
    // starts a download instead of navigating and `page.goto()` rejects with
    // "Download is starting". Arm a download waiter BEFORE navigating so the
    // event can't fire before we're listening; if goto fails that way we
    // harvest the file instead of reporting the page as a hard failure. The
    // browser path also succeeds where axios can't: sites that ship an
    // incomplete TLS chain (missing intermediate) are fetched fine here because
    // Chromium completes the chain via AIA — with verification still on.
    const downloadWaiter = page
      .waitForEvent('download', { timeout })
      .catch(() => null);
    try {
      let response;
      try {
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
      } catch (err) {
        if (isDownloadStartError(err)) {
          const download = await downloadWaiter;
          if (download) {
            return await this.harvestDownload(download, url);
          }
        }
        throw err;
      }
      if (!response) throw new Error('No response received');
      const status = response.status();
      if (status >= 400) throw new Error(`HTTP ${status}`);

      const headers = response.headers();
      const contentType = parseContentTypeBase(headers['content-type']);
      const disposition = String(headers['content-disposition'] ?? '').toLowerCase();

      const isFile =
        disposition.includes('attachment') ||
        disposition.includes('filename') ||
        (contentType && !contentType.includes('text/html')) ||
        (contentType && this.downloadableMimes.includes(contentType));

      if (isFile) {
        let fileBytes = 0;
        let fileBuffer: Buffer | undefined;
        try {
          const buf = await response.body();
          fileBytes = buf.length;
          fileBuffer = buf;
        } catch { /* ignore */ }
        return {
          type: 'file',
          httpStatus: status,
          contentType: contentType || mime.lookup(url) || 'application/octet-stream',
          fileBytes,
          fileBuffer,
        };
      }

      let html = await this.settleAndCapture(page, timeout);
      // Beat interstitial JS challenges: if the rendered page still looks like
      // a bot-check/SPA shell, the challenge script has (by now) run and set
      // its cookie in this context — reload so the server serves the real page,
      // then re-capture. Bounded so a genuinely-blocked page (hard CAPTCHA)
      // can't loop forever.
      for (let reload = 0; reload < CHALLENGE_MAX_RELOADS && looksLikeJsShell(html); reload += 1) {
        if (signal?.aborted) break;
        // Give the challenge JS time to finish computing + persisting its
        // cookie before we re-request with it.
        await page.waitForTimeout(CHALLENGE_COOKIE_WAIT_MS);
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout });
        } catch {
          break; // navigation failed/closed — keep whatever we last captured
        }
        html = await this.settleAndCapture(page, timeout);
      }
      return {
        type: 'html',
        httpStatus: status,
        contentType: contentType || 'text/html',
        html,
        htmlBytes: Buffer.byteLength(html, 'utf8'),
      };
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Let a rendered page settle (network-idle + bounded lazy-load scroll) and
   * return its final HTML. Shared by the initial navigation and each
   * challenge-reload attempt. All waits are bounded so a hung page can never
   * block the crawl batch (or the job's Cancel button).
   */
  private async settleAndCapture(page: Page, timeout: number): Promise<string> {
    // SPA pages (Angular/React) often render their real content well after
    // `domcontentloaded` — the initial HTML is just a shell/title. Give the
    // page a chance to go network-idle (bounded, since some sites keep a
    // long-lived connection open for polling/websockets) before falling
    // back to a short settle window either way.
    try {
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 8000) });
    } catch {
      // Timed out waiting for network idle (long-poll/websocket/etc.) —
      // capture whatever has rendered so far rather than failing the page.
    }
    // Many sites lazy-load content (article body chunks, images, infinite
    // scroll feeds) only once the user scrolls into view — reading the DOM
    // immediately after network-idle can silently miss that content,
    // yielding a page whose body looks "successful" but is incomplete.
    // Scroll to the bottom in bounded steps to trigger it before capturing
    // the final HTML (best-effort: failures here must not fail the page).
    // `page.evaluate()` has NO built-in timeout in Playwright (unlike
    // `goto`/`waitForLoadState`) — if the in-page script ever hangs (e.g.
    // an exception thrown asynchronously inside the setInterval callback
    // below, which would otherwise never resolve/reject the wrapping
    // Promise), this would block the fetch — and therefore the whole
    // crawl batch and the job's "Cancel" button — forever. Race it
    // against a hard timeout so that can never happen.
    try {
      await Promise.race([
        page.evaluate(async () => {
          await new Promise<void>((resolve) => {
            const step = 800;
            const maxScroll = 20_000; // cap total scroll distance
            let total = 0;
            const timer = setInterval(() => {
              try {
                window.scrollBy(0, step);
                total += step;
                if (total >= document.body.scrollHeight || total >= maxScroll) {
                  clearInterval(timer);
                  resolve();
                }
              } catch {
                // e.g. page mid-navigation/closed — stop instead of
                // leaving the interval (and this Promise) dangling.
                clearInterval(timer);
                resolve();
              }
            }, 100);
          });
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('scroll timed out')), 5000)),
      ]);
      await page.waitForTimeout(300);
    } catch {
      // best-effort only — page may have navigated away/closed, or the
      // 5s guard above tripped; either way, capture whatever HTML exists.
    }
    await page.waitForTimeout(500);
    return page.content();
  }

  /**
   * Read a browser-triggered download into a file result. Uses the on-disk
   * temp path Playwright already wrote (auto-removed when the context closes)
   * and streams it so an oversized attachment is rejected instead of buffered
   * whole.
   */
  private async harvestDownload(
    download: Download,
    url: string,
  ): Promise<PlaywrightFetchResult> {
    const filePath = await download.path();
    if (!filePath) {
      throw new Error(`Download for ${url} produced no file`);
    }
    const { size } = await fs.stat(filePath);
    if (size > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `Download for ${url} is ${size} bytes, exceeds ${MAX_DOWNLOAD_BYTES} limit`,
      );
    }
    const fileBuffer = await readFileToBuffer(filePath);
    const suggested = download.suggestedFilename();
    const contentType =
      (suggested ? String(mime.lookup(suggested) || '') : '') ||
      String(mime.lookup(url) || '') ||
      'application/octet-stream';
    return {
      type: 'file',
      httpStatus: 200,
      contentType,
      fileBytes: fileBuffer.length,
      fileBuffer,
    };
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch { /* ignore */ }
    try {
      await this.browser?.close();
    } catch { /* ignore */ }
    this.context = null;
    this.browser = null;
  }
}

/** True when a `page.goto()` rejection was caused by the navigation turning
 * into a file download rather than a real navigation failure. */
function isDownloadStartError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Download is starting');
}

function readFileToBuffer(filePath: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
