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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  close(): Promise<void>;
  isClosed(): boolean;
};

const logger = createLogger('browser:manager');
const HOST_SECURITY_CACHE_TTL_MS = 5 * 60 * 1000;
/** How long to wait for an aria `ref` before falling back to a CSS selector. */
const REF_PROBE_TIMEOUT_MS = 2_000;
const hostSecurityCache = new Map<string, { privateNetwork: boolean; expiresAt: number }>();

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
  private reaperPaused = false;
  private lastReaperStartedAt: Date | null = null;
  private lastReaperCompletedAt: Date | null = null;
  private lastReaperDurationMs: number | null = null;
  private lastReaperError: string | null = null;
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
      this.runReaperCycle('timer').catch((err) => {
        logger.error('Idle reaper failed', { error: err instanceof Error ? err.message : err });
      });
    }, intervalMs);
    // Don't keep the event loop alive solely for the reaper.
    if (typeof this.reaperTimer.unref === 'function') {
      this.reaperTimer.unref();
    }
  }

  private async runReaperCycle(trigger: 'manual' | 'timer'): Promise<number> {
    if (this.reaperPaused && trigger !== 'manual') {
      return 0;
    }

    const startedAt = new Date();
    this.lastReaperStartedAt = startedAt;

    try {
      const closedCount = await this.reapIdleSessions();
      this.lastReaperCompletedAt = new Date();
      this.lastReaperDurationMs = this.lastReaperCompletedAt.getTime() - startedAt.getTime();
      this.lastReaperError = null;
      return closedCount;
    } catch (err) {
      this.lastReaperCompletedAt = new Date();
      this.lastReaperDurationMs = this.lastReaperCompletedAt.getTime() - startedAt.getTime();
      this.lastReaperError = err instanceof Error ? err.message : String(err);
      throw err;
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
        const playwright = await import('playwright');
        chromium = playwright.chromium as unknown as typeof chromium;
      } catch {
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
        actionTimeoutMs: input.config?.actionTimeoutMs ?? cfg.defaultActionTimeoutMs,
        navigationTimeoutMs: input.config?.navigationTimeoutMs ?? cfg.defaultNavigationTimeoutMs,
        access: input.config?.access,
      };

      const context = await browser.newContext({
        viewport: sessionConfig.viewport,
        userAgent: sessionConfig.userAgent,
        locale: sessionConfig.locale,
      });

      // Allow/block-list and egress enforcement on every navigation/resource request.
      const access = sessionConfig.access;
      const blockPrivateNetwork = cfg.blockPrivateNetwork;
      if (blockPrivateNetwork || access?.allowList?.length || access?.blockList?.length) {
        await context.route('**/*', async (route) => {
          const url = route.request().url();
          const decision = await evaluateBrowserRequestAccess(url, access, {
            blockPrivateNetwork,
          });
          if (!decision.allowed) {
            logger.debug('Browser request blocked by egress policy', {
              reason: decision.reason,
              urlHost: getSafeUrlHost(url),
            });
            return route.abort();
          }
          return route.continue();
        });
      }

      const page = await context.newPage();

      // Bound every action/navigation so a stale element or a never-settling
      // page fails fast instead of blocking for Playwright's 30s default.
      page.setDefaultTimeout(sessionConfig.actionTimeoutMs ?? cfg.defaultActionTimeoutMs);
      page.setDefaultNavigationTimeout(
        sessionConfig.navigationTimeoutMs ?? cfg.defaultNavigationTimeoutMs,
      );

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

  private async reapIdleSessions(): Promise<number> {
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

    return expired.length;
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

  private async resolveLocator(
    live: LiveSession,
    ref?: string,
    selector?: string,
  ): Promise<PwLocator> {
    // An aria `ref` is bound to the *last* `ariaSnapshot()`. If the page has
    // navigated or mutated since, the ref is stale and any action against it
    // would auto-wait for the full action timeout before failing. When a CSS
    // `selector` is also supplied we probe the ref briefly and fall back to the
    // selector instead of blocking — this is the common "click waits forever"
    // case where a once-valid ref no longer matches anything.
    if (ref && selector) {
      const byRef = live.page.locator(`aria-ref=${ref}`);
      try {
        await byRef.waitFor({ state: 'attached', timeout: REF_PROBE_TIMEOUT_MS });
        return byRef;
      } catch {
        return live.page.locator(selector);
      }
    }
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
          const decision = await evaluateBrowserRequestAccess(action.url, live.config.access, {
            blockPrivateNetwork: getConfig().browser.blockPrivateNetwork,
            requireHttp: true,
          });
          if (!decision.allowed) {
            throw new Error(decision.reason ?? 'Browser navigation blocked by egress policy');
          }
          await live.page.goto(action.url, {
            waitUntil: action.waitUntil ?? 'load',
            timeout: action.timeout,
          });
          break;
        }
        case 'click': {
          const loc = await this.resolveLocator(live, action.ref, action.selector);
          await loc.click({ button: action.button, timeout: action.timeout });
          break;
        }
        case 'hover': {
          const loc = await this.resolveLocator(live, action.ref, action.selector);
          await loc.hover({ timeout: action.timeout });
          break;
        }
        case 'type': {
          const loc = await this.resolveLocator(live, action.ref, action.selector);
          if (action.clear) {
            await loc.fill('');
          }
          await loc.type(action.text, { delay: action.delay });
          break;
        }
        case 'press': {
          const loc = await this.resolveLocator(live, action.ref, action.selector);
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
            const loc = await this.resolveLocator(live, action.ref, action.selector);
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
      const loc = await this.resolveLocator(live, input.ref, input.selector);
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
      const loc = await this.resolveLocator(live, input.ref, input.selector);
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
    // Bound the snapshot so it can't stall the action result on a page that
    // never settles. `setDefaultTimeout` covers it, but be explicit here since
    // this runs after every action.
    const timeout = live.config.actionTimeoutMs ?? getConfig().browser.defaultActionTimeoutMs;
    try {
      return await live.page.locator('html').ariaSnapshot({ ref: true, timeout });
    } catch {
      // Older Playwright versions may not support `ref: true`. Fall back.
      try {
        return await live.page.locator('html').ariaSnapshot({ timeout });
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

  pauseReaper(): void {
    this.reaperPaused = true;
  }

  resumeReaper(): void {
    this.reaperPaused = false;
  }

  async triggerReaper(): Promise<{ closedCount: number }> {
    return { closedCount: await this.runReaperCycle('manual') };
  }

  getRuntimeStats(): {
    browserConnected: boolean;
    liveSessions: number;
    reaper: {
      intervalMs: number;
      lastCompletedAt: Date | null;
      lastDurationMs: number | null;
      lastError: string | null;
      lastStartedAt: Date | null;
      paused: boolean;
    };
    shuttingDown: boolean;
  } {
    return {
      browserConnected: this.browserPromise !== null,
      liveSessions: this.sessions.size,
      reaper: {
        intervalMs: getConfig().browser.reaperIntervalMs,
        lastCompletedAt: this.lastReaperCompletedAt,
        lastDurationMs: this.lastReaperDurationMs,
        lastError: this.lastReaperError,
        lastStartedAt: this.lastReaperStartedAt,
        paused: this.reaperPaused,
      },
      shuttingDown: this.shuttingDown,
    };
  }
}

async function evaluateBrowserRequestAccess(
  rawUrl: string,
  access: IBrowserSessionConfig['access'],
  options: { blockPrivateNetwork: boolean; requireHttp?: boolean },
): Promise<{ allowed: boolean; reason?: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'Invalid browser URL' };
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    if (!options.requireHttp && (protocol === 'about:' || protocol === 'data:' || protocol === 'blob:')) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Browser protocol is not allowed: ${protocol}` };
  }

  const host = normalizeHost(url.hostname);
  if (!host) {
    return { allowed: false, reason: 'Browser URL is missing a host' };
  }

  if (access?.blockList?.some((pattern: string) => matchHost(host, pattern))) {
    return { allowed: false, reason: 'Browser host is blocked by session policy' };
  }

  if (access?.allowList?.length) {
    const allowed = access.allowList.some((pattern: string) => matchHost(host, pattern));
    if (!allowed) {
      return { allowed: false, reason: 'Browser host is not allowed by session policy' };
    }
  }

  if (options.blockPrivateNetwork && await resolvesToPrivateNetwork(host)) {
    return { allowed: false, reason: 'Browser private-network egress is blocked' };
  }

  return { allowed: true };
}

function getSafeUrlHost(rawUrl: string): string | undefined {
  try {
    return normalizeHost(new URL(rawUrl).hostname);
  } catch {
    return undefined;
  }
}

function normalizeHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
}

function isLocalHostname(host: string): boolean {
  return (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host === 'localhost.localdomain'
    || host.endsWith('.local')
    || host.endsWith('.internal')
  );
}

async function resolvesToPrivateNetwork(host: string): Promise<boolean> {
  if (isLocalHostname(host)) {
    return true;
  }

  if (isIP(host)) {
    return isPrivateIpAddress(host);
  }

  const cached = hostSecurityCache.get(host);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.privateNetwork;
  }

  let privateNetwork = true;
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    privateNetwork = records.some((record) => isPrivateIpAddress(record.address));
  } catch {
    privateNetwork = true;
  }

  hostSecurityCache.set(host, {
    privateNetwork,
    expiresAt: Date.now() + HOST_SECURITY_CACHE_TTL_MS,
  });

  return privateNetwork;
}

function isPrivateIpAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map((part) => Number(part));
    const [a, b] = parts;
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }

    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }

  if (family === 6) {
    const normalized = ip.toLowerCase();
    const firstGroup = Number.parseInt(normalized.split(':')[0] || '0', 16);
    if (normalized.startsWith('::ffff:')) {
      return isPrivateIpAddress(normalized.slice('::ffff:'.length));
    }

    return (
      normalized === '::'
      || normalized === '::1'
      || (Number.isFinite(firstGroup) && (firstGroup & 0xfe00) === 0xfc00)
      || (Number.isFinite(firstGroup) && (firstGroup & 0xffc0) === 0xfe80)
    );
  }

  return true;
}

function matchHost(host: string, pattern: string): boolean {
  const lowerHost = host.toLowerCase();
  const lowerPattern = pattern.trim().toLowerCase();
  if (!lowerPattern) return false;
  if (lowerPattern === '*') return true;
  if (lowerPattern === lowerHost) return true;
  if (lowerPattern.startsWith('*.')) {
    const suffix = lowerPattern.slice(1); // ".example.com"
    return lowerHost.endsWith(suffix);
  }
  if (lowerPattern.includes('*')) {
    const escaped = lowerPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
    return regex.test(lowerHost);
  }
  return lowerHost.endsWith(`.${lowerPattern}`);
}

export const browserManager = new BrowserManager();
