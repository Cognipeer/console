/**
 * Playwright-based fetcher. Spins up one chromium browser per crawl run,
 * reused across all pages, and a fresh BrowserContext so cookies/headers
 * are scoped to the crawl plan.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import mime from 'mime-types';
import { parseContentTypeBase } from './normalize';
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
        ],
      });
      this.context = await this.browser.newContext({
        userAgent: this.http.userAgent ?? DEFAULT_USER_AGENT,
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
      // Block heavy resources to speed crawls up
      await this.context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
          return route.abort().catch(() => undefined);
        }
        return route.continue().catch(() => undefined);
      });
    })();
    await this.launching;
  }

  async fetch(url: string): Promise<PlaywrightFetchResult> {
    await this.ensure();
    if (!this.context) throw new Error('Playwright context not initialized');
    const timeout = this.http.timeoutMs ?? 30_000;
    const page = await this.context.newPage();
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
