/**
 * Lifecycle Manager — graceful shutdown & resource cleanup.
 *
 * Registers shutdown handlers that run on SIGTERM / SIGINT.
 * Handlers execute in reverse-registration order (LIFO) so
 * high-level services shut down before low-level resources.
 *
 * Usage:
 *   import { registerShutdownHandler, initLifecycle } from '@/lib/core/lifecycle';
 *
 *   // In instrumentation.ts:
 *   initLifecycle();
 *
 *   // Anywhere:
 *   registerShutdownHandler('cache', async () => { await destroyCache(); });
 *   registerShutdownHandler('database', async () => { await disconnectDatabase(); });
 */

import { getConfig } from './config';
import { createLogger } from './logger';

const log = createLogger('lifecycle');

interface ShutdownHandler {
  name: string;
  handler: () => Promise<void>;
  /** Runs before every handler without it (see `registerShutdownHandler`). */
  first?: boolean;
}

const handlers: ShutdownHandler[] = [];
let shuttingDown = false;
let initialized = false;

/**
 * Register a handler that will be called during graceful shutdown.
 * Handlers run in LIFO order (last registered = first to run).
 *
 * `first`: the handler runs before every handler registered without it
 * (LIFO among themselves), whenever it was registered. For work the shutdown
 * timeout must not cut short because handlers registered later (a lazy flush)
 * took the time: handing running agent runs to another node.
 */
export function registerShutdownHandler(name: string, handler: () => Promise<void>, options?: { first?: boolean }): void {
  handlers.push({ name, handler, ...(options?.first ? { first: true } : {}) });
}

/** The order shutdown runs the handlers in: the `first` ones, then the rest, each LIFO. */
export function shutdownHandlerOrder(list: ReadonlyArray<{ name: string; first?: boolean }> = handlers): string[] {
  const reversed = [...list].reverse();
  return [...reversed.filter((h) => h.first), ...reversed.filter((h) => !h.first)].map((h) => h.name);
}

/**
 * Execute all shutdown handlers with a timeout.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // prevent double-shutdown
  shuttingDown = true;

  const cfg = getConfig();
  const timeout = cfg.app.shutdownTimeoutMs;

  log.info(`Received ${signal} — starting graceful shutdown (timeout: ${timeout}ms)`);

  const timer = setTimeout(() => {
    log.error('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, timeout);
  timer.unref();

  // Run handlers in reverse order (LIFO), the `first` ones before the rest.
  const reversed = [...handlers].reverse();
  const ordered = [...reversed.filter((h) => h.first), ...reversed.filter((h) => !h.first)];
  for (const { name, handler } of ordered) {
    try {
      log.info(`Shutting down: ${name}`);
      await handler();
      log.info(`Shut down: ${name} ✓`);
    } catch (error) {
      log.error(`Error shutting down ${name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info('Graceful shutdown complete');
  clearTimeout(timer);
  process.exit(0);
}

/**
 * Initialize lifecycle management — registers signal handlers.
 * Call once from instrumentation.ts.
 */
export function initLifecycle(): void {
  if (initialized) return;
  initialized = true;

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Catch unhandled rejections to log them properly
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (error) => {
    // Ignore transient connection errors that are normal in dev
    // (browser closing connections, HMR reload, SSE disconnect, etc.)
    const benignCodes = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE']);
    const code = (error as NodeJS.ErrnoException).code;
    if (code && benignCodes.has(code)) {
      log.debug('Ignoring benign connection error', { code, error: error.message });
      return;
    }

    log.error('Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });
    // Give logger time to flush, then exit
    setTimeout(() => process.exit(1), 1000).unref();
  });

  log.info('Lifecycle manager initialized');
}

/**
 * Check if the process is currently shutting down.
 * Useful for declining new work during shutdown.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}
