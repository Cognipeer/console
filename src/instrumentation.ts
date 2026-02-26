/**
 * Next.js instrumentation hook — runs once when the Node.js server process starts.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Initializes core infrastructure (config validation, lifecycle, cache)
 * and starts background schedulers.
 */

export async function register() {
  // Only run in the Node.js runtime (not Edge workers).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 1. Core infrastructure init
    const { getConfig, validateConfig } = await import('@/lib/core/config');
    const { createLogger } = await import('@/lib/core/logger');
    const { initLifecycle, registerShutdownHandler } = await import('@/lib/core/lifecycle');
    const { getCache, destroyCache } = await import('@/lib/core/cache');
    const { runtimePool } = await import('@/lib/core/runtimePool');
    const { drainPendingTasks } = await import('@/lib/core/asyncTask');
    const { registerHealthCheck } = await import('@/lib/core/health');

    const log = createLogger('startup');

    // Validate config at startup
    const cfg = getConfig();
    const errors = validateConfig(cfg);
    if (errors.length > 0) {
      for (const e of errors) {
        log.error(`Config error: ${e.key} — ${e.message}`);
      }
      // Don't crash — some envs may set these later (e.g. K8s secrets)
      log.warn(`${errors.length} config validation error(s). Some features may not work.`);
    }

    // Initialize lifecycle (signal handlers)
    initLifecycle();

    // Initialize cache provider
    try {
      await getCache();
      // Register cache health contributor
      registerHealthCheck('cache', async () => {
        try {
          const cache = await getCache();
          const probe = `_health_${Date.now()}`;
          await cache.set(probe, 1, 5);
          const val = await cache.get<number>(probe);
          await cache.del(probe);
          return val === 1
            ? { status: 'ok' }
            : { status: 'degraded', message: 'Cache read-back mismatch' };
        } catch (err) {
          return {
            status: 'down',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      });
    } catch (error) {
      log.error('Failed to initialize cache provider', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Register cleanup handlers
    registerShutdownHandler('async-tasks', async () => { await drainPendingTasks(); });
    registerShutdownHandler('cache', async () => { await destroyCache(); });
    registerShutdownHandler('runtime-pool', async () => { runtimePool.destroy(); });

    // 2. Background schedulers
    const { startPollScheduler } = await import(
      '@/lib/services/inferenceMonitoring/pollScheduler'
    );
    startPollScheduler();

    const { startAlertScheduler } = await import(
      '@/lib/services/alerts/alertScheduler'
    );
    startAlertScheduler();

    log.info('Application started', {
      nodeEnv: cfg.nodeEnv,
      cacheProvider: cfg.cache.provider,
      rateLimitProvider: cfg.rateLimit.provider,
      logLevel: cfg.logging.level,
      corsEnabled: cfg.cors.enabled,
    });
  }
}
