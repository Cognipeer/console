/**
 * BrowserManager
 *
 * Process-singleton that owns the Playwright `Browser` instance and a map of
 * live `BrowserContext + Page` pairs keyed by `sessionKey`.
 *
 * Responsibilities:
 *   - Lazy-launch Chromium on first use (Playwright is dynamically imported
 *     so the app boots even when the dev hasn't installed `playwright` yet).
 *   - Enforce per-tenant concurrency via the configured limiter provider.
 *   - Apply per-session allow/block list using `context.route()`.
 *   - Track idle sessions and close them when the configured idle window
 *     elapses (also enforces a hard max-lifetime).
 *   - Capture aria-ref snapshots and translate `ref` -> `Locator` for
 *     downstream actions.
 *
 * The DB persistence layer lives in `browserSessionService`; this module is
 * intentionally storage-agnostic.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { registerShutdownHandler } from '@/lib/core/lifecycle';
import {
  getConcurrencyLimiter,
  type ConcurrencyHandle,
} from './concurrency';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserExtractInput,
  BrowserExtractResult,
  BrowserPdfInput,
  BrowserScreenshotInput,
  IBrowserSessionConfig,
} from './types';

// Loose Playwright types — avoids hard build-time dependency on the package
// type bundle (we still require it at runtime).
type PwBrowser = {
  newContext(options: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
  isConnected(): boolean;
};

type PwContext = {
  newPage(): Promise<PwPage>;
  pages(): PwPage[];
  close(): Promise<void>;
  route(
    pattern: string | RegExp,
    handler: (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => unknown,
  ): Promise<void>;
};

type PwLocator = {
  click(options?: Record<string, unknown>): Promise<void>;
  hover(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  type(text: string, options?: Record<string, unknown>): Promise<void>;
  press(key: string): Promise<void>;
  innerText(): Promise<string>;
  innerHTML(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  scrollIntoViewIfNeeded(): Promise<void>;
  waitFor(options?: Record<string, unknown>): Promise<void>;
  ariaSnapshot(options?: Record<string, unknown>): Promise<string>;
  count(): Promise<number>;
  nth(index: number): PwLocator;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
};

type PwPage = {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): PwLocator;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(
    selector: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  evaluate(fn: () => unknown): Promise<unknown>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  pdf(options?: Record<string, unknown>): Promise<Buffer>;
  close(): Promise<void>;
  isClosed(): boolean;
};

const logger = createLogger('browser:manager');

interface LiveSession {
  sessionKey: string;
  tenantId: string;
  context: PwContext;
  page: PwPage;
  concurrencyHandle: ConcurrencyHandle;
  config: IBrowserSessionConfig;
  startedAt: Date;
  lastActivityAt: Date;
  /** Optional callback to persist closure side-effects (events, status). */
  onClose?: (reason: string) => Promise<void> | void;
}

class BrowserManager {
  private browserPromise: Promise<PwBrowser> | null = null;
  private sessions = new Map<string, LiveSession>();
  private reaperTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private shutdownRegistered = false;

  // ── Lifecycle ─────────────────────────────────────────────────────

  private ensureShutdownHook() {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;
    registerShutdownHandler('browser-manager', () => this.shutdown());
  }

  private startReaper() {
    if (this.reaperTimer) return;
    const intervalMs = getConfig().browser.reaperIntervalMs;
    this.reaperTimer = setInterval(() => {
      this.reapIdleSessions().catch((err) => {
        logger.error('Idle reaper failed', { error: err instanceof Error ? err.message : err });
      });
    }, intervalMs);
    // Don't keep the event loop alive solely for the reaper.
    if (typeof this.reaperTimer.unref === 'function') {
      this.reaperTimer.unref();
    }
  }

