import { getConfig, validateConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { initLifecycle, registerShutdownHandler } from '@/lib/core/lifecycle';
import { getCache, destroyCache } from '@/lib/core/cache';
import { runtimePool } from '@/lib/core/runtimePool';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { registerHealthCheck } from '@/lib/core/health';
import { startPollScheduler } from '@/lib/services/inferenceMonitoring/pollScheduler';
import { startAlertScheduler } from '@/lib/services/alerts/alertScheduler';
import { ensureServerEnvLoaded } from './env';

const logger = createLogger('startup');

let bootstrapped = false;

export async function bootstrapApplication(): Promise<void> {
  ensureServerEnvLoaded();

  if (bootstrapped) {
    return;
  }
  bootstrapped = true;

  const cfg = getConfig();
  const errors = validateConfig(cfg);

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(`Config error: ${error.key} - ${error.message}`);
    }
    logger.warn(
      `${errors.length} config validation error(s). Some features may not work.`,
    );
  }

  initLifecycle();

  try {
    await getCache();
    registerHealthCheck('cache', async () => {
      try {
        const cache = await getCache();
        const probe = `_health_${Date.now()}`;
        await cache.set(probe, 1, 5);
        const value = await cache.get<number>(probe);
        await cache.del(probe);
        return value === 1
          ? { status: 'ok' }
          : { status: 'degraded', message: 'Cache read-back mismatch' };
      } catch (error) {
        return {
          status: 'down',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  } catch (error) {
    logger.error('Failed to initialize cache provider', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  registerShutdownHandler('async-tasks', async () => {
    await drainPendingTasks();
  });
  registerShutdownHandler('cache', async () => {
    await destroyCache();
  });
  registerShutdownHandler('runtime-pool', async () => {
    runtimePool.destroy();
  });

  startPollScheduler();
  startAlertScheduler();

  logger.info('Application started', {
    cacheProvider: cfg.cache.provider,
    corsEnabled: cfg.cors.enabled,
    logLevel: cfg.logging.level,
    nodeEnv: cfg.nodeEnv,
    rateLimitProvider: cfg.rateLimit.provider,
  });
}
