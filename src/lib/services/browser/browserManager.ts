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
  BrowserObservations,
  BrowserPdfInput,
  BrowserScreenshotInput,
  BrowserTarget,
  BrowserTargetStrategy,
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
  storageState(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, handler: (arg: never) => unknown): void;
  route(
    pattern: string | RegExp,
    handler: (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => unknown,
  ): Promise<void>;
};

type PwLocator = {
  click(options?: Record<string, unknown>): Promise<void>;
  dblclick(options?: Record<string, unknown>): Promise<void>;
  hover(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  type(text: string, options?: Record<string, unknown>): Promise<void>;
  press(key: string): Promise<void>;
  check(options?: Record<string, unknown>): Promise<void>;
  uncheck(options?: Record<string, unknown>): Promise<void>;
  selectOption(values: unknown, options?: Record<string, unknown>): Promise<string[]>;
  setInputFiles(files: unknown, options?: Record<string, unknown>): Promise<void>;
  dragTo(target: PwLocator, options?: Record<string, unknown>): Promise<void>;
  innerText(): Promise<string>;
  innerHTML(): Promise<string>;
  inputValue(options?: Record<string, unknown>): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  scrollIntoViewIfNeeded(options?: Record<string, unknown>): Promise<void>;
  waitFor(options?: Record<string, unknown>): Promise<void>;
  ariaSnapshot(options?: Record<string, unknown>): Promise<string>;
  count(): Promise<number>;
  first(): PwLocator;
  nth(index: number): PwLocator;
  filter(options: Record<string, unknown>): PwLocator;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
};

/** The locator-building surface shared by `Page` and `FrameLocator`. */
type PwLocatorRoot = {
  locator(selector: string, options?: Record<string, unknown>): PwLocator;
  getByRole(role: string, options?: Record<string, unknown>): PwLocator;
  getByTestId(testId: string): PwLocator;
  getByLabel(text: string | RegExp, options?: Record<string, unknown>): PwLocator;
  getByPlaceholder(text: string | RegExp, options?: Record<string, unknown>): PwLocator;
  getByText(text: string | RegExp, options?: Record<string, unknown>): PwLocator;
  frameLocator(selector: string): PwLocatorRoot;
};

type PwPage = PwLocatorRoot & {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  goBack(options?: Record<string, unknown>): Promise<unknown>;
  goForward(options?: Record<string, unknown>): Promise<unknown>;
  reload(options?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(
    selector: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  waitForLoadState(state?: string, options?: Record<string, unknown>): Promise<void>;
  evaluate<TArg = unknown>(fn: string | ((arg: TArg) => unknown), arg?: TArg): Promise<unknown>;
  keyboard: { press(key: string, options?: Record<string, unknown>): Promise<void> };
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  pdf(options?: Record<string, unknown>): Promise<Buffer>;
  setDefaultTimeout(ms: number): void;
  setDefaultNavigationTimeout(ms: number): void;
  on(event: string, handler: (arg: never) => unknown): void;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
};

const logger = createLogger('browser:manager');
const HOST_SECURITY_CACHE_TTL_MS = 5 * 60 * 1000;
/** How long to wait for an aria `ref` before falling back to a durable strategy. */
const REF_PROBE_TIMEOUT_MS = 2_000;
/** Per-session ring buffer size for console messages and failed requests. */
const OBSERVATION_BUFFER = 200;
const hostSecurityCache = new Map<string, { privateNetwork: boolean; expiresAt: number }>();

/**
 * One node of the last aria snapshot, keyed by its `[ref=…]` marker.
 *
 * Refs are VOLATILE — Playwright renumbers them on every snapshot, so a ref
 * is only meaningful until the next `captureAriaSnapshot`. The `role`/`name`
 * pair carried alongside is the DURABLE form, and it is what a recorded flow
 * step persists: `getByRole('button', { name: 'Sign in' })` survives the
 * renumbering, a re-render and, usually, a deploy.
 */
interface AriaRefNode {
  role: string;
  name?: string;
  /** Index among nodes sharing the same role+name, in document order. */
  nth: number;
  /** True when role+name is ambiguous and `nth` is load-bearing. */
  ambiguous: boolean;
}

/** Injected by `browserSessionService` — see `setUploadResolver`. */
type UploadResolver = (
  ctx: { tenantDbName: string; tenantId: string; projectId?: string },
  fileIds: string[],
) => Promise<Array<{ name: string; mimeType: string; buffer: Buffer }>>;

interface ConsoleRecord {
  type: string;
  text: string;
  at: Date;
}

interface NetworkFailureRecord {
  url: string;
  method?: string;
  failure?: string;
  at: Date;
}

interface LiveSession {
  sessionKey: string;
  tenantId: string;
  /** Carried so injected resolvers (file uploads) can reach tenant storage. */
  tenantDbName?: string;
  projectId?: string;
  context: PwContext;
  /** Every page in the context, in open order. Index 0 is the original tab. */
  pages: PwPage[];
  /** Index into `pages` that actions address. */
  activeIndex: number;
  concurrencyHandle: ConcurrencyHandle;
  config: IBrowserSessionConfig;
  startedAt: Date;
  lastActivityAt: Date;
  /** ref -> durable descriptor, rebuilt on every `captureAriaSnapshot`. */
  refIndex: Map<string, AriaRefNode>;
  console: ConsoleRecord[];
  networkFailures: NetworkFailureRecord[];
  /** Last dialog the page raised, after the configured policy answered it. */
  lastDialog?: { type: string; message: string; action: 'accept' | 'dismiss'; at: Date };
  /** Optional callback to persist closure side-effects (events, status). */
  onClose?: (reason: string) => Promise<void> | void;
}

class BrowserManager {
  private browserPromise: Promise<PwBrowser> | null = null;
  private sessions = new Map<string, LiveSession>();
  private uploadResolver?: UploadResolver;
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
      return chromium.launch({
        headless: cfg.headless,
        // Chromium's own setuid/user-namespace sandbox needs privileges that
        // restricted container runtimes (OpenShift SCC, non-root + all caps
        // dropped) don't grant — without these flags launch() hangs until
        // Playwright's own timeout fires. --disable-dev-shm-usage works
        // around the default 64MB /dev/shm in containers, which otherwise
        // crashes the renderer. Matches the crawler's playwrightFetcher.ts.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
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
    tenantDbName?: string;
    projectId?: string;
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
        timezoneId: input.config?.timezoneId,
        idleTimeoutMs: input.config?.idleTimeoutMs ?? cfg.defaultIdleTimeoutMs,
        maxLifetimeMs: input.config?.maxLifetimeMs ?? cfg.defaultMaxLifetimeMs,
        actionTimeoutMs: input.config?.actionTimeoutMs ?? cfg.defaultActionTimeoutMs,
        navigationTimeoutMs: input.config?.navigationTimeoutMs ?? cfg.defaultNavigationTimeoutMs,
        access: input.config?.access,
        proxy: input.config?.proxy,
        extraHTTPHeaders: input.config?.extraHTTPHeaders,
        httpCredentials: input.config?.httpCredentials,
        acceptDownloads: input.config?.acceptDownloads,
        ignoreHTTPSErrors: input.config?.ignoreHTTPSErrors,
        dialogPolicy: input.config?.dialogPolicy ?? 'dismiss',
        storageState: input.config?.storageState,
      };

      const contextOptions: Record<string, unknown> = {
        viewport: sessionConfig.viewport,
        userAgent: sessionConfig.userAgent,
        locale: sessionConfig.locale,
        // Downloads are OFF unless asked for: an automated browser that
        // accepts files by default is an ingest path nobody scanned.
        acceptDownloads: sessionConfig.acceptDownloads ?? false,
      };
      if (sessionConfig.timezoneId) contextOptions.timezoneId = sessionConfig.timezoneId;
      if (sessionConfig.proxy?.server) contextOptions.proxy = sessionConfig.proxy;
      if (sessionConfig.extraHTTPHeaders) {
        contextOptions.extraHTTPHeaders = sessionConfig.extraHTTPHeaders;
      }
      if (sessionConfig.httpCredentials?.username) {
        contextOptions.httpCredentials = sessionConfig.httpCredentials;
      }
      if (sessionConfig.ignoreHTTPSErrors) contextOptions.ignoreHTTPSErrors = true;
      // Replaying a signed-in session: cookies + origin storage exported by a
      // previous session, so a scheduled flow starts authenticated instead of
      // pushing credentials through a login form on every run.
      if (sessionConfig.storageState) contextOptions.storageState = sessionConfig.storageState;

      const context = await browser.newContext(contextOptions);

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
        tenantDbName: input.tenantDbName,
        projectId: input.projectId,
        context,
        pages: [page],
        activeIndex: 0,
        concurrencyHandle: handle,
        config: sessionConfig,
        startedAt: new Date(),
        lastActivityAt: new Date(),
        refIndex: new Map(),
        console: [],
        networkFailures: [],
        onClose: input.onClose,
      };
      this.instrumentPage(live, page);

      // A `target="_blank"` link, an OAuth popup, a `window.open` — the
      // context opens the page whether or not we are watching, and a session
      // that only knows its first tab goes blind exactly there. Adopt it, and
      // make it active, because a popup is almost always where the flow
      // continues.
      context.on('page', (opened: PwPage) => {
        if (live.pages.includes(opened)) return;
        opened.setDefaultTimeout(sessionConfig.actionTimeoutMs ?? cfg.defaultActionTimeoutMs);
        opened.setDefaultNavigationTimeout(
          sessionConfig.navigationTimeoutMs ?? cfg.defaultNavigationTimeoutMs,
        );
        this.adoptPage(live, opened);
        live.activeIndex = live.pages.length - 1;
      });

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
      for (const page of live.pages) {
        if (!page.isClosed()) await page.close().catch(() => undefined);
      }
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

  /** The page every action addresses, healed if the active tab has closed. */
  private activePage(live: LiveSession): PwPage {
    const page = live.pages[live.activeIndex];
    if (page && !page.isClosed()) return page;
    this.pruneClosedPages(live);
    const fallback = live.pages[live.activeIndex] ?? live.pages[0];
    if (!fallback) {
      throw new Error('Browser session has no open page.');
    }
    return fallback;
  }

  /**
   * Drop closed pages and keep `activeIndex` pointing at the same tab.
   *
   * A page can close without us: a script calls `window.close()`, or the user
   * closes it in a headful session. Reindexing has to preserve the CURRENT
   * page's identity, not its number — clamping the index instead would
   * silently move the session to a different tab.
   */
  private pruneClosedPages(live: LiveSession): void {
    const current = live.pages[live.activeIndex];
    const open = live.pages.filter((page) => !page.isClosed());
    if (open.length === live.pages.length) return;
    live.pages = open;
    const nextIndex = current && !current.isClosed() ? open.indexOf(current) : -1;
    live.activeIndex = nextIndex >= 0 ? nextIndex : Math.max(0, open.length - 1);
  }

  /**
   * Add a page to the session exactly once.
   *
   * Two paths race to adopt the same tab — the explicit `tab op:'new'` call
   * and the context's own `page` event — so adoption has to be idempotent or
   * one tab ends up occupying two indices.
   */
  private adoptPage(live: LiveSession, page: PwPage): void {
    if (live.pages.includes(page)) return;
    this.instrumentPage(live, page);
    live.pages.push(page);
  }

  /**
   * Attach the per-page observers every session gets.
   *
   * Console messages and failed requests are kept in a bounded ring buffer so
   * a chatty page cannot grow the session without limit, and dialogs are
   * ANSWERED rather than left open: an unhandled `confirm()` blocks the page
   * forever, which reads to the caller as a mysterious action timeout.
   */
  private instrumentPage(live: LiveSession, page: PwPage): void {
    const push = <T>(buffer: T[], item: T) => {
      buffer.push(item);
      if (buffer.length > OBSERVATION_BUFFER) buffer.shift();
    };

    page.on('console', (message: { type(): string; text(): string }) => {
      push(live.console, { type: message.type(), text: message.text(), at: new Date() });
    });
    page.on('pageerror', (error: Error) => {
      push(live.console, { type: 'pageerror', text: error.message, at: new Date() });
    });
    page.on('requestfailed', (request: {
      url(): string;
      method(): string;
      failure(): { errorText: string } | null;
    }) => {
      push(live.networkFailures, {
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText,
        at: new Date(),
      });
    });
    page.on('dialog', async (dialog: {
      type(): string;
      message(): string;
      accept(promptText?: string): Promise<void>;
      dismiss(): Promise<void>;
    }) => {
      const action = live.config.dialogPolicy ?? 'dismiss';
      live.lastDialog = {
        type: dialog.type(),
        message: dialog.message(),
        action,
        at: new Date(),
      };
      try {
        if (action === 'accept') await dialog.accept();
        else await dialog.dismiss();
      } catch {
        // The page navigated away from under the dialog; nothing to answer.
      }
    });
  }

  /**
   * Turn a volatile `ref` into the durable descriptor a flow step can store.
   *
   * The index is rebuilt by every `captureAriaSnapshot`, so this only answers
   * for the snapshot the caller has actually seen. Returning `undefined` is
   * normal and not an error — a target given as a CSS selector was already
   * durable, and a stale ref has nothing to describe.
   */
  private describeRef(live: LiveSession, ref?: string): BrowserTarget | undefined {
    if (!ref) return undefined;
    const node = live.refIndex.get(ref);
    if (!node) return undefined;
    const described: BrowserTarget = { role: node.role };
    if (node.name) described.name = node.name;
    // `nth` is only worth persisting when role+name genuinely repeats;
    // carrying a redundant `nth: 0` would break the moment a page grew a
    // second match ABOVE the recorded one.
    if (node.ambiguous) described.nth = node.nth;
    return described;
  }

  /** The locator root an action addresses — the page, or a frame within it. */
  private locatorRoot(live: LiveSession, frame?: string | string[]): PwLocatorRoot {
    let root: PwLocatorRoot = this.activePage(live);
    if (!frame) return root;
    for (const selector of Array.isArray(frame) ? frame : [frame]) {
      root = root.frameLocator(selector);
    }
    return root;
  }

  /**
   * Build a locator from a target, trying strategies most-durable-first.
   *
   * ORDER IS DELIBERATE and it is not "most specific first". `ref` leads
   * because a live agent that just took a snapshot has the cheapest possible
   * handle and we should not second-guess it — but it is PROBED, not trusted:
   * a ref from a snapshot the page has since replaced resolves to nothing and
   * would otherwise burn the whole action timeout before failing. Everything
   * after it is ordered by how well it survives a redesign: a test-id is put
   * there by the app's authors for exactly this purpose, role+name is what a
   * screen reader would say, and a CSS selector is last because it encodes
   * markup structure that nobody promised to keep.
   */
  private async resolveLocator(
    live: LiveSession,
    target: BrowserTarget,
  ): Promise<{ locator: PwLocator; strategy: BrowserTargetStrategy }> {
    const root = this.locatorRoot(live, target.frame);
    const pick = (locator: PwLocator): PwLocator =>
      target.nth === undefined ? locator : locator.nth(target.nth);

    if (target.ref) {
      const byRef = root.locator(`aria-ref=${target.ref}`);
      const hasFallback = Boolean(
        target.testId || target.role || target.label || target.placeholder
        || target.text || target.selector,
      );
      if (!hasFallback) {
        return { locator: byRef, strategy: 'ref' };
      }
      try {
        await byRef.waitFor({ state: 'attached', timeout: REF_PROBE_TIMEOUT_MS });
        return { locator: byRef, strategy: 'ref' };
      } catch {
        // Fall through to the durable strategies below.
      }
    }

    if (target.testId) {
      return { locator: pick(root.getByTestId(target.testId)), strategy: 'testId' };
    }

    if (target.role) {
      const options: Record<string, unknown> = {};
      if (target.name !== undefined) {
        options.name = target.name;
        // Playwright's `name` is a full, whitespace-normalized match unless
        // told otherwise; `exact: false` is the substring behaviour callers
        // expect from `nameContains`.
        options.exact = !target.nameContains;
      }
      return { locator: pick(root.getByRole(target.role, options)), strategy: 'role' };
    }

    if (target.label) {
      return { locator: pick(root.getByLabel(target.label)), strategy: 'label' };
    }

    if (target.placeholder) {
      return { locator: pick(root.getByPlaceholder(target.placeholder)), strategy: 'placeholder' };
    }

    if (target.text) {
      return { locator: pick(root.getByText(target.text)), strategy: 'text' };
    }

    if (target.selector) {
      return { locator: pick(root.locator(target.selector)), strategy: 'selector' };
    }

    throw new Error(
      'No element target given. Supply `ref` (from a snapshot), `role` + `name`, `testId`, `label`, `placeholder`, `text` or `selector`.',
    );
  }

  async runAction(sessionKey: string, action: BrowserAction): Promise<BrowserActionResult> {
    const live = this.requireSession(sessionKey);
    let strategy: BrowserTargetStrategy | undefined;
    let resolvedTarget: BrowserTarget | undefined;
    let tabs: BrowserActionResult['tabs'];

    /** Resolve, and record what a flow step should persist for this target. */
    const target = async (spec: BrowserTarget) => {
      const resolved = await this.resolveLocator(live, spec);
      strategy = resolved.strategy;
      resolvedTarget = resolved.strategy === 'ref'
        ? this.describeRef(live, spec.ref)
        : durableTarget(spec);
      return resolved.locator;
    };

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
          await this.activePage(live).goto(action.url, {
            waitUntil: action.waitUntil ?? 'load',
            timeout: action.timeout,
          });
          break;
        }
        case 'click': {
          const loc = await target(action);
          const options = { button: action.button, timeout: action.timeout };
          if (action.clickCount === 2) await loc.dblclick(options);
          else await loc.click(options);
          break;
        }
        case 'hover': {
          const loc = await target(action);
          await loc.hover({ timeout: action.timeout });
          break;
        }
        case 'type': {
          const loc = await target(action);
          if (action.clear) {
            await loc.fill('', { timeout: action.timeout });
          }
          // `fill` sets the value in one shot and is what a real form wants;
          // `type` replays individual keystrokes, which some inputs (masked
          // fields, autocompletes) need to fire their handlers. `delay` is
          // the caller saying they need the keystrokes.
          if (action.delay) {
            await loc.type(action.text, { delay: action.delay, timeout: action.timeout });
          } else {
            await loc.fill(action.text, { timeout: action.timeout });
          }
          if (action.submit) {
            await loc.press('Enter');
          }
          break;
        }
        case 'press': {
          const loc = await target(action);
          await loc.press(action.key);
          break;
        }
        case 'select': {
          const loc = await target(action);
          const values = action.labels?.length
            ? action.labels.map((label) => ({ label }))
            : (action.values ?? []);
          if ((Array.isArray(values) ? values.length : 0) === 0) {
            throw new Error('`values` or `labels` is required for a select action.');
          }
          await loc.selectOption(values, { timeout: action.timeout });
          break;
        }
        case 'check': {
          const loc = await target(action);
          // check/uncheck are idempotent where a click toggles — replaying a
          // flow must not flip a box that was already in the right state.
          if (action.checked === false) await loc.uncheck({ timeout: action.timeout });
          else await loc.check({ timeout: action.timeout });
          break;
        }
        case 'upload': {
          const loc = await target(action);
          const files = await this.resolveUploads(live, action.fileIds);
          await loc.setInputFiles(files, { timeout: action.timeout });
          break;
        }
        case 'drag': {
          const from = await this.resolveLocator(live, action.from);
          const to = await this.resolveLocator(live, action.to);
          strategy = from.strategy;
          resolvedTarget = from.strategy === 'ref'
            ? this.describeRef(live, action.from.ref)
            : durableTarget(action.from);
          await from.locator.dragTo(to.locator, { timeout: action.timeout });
          break;
        }
        case 'back':
        case 'forward':
        case 'reload': {
          const page = this.activePage(live);
          const options = { waitUntil: action.waitUntil ?? 'load', timeout: action.timeout };
          if (action.type === 'back') await page.goBack(options);
          else if (action.type === 'forward') await page.goForward(options);
          else await page.reload(options);
          break;
        }
        case 'wait': {
          const page = this.activePage(live);
          if (action.ms !== undefined) {
            await page.waitForTimeout(action.ms);
          } else if (action.text) {
            await page
              .getByText(action.text)
              .first()
              .waitFor({ state: action.state ?? 'visible', timeout: action.timeout });
          } else if (action.selector) {
            await page.waitForSelector(action.selector, {
              state: action.state,
              timeout: action.timeout,
            });
          } else if (action.loadState) {
            await page.waitForLoadState(action.loadState, { timeout: action.timeout });
          } else {
            throw new Error('A wait needs one of `ms`, `text`, `selector` or `loadState`.');
          }
          break;
        }
        case 'scroll': {
          if (hasTargetSpec(action)) {
            const loc = await target(action);
            await loc.scrollIntoViewIfNeeded({ timeout: action.timeout });
          } else {
            // `evaluate(fn, arg)` passes the offsets as data. Building the
            // function body from a template string would put caller input
            // inside the page's script text, which is an injection sink the
            // moment the schema in front of it loosens.
            await this.activePage(live).evaluate<{ x: number; y: number }>(
              (offset) => window.scrollBy(offset.x, offset.y),
              { x: action.x ?? 0, y: action.y ?? 0 },
            );
          }
          break;
        }
        case 'tab': {
          tabs = await this.runTabOp(live, action);
          break;
        }
        default: {
          throw new Error(`Unsupported action type: ${(action as { type: string }).type}`);
        }
      }

      const page = this.activePage(live);
      const ariaSnapshot = await this.captureAriaSnapshot(live).catch(() => undefined);
      return {
        ok: true,
        url: page.url(),
        pageTitle: await page.title().catch(() => undefined),
        ariaSnapshot,
        resolvedTarget,
        targetStrategy: strategy,
        tabs,
      };
    } catch (err) {
      return {
        ok: false,
        url: this.activePage(live).url(),
        targetStrategy: strategy,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Tab operations, which exist because a `target="_blank"` link is otherwise
   * a dead end: Playwright opens a new page in the same context and the
   * session, addressing only its original page, goes blind at the exact
   * moment the flow reaches a payment or SSO window.
   */
  private async runTabOp(
    live: LiveSession,
    action: Extract<BrowserAction, { type: 'tab' }>,
  ): Promise<BrowserActionResult['tabs']> {
    this.pruneClosedPages(live);

    if (action.op === 'new') {
      const page = await live.context.newPage();
      // `context.on('page')` fires for OUR page too, and it fires before
      // `newPage()` resolves — so by the time we get here the listener has
      // usually already adopted it. Adding it again would leave the session
      // with two entries pointing at one tab and an index that no longer
      // means what the caller thinks.
      this.adoptPage(live, page);
      live.activeIndex = live.pages.indexOf(page);
      if (action.url) {
        const decision = await evaluateBrowserRequestAccess(action.url, live.config.access, {
          blockPrivateNetwork: getConfig().browser.blockPrivateNetwork,
          requireHttp: true,
        });
        if (!decision.allowed) {
          throw new Error(decision.reason ?? 'Browser navigation blocked by egress policy');
        }
        await page.goto(action.url, { waitUntil: 'load' });
      }
    } else if (action.op === 'switch') {
      const index = action.index ?? 0;
      if (!live.pages[index]) throw new Error(`No browser tab at index ${index}.`);
      live.activeIndex = index;
      await live.pages[index].bringToFront().catch(() => undefined);
    } else if (action.op === 'close') {
      const index = action.index ?? live.activeIndex;
      const page = live.pages[index];
      if (!page) throw new Error(`No browser tab at index ${index}.`);
      if (live.pages.length === 1) {
        throw new Error('Cannot close the last tab — close the session instead.');
      }
      await page.close().catch(() => undefined);
      this.pruneClosedPages(live);
    }

    return this.describeTabs(live);
  }

  private async describeTabs(live: LiveSession): Promise<BrowserActionResult['tabs']> {
    return Promise.all(
      live.pages.map(async (page, index) => ({
        index,
        url: page.url(),
        title: await page.title().catch(() => undefined),
        active: index === live.activeIndex,
      })),
    );
  }

  /**
   * Turn Files-service ids into local paths Playwright can hand to an input.
   *
   * Uploads go through the Files service rather than accepting a filesystem
   * path from the caller: a path would let a flow read anything the server
   * process can, and the file a flow uploads is tenant data that belongs
   * under the tenant's bucket anyway.
   */
  private async resolveUploads(
    live: LiveSession,
    fileIds: string[],
  ): Promise<Array<{ name: string; mimeType: string; buffer: Buffer }>> {
    if (!this.uploadResolver) {
      throw new Error('File uploads are not available in this runtime.');
    }
    if (!live.tenantDbName) {
      throw new Error('This browser session cannot resolve files (no tenant database bound).');
    }
    return this.uploadResolver(
      { tenantDbName: live.tenantDbName, tenantId: live.tenantId, projectId: live.projectId },
      fileIds,
    );
  }

  /**
   * Installed by `browserSessionService` at boot.
   *
   * The manager is deliberately storage-agnostic — it knows Playwright and
   * nothing else — so the Files lookup is injected rather than imported,
   * which also keeps the import graph acyclic.
   */
  setUploadResolver(resolver: UploadResolver): void {
    this.uploadResolver = resolver;
  }

  async extract(sessionKey: string, input: BrowserExtractInput): Promise<BrowserExtractResult> {
    const live = this.requireSession(sessionKey);
    try {
      const { locator: loc, strategy } = await this.resolveLocator(live, input);
      const resolvedTarget = strategy === 'ref'
        ? this.describeRef(live, input.ref)
        : durableTarget(input);
      const mode = input.mode ?? 'text';

      const readOne = async (target: PwLocator): Promise<string> => {
        if (mode === 'html') return target.innerHTML();
        if (mode === 'value') return target.inputValue();
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
        return { ok: true, values, resolvedTarget };
      }

      return { ok: true, values: [await readOne(loc)], resolvedTarget };
    } catch (err) {
      return {
        ok: false,
        values: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Find visible occurrences of a string and describe them durably.
   *
   * This is the cheap alternative to another full snapshot when the model
   * already knows what it is looking for ("the Continue button"), and it is
   * how a discovery turn produces a target a flow step can keep.
   */
  async findText(
    sessionKey: string,
    text: string,
    options: { limit?: number } = {},
  ): Promise<{ ok: boolean; matches: Array<{ text: string; target: BrowserTarget }>; errorMessage?: string }> {
    const live = this.requireSession(sessionKey);
    try {
      const locator = this.activePage(live).getByText(text);
      const total = await locator.count();
      const limit = Math.min(options.limit ?? 10, total);
      const matches: Array<{ text: string; target: BrowserTarget }> = [];
      for (let i = 0; i < limit; i += 1) {
        const item = locator.nth(i);
        matches.push({
          text: (await item.innerText().catch(() => '')).trim().slice(0, 200),
          target: total > 1 ? { text, nth: i } : { text },
        });
      }
      return { ok: true, matches };
    } catch (err) {
      return {
        ok: false,
        matches: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Export cookies + origin storage so a later session can resume logged in.
   *
   * This is what makes a flow that needs a login practical: sign in ONCE
   * interactively, keep the state on the browser profile, and every scheduled
   * run afterwards starts authenticated instead of replaying credentials
   * through a form (and through the event log) every night.
   */
  async exportStorageState(sessionKey: string): Promise<Record<string, unknown>> {
    const live = this.requireSession(sessionKey);
    return live.context.storageState();
  }

  /** Console messages, failed requests and the last dialog this session saw. */
  getObservations(sessionKey: string): BrowserObservations {
    const live = this.requireSession(sessionKey);
    return {
      console: live.console.map((entry) => ({
        type: entry.type,
        text: entry.text,
        at: entry.at.toISOString(),
      })),
      networkFailures: live.networkFailures.map((entry) => ({
        url: entry.url,
        method: entry.method,
        failure: entry.failure,
        at: entry.at.toISOString(),
      })),
      lastDialog: live.lastDialog
        ? {
            type: live.lastDialog.type,
            message: live.lastDialog.message,
            action: live.lastDialog.action,
            at: live.lastDialog.at.toISOString(),
          }
        : undefined,
    };
  }

  async listTabs(sessionKey: string): Promise<BrowserActionResult['tabs']> {
    const live = this.requireSession(sessionKey);
    this.pruneClosedPages(live);
    return this.describeTabs(live);
  }

  async screenshot(sessionKey: string, input: BrowserScreenshotInput = {}): Promise<{ buffer: Buffer; contentType: string }> {
    const live = this.requireSession(sessionKey);
    const type = input.type ?? 'png';
    const opts: Record<string, unknown> = { type, fullPage: input.fullPage ?? false };
    if (type === 'jpeg') opts.quality = input.quality ?? 80;

    let buffer: Buffer;
    if (hasTargetSpec(input)) {
      const { locator } = await this.resolveLocator(live, input);
      buffer = await locator.screenshot(opts);
    } else {
      buffer = await this.activePage(live).screenshot(opts);
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
    const buffer = await this.activePage(live).pdf(opts);
    return { buffer, contentType: 'application/pdf' };
  }

  /**
   * Snapshot the accessibility tree WITH element references, and index them.
   *
   * `mode: 'ai'` is the option that emits the `[ref=e4]` markers the whole
   * click/type path addresses; the tree without them names elements but hands
   * back no way to reach one. (This module previously passed `ref: true`,
   * which Playwright's client drops silently — the snapshot came back
   * ref-less, every ref the model then produced was invented, and each one
   * burned a full action timeout resolving to nothing.)
   *
   * The index built here is what lets a recorded step outlive its snapshot:
   * see `describeRef`.
   */
  async captureAriaSnapshot(liveOrKey: LiveSession | string): Promise<string> {
    const live = typeof liveOrKey === 'string' ? this.requireSession(liveOrKey) : liveOrKey;
    // Bound the snapshot so it can't stall the action result on a page that
    // never settles. `setDefaultTimeout` covers it, but be explicit here since
    // this runs after every action.
    const timeout = live.config.actionTimeoutMs ?? getConfig().browser.defaultActionTimeoutMs;
    let snapshot = '';
    try {
      snapshot = await this.activePage(live).locator('html').ariaSnapshot({ mode: 'ai', timeout });
    } catch {
      // A Playwright old enough to lack `mode` still gives a readable tree;
      // it just cannot be addressed by ref, so callers fall back to selectors.
      try {
        snapshot = await this.activePage(live).locator('html').ariaSnapshot({ timeout });
      } catch {
        snapshot = '';
      }
    }
    live.refIndex = indexAriaRefs(snapshot);
    return snapshot;
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
      url: this.activePage(live).url(),
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

/** True when a payload names an element at all, rather than the whole page. */
function hasTargetSpec(target: BrowserTarget): boolean {
  return Boolean(
    target.ref || target.selector || target.role || target.testId
    || target.label || target.placeholder || target.text,
  );
}

/**
 * Strip the volatile half of a target, leaving what a flow step may persist.
 *
 * A stored `ref` is worse than no target: it looks valid, resolves to nothing
 * on the next run, and spends the step's whole timeout finding that out.
 */
function durableTarget(target: BrowserTarget): BrowserTarget | undefined {
  const { ref: _ref, ...durable } = target;
  return hasTargetSpec(durable) ? durable : undefined;
}

/**
 * Parse an `ariaSnapshot({ mode: 'ai' })` tree into a ref -> descriptor index.
 *
 * Lines look like:
 *   - button "Sign in" [ref=e4]
 *   - textbox [active] [ref=e5]
 *   - heading "Hi" [level=1] [ref=e3]
 *
 * The role is the first token, the quoted string (when present) is the
 * accessible name, and the bracketed pairs are properties. We keep only role
 * and name because those are the two Playwright's `getByRole` accepts, and
 * they are the two that survive a re-render.
 *
 * `nth` is assigned in document order among nodes sharing a role+name, and
 * `ambiguous` marks the groups where it actually matters — a descriptor that
 * carries a needless `nth: 0` breaks as soon as the page grows a second match
 * ABOVE the recorded one.
 */
function indexAriaRefs(snapshot: string): Map<string, AriaRefNode> {
  const index = new Map<string, AriaRefNode>();
  if (!snapshot) return index;

  const groups = new Map<string, string[]>();

  for (const line of snapshot.split('\n')) {
    const refMatch = line.match(/\[ref=([A-Za-z0-9_-]+)\]/);
    if (!refMatch) continue;

    // Everything from the list marker up to the first bracketed property.
    const body = line.replace(/^\s*-\s*/, '').split(/\s*\[/)[0] ?? '';
    const roleMatch = body.match(/^([A-Za-z][A-Za-z0-9_-]*)/);
    if (!roleMatch) continue;

    const nameMatch = body.match(/"((?:[^"\\]|\\.)*)"/);
    const role = roleMatch[1];
    const name = nameMatch ? nameMatch[1].replace(/\\(.)/g, '$1') : undefined;
    const ref = refMatch[1];

    const groupKey = `${role} ${name ?? ''}`;
    const members = groups.get(groupKey) ?? [];
    members.push(ref);
    groups.set(groupKey, members);

    index.set(ref, { role, name, nth: members.length - 1, ambiguous: false });
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const ref of members) {
      const node = index.get(ref);
      if (node) node.ambiguous = true;
    }
  }

  return index;
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
