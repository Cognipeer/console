/**
 * Playwright-based fetcher. Spins up one chromium browser per crawl run,
 * reused across all pages, and a fresh BrowserContext so cookies/headers
 * are scoped to the crawl plan.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import mime from 'mime-types';
import { parseContentTypeBase } from './normalize';
import { assertSafeUrl } from './ssrf';
import type { CrawlHttpConfig } from './types';
import { DEFAULT_ACCEPT_LANGUAGE, DEFAULT_USER_AGENT } from './types';

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
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
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
      await page.waitForTimeout(500);
      const html = await page.content();
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