  private async getBrowser(): Promise<PwBrowser> {
    this.ensureShutdownHook();
    this.startReaper();

    if (this.browserPromise) {
      const existing = await this.browserPromise;
      if (existing.isConnected()) return existing;
      this.browserPromise = null;
    }

    this.browserPromise = (async () => {
      let chromium: { launch(opts: Record<string, unknown>): Promise<PwBrowser> };
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const playwright = await import('playwright');
        chromium = playwright.chromium as unknown as typeof chromium;
      } catch (error) {
        logger.error('Playwright is not installed. Install with `npm install playwright` and run `npx playwright install chromium`.');
        throw new Error(
          'Playwright is not installed in this environment. Install `playwright` and run `npx playwright install chromium`.',
        );
      }

      const cfg = getConfig().browser;
      logger.info('Launching Chromium', { headless: cfg.headless });
      return chromium.launch({ headless: cfg.headless });
    })();

    return this.browserPromise;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    const sessionKeys = Array.from(this.sessions.keys());
    await Promise.all(sessionKeys.map((key) => this.closeSession(key, 'shutdown').catch(() => undefined)));
    if (this.browserPromise) {
      try {
        const browser = await this.browserPromise;
        if (browser.isConnected()) await browser.close();
      } catch (err) {
        logger.warn('Browser close failed during shutdown', { error: err instanceof Error ? err.message : err });
      }
      this.browserPromise = null;
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────

  async openSession(input: {
    tenantId: string;
    sessionKey?: string;
    config?: IBrowserSessionConfig;
    onClose?: LiveSession['onClose'];
  }): Promise<{ sessionKey: string }> {
    if (this.shuttingDown) {
      throw new Error('Browser manager is shutting down');
    }

    const cfg = getConfig().browser;
    const sessionKey = input.sessionKey ?? `bs_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    if (this.sessions.has(sessionKey)) {
      return { sessionKey };
    }

    const limiter = getConcurrencyLimiter();
    const handle = await limiter.acquire(input.tenantId, { timeoutMs: 60_000 });

    try {
      const browser = await this.getBrowser();
      const sessionConfig: IBrowserSessionConfig = {
        headless: input.config?.headless ?? cfg.headless,
        viewport: input.config?.viewport ?? { width: cfg.viewportWidth, height: cfg.viewportHeight },
        userAgent: input.config?.userAgent,
        locale: input.config?.locale,
        idleTimeoutMs: input.config?.idleTimeoutMs ?? cfg.defaultIdleTimeoutMs,
        maxLifetimeMs: input.config?.maxLifetimeMs ?? cfg.defaultMaxLifetimeMs,
        access: input.config?.access,
      };

      const context = await browser.newContext({
        viewport: sessionConfig.viewport,
        userAgent: sessionConfig.userAgent,
        locale: sessionConfig.locale,
      });

      // Allow/block-list enforcement on every navigation/resource request.
      const access = sessionConfig.access;
      if (access && (access.allowList?.length || access.blockList?.length)) {
        await context.route('**/*', (route) => {
          const url = route.request().url();
          let host: string;
          try {
            host = new URL(url).hostname;
          } catch {
            return route.continue();
          }
          if (access.blockList?.some((pattern: string) => matchHost(host, pattern))) {
            return route.abort();
          }
          if (access.allowList?.length) {
            const allowed = access.allowList.some((pattern: string) => matchHost(host, pattern));
            if (!allowed) return route.abort();
          }
          return route.continue();
        });
      }

      const page = await context.newPage();

      const live: LiveSession = {
        sessionKey,
        tenantId: input.tenantId,
        context,
        page,
        concurrencyHandle: handle,
        config: sessionConfig,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        onClose: input.onClose,
      };
      this.sessions.set(sessionKey, live);
      logger.info('Session opened', { sessionKey, tenantId: input.tenantId });
      return { sessionKey };
    } catch (err) {
      handle.release();
      throw err;
    }
  }

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  async closeSession(sessionKey: string, reason: string = 'manual'): Promise<boolean> {
    const live = this.sessions.get(sessionKey);
    if (!live) return false;
    this.sessions.delete(sessionKey);

    try {
      if (!live.page.isClosed()) await live.page.close().catch(() => undefined);
      await live.context.close().catch(() => undefined);
    } finally {
      live.concurrencyHandle.release();
    }

    if (live.onClose) {
      try {
        await live.onClose(reason);
      } catch (err) {
        logger.warn('Session onClose hook failed', {
          sessionKey,
          reason,
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    logger.info('Session closed', { sessionKey, reason });
    return true;
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    const expired: Array<{ key: string; reason: string }> = [];

    for (const [key, live] of this.sessions.entries()) {
      const idleFor = now - live.lastActivityAt.getTime();
      const lifeFor = now - live.startedAt.getTime();
      const idleTimeout = live.config.idleTimeoutMs ?? Number.POSITIVE_INFINITY;
      const maxLifetime = live.config.maxLifetimeMs ?? Number.POSITIVE_INFINITY;
      if (idleFor >= idleTimeout) {
        expired.push({ key, reason: 'idle-timeout' });
      } else if (lifeFor >= maxLifetime) {
        expired.push({ key, reason: 'max-lifetime' });
      }
    }

    for (const item of expired) {
      await this.closeSession(item.key, item.reason).catch(() => undefined);
    }
  }

  // ── Action execution ──────────────────────────────────────────────

  private requireSession(sessionKey: string): LiveSession {
    const live = this.sessions.get(sessionKey);
    if (!live) {
      throw new Error(`Browser session not found or already closed: ${sessionKey}`);
    }
    live.lastActivityAt = new Date();
    return live;
  }

  private resolveLocator(live: LiveSession, ref?: string, selector?: string): PwLocator {
    if (ref) {
      // Playwright's aria-ref engine resolves the markers emitted by
      // `ariaSnapshot()` back to the original element.
      return live.page.locator(`aria-ref=${ref}`);
    }
    if (!selector) {
      throw new Error('Either `selector` or `ref` is required.');
    }
    return live.page.locator(selector);
  }

  async runAction(sessionKey: string, action: BrowserAction): Promise<BrowserActionResult> {
    const live = this.requireSession(sessionKey);

    try {
      switch (action.type) {
        case 'goto': {
          await live.page.goto(action.url, {
            waitUntil: action.waitUntil ?? 'load',
            timeout: action.timeout,
          });
          break;
        }
        case 'click': {
          const loc = this.resolveLocator(live, action.ref, action.selector);
          await loc.click({ button: action.button, timeout: action.timeout });
          break;
        }
        case 'hover': {
          const loc = this.resolveLocator(live, action.ref, action.selector);
          await loc.hover({ timeout: action.timeout });
          break;
        }
        case 'type': {
          const loc = this.resolveLocator(live, action.ref, action.selector);
          if (action.clear) {
            await loc.fill('');
          }
          await loc.type(action.text, { delay: action.delay });
          break;
        }
        case 'press': {
          const loc = this.resolveLocator(live, action.ref, action.selector);
          await loc.press(action.key);
          break;
        }
        case 'wait': {
          if (action.ms !== undefined) {
            await live.page.waitForTimeout(action.ms);
          } else if (action.selector) {
            await live.page.waitForSelector(action.selector, { state: action.state });
          }
          break;
        }
        case 'scroll': {
          if (action.selector || action.ref) {
            const loc = this.resolveLocator(live, action.ref, action.selector);
            await loc.scrollIntoViewIfNeeded();
          } else {
            const x = action.x ?? 0;
            const y = action.y ?? 0;
            await live.page.evaluate(
              new Function('return window.scrollBy(' + x + ',' + y + ')') as () => unknown,
            );
          }
          break;
        }
        default: {
          throw new Error(`Unsupported action type: ${(action as { type: string }).type}`);
        }
      }

      const ariaSnapshot = await this.captureAriaSnapshot(live).catch(() => undefined);
      return {
        ok: true,
        url: live.page.url(),
        pageTitle: await live.page.title().catch(() => undefined),
        ariaSnapshot,
      };
    } catch (err) {
      return {
        ok: false,
        url: live.page.url(),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async extract(sessionKey: string, input: BrowserExtractInput): Promise<BrowserExtractResult> {
    const live = this.requireSession(sessionKey);
    try {
      const loc = this.resolveLocator(live, input.ref, input.selector);
      const mode = input.mode ?? 'text';

      const readOne = async (target: PwLocator): Promise<string> => {
        if (mode === 'html') return target.innerHTML();
        if (mode === 'attr') {
          if (!input.attribute) {
            throw new Error('`attribute` is required when mode="attr"');
          }
          return (await target.getAttribute(input.attribute)) ?? '';
        }
        return target.innerText();
      };

      if (input.multiple) {
        const count = await loc.count();
        const values: string[] = [];
        for (let i = 0; i < count; i += 1) {
          values.push(await readOne(loc.nth(i)));
        }
        return { ok: true, values };
      }

      return { ok: true, values: [await readOne(loc)] };
    } catch (err) {
      return {
        ok: false,
        values: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async screenshot(sessionKey: string, input: BrowserScreenshotInput = {}): Promise<{ buffer: Buffer; contentType: string }> {
    const live = this.requireSession(sessionKey);
    const type = input.type ?? 'png';
    const opts: Record<string, unknown> = { type, fullPage: input.fullPage ?? false };
    if (type === 'jpeg') opts.quality = input.quality ?? 80;

    let buffer: Buffer;
    if (input.selector || input.ref) {
      const loc = this.resolveLocator(live, input.ref, input.selector);
      buffer = await loc.screenshot(opts);
    } else {
      buffer = await live.page.screenshot(opts);
    }
    return { buffer, contentType: type === 'jpeg' ? 'image/jpeg' : 'image/png' };
  }

  async pdf(sessionKey: string, input: BrowserPdfInput = {}): Promise<{ buffer: Buffer; contentType: string }> {
    const live = this.requireSession(sessionKey);
    const opts: Record<string, unknown> = {
      format: input.format ?? 'A4',
      landscape: input.landscape ?? false,
      printBackground: input.printBackground ?? true,
    };
    const buffer = await live.page.pdf(opts);
    return { buffer, contentType: 'application/pdf' };
  }

  async captureAriaSnapshot(liveOrKey: LiveSession | string): Promise<string> {
    const live = typeof liveOrKey === 'string' ? this.requireSession(liveOrKey) : liveOrKey;
    try {
      return await live.page.locator('html').ariaSnapshot({ ref: true });
    } catch {
      // Older Playwright versions may not support `ref: true`. Fall back.
      try {
        return await live.page.locator('html').ariaSnapshot();
      } catch {
        return '';
      }
    }
  }

  getLiveStatus(sessionKey: string): {
    url: string;
    pageTitle?: string;
    lastActivityAt: Date;
    startedAt: Date;
  } | null {
    const live = this.sessions.get(sessionKey);
    if (!live) return null;
    return {
      url: live.page.url(),
      lastActivityAt: live.lastActivityAt,
      startedAt: live.startedAt,
    };
  }

  listLiveSessionsForTenant(tenantId: string): string[] {
    const out: string[] = [];
    for (const [key, live] of this.sessions.entries()) {
      if (live.tenantId === tenantId) out.push(key);
    }
    return out;
  }
}

function matchHost(host: string, pattern: string): boolean {
  // Glob-ish matcher: exact, *.domain.tld, or substring.
  const lowerHost = host.toLowerCase();
  const lowerPattern = pattern.trim().toLowerCase();
  if (lowerPattern === lowerHost) return true;
  if (lowerPattern.startsWith('*.')) {
    const suffix = lowerPattern.slice(1); // ".example.com"
    return lowerHost.endsWith(suffix);
  }
  return lowerHost.includes(lowerPattern);
}

export const browserManager = new BrowserManager();
