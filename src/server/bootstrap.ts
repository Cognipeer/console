import { getConfig, validateConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { initLifecycle, registerShutdownHandler } from '@/lib/core/lifecycle';
import { getCache, destroyCache } from '@/lib/core/cache';
import { runtimePool } from '@/lib/core/runtimePool';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { registerHealthCheck } from '@/lib/core/health';
import {
  deregisterThisNode,
  getThisNodeName,
  listClusterNodes,
  registerThisNode,
} from '@/lib/core/cluster';
import { destroyQueue, getQueue } from '@/lib/core/queue';
import { listAutomations } from '@/lib/services/automations';
import { browserManager } from '@/lib/services/browser/browserManager';
import { reconcileOrphanedBrowserSessions } from '@/lib/services/browser/browserOperationsService';
import { startBrowserQueueConsumer } from '@/lib/services/browser/browserConsumer';
import { startCrawlerQueueConsumer, startCrawlerScheduler } from '@/lib/services/crawler';
import { startOcrJobQueueConsumer } from '@/lib/services/ocrJobs';
import { startBatchQueueConsumer } from '@/lib/services/batch';
import { startDatasetGenerationConsumer } from '@/lib/services/evaluation/datasetGenerationConsumer';
import { startRedTeamQueueConsumer } from '@/lib/services/redteam/campaignConsumer';
import { startEvaluationRunQueueConsumer } from '@/lib/services/evaluation/evaluationRunConsumer';
import { startAnalysisRunQueueConsumer } from '@/lib/services/analysis/analysisRunConsumer';
import { jsSandboxExecutorManager } from '@/lib/services/jsSandbox';
import { startJsSandboxQueueConsumer } from '@/lib/services/jsSandbox/jsSandboxConsumer';
import { startAgentQueueConsumer } from '@/lib/services/agents/agentConsumer';
import { startMcpQueueConsumer } from '@/lib/services/mcp/mcpConsumer';
import { startPollScheduler } from '@/lib/services/inferenceMonitoring/pollScheduler';
import { startAlertScheduler } from '@/lib/services/alerts/alertScheduler';
import { startAnalysisScheduler } from '@/lib/services/analysis/analysisScheduler';
import { startRedTeamScheduler } from '@/lib/services/redteam/redTeamScheduler';
import { enterpriseReconcilers } from '@/enterprise/registry';
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

  // Cluster + queue init. Both are safe no-ops on a single-node deployment:
  // the registry creates a single row in the `nodes` table and the queue
  // resolves to its in-memory driver when Redis is not configured. No
  // existing service is migrated yet — these are opt-in for future code.
  try {
    await registerThisNode();
    registerShutdownHandler('node-registry', async () => {
      await deregisterThisNode();
    });
    registerHealthCheck('cluster', async () => {
      try {
        const nodes = await listClusterNodes();
        const online = nodes.filter((n) => n.status === 'online').length;
        return {
          status: 'ok',
          details: {
            thisNode: getThisNodeName(),
            online,
            total: nodes.length,
          },
        };
      } catch (error) {
        return {
          status: 'degraded',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  } catch (error) {
    logger.warn('Cluster node registration failed; continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const queue = await getQueue();
    registerShutdownHandler('queue', async () => {
      await destroyQueue();
    });
    registerHealthCheck('queue', async () => ({
      status: 'ok',
      details: { provider: queue.name },
    }));
  } catch (error) {
    logger.warn('Queue provider init failed; continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  registerHealthCheck('browser-runtime', async () => {
    const stats = browserManager.getRuntimeStats();
    return {
      status: stats.reaper.lastError ? 'degraded' : 'ok',
      details: {
        browserConnected: stats.browserConnected,
        liveSessions: stats.liveSessions,
        reaperError: stats.reaper.lastError,
        reaperPaused: stats.reaper.paused,
      },
    };
  });

  registerHealthCheck('js-sandbox-runtime', async () => {
    const stats = jsSandboxExecutorManager.getRuntimeStats();
    return {
      status: stats.shuttingDown ? 'degraded' : 'ok',
      details: stats,
    };
  });

  registerHealthCheck('automations', async () => {
    const automations = listAutomations();
    const degraded = automations.some((automation) => automation.state === 'degraded');
    return {
      status: degraded ? 'degraded' : 'ok',
      details: {
        automations: automations.map((automation) => ({
          key: automation.key,
          lastError: automation.lastError,
          state: automation.state,
        })),
      },
    };
  });

  try {
    await reconcileOrphanedBrowserSessions();
  } catch (error) {
    logger.warn('Browser session reconciliation failed during startup', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ── Enterprise overlay seam ──────────────────────────────────────────────
  // Runs enterprise bootstrap reconcilers (e.g. sandbox runtime reconcile).
  // No-op in the community edition.
  for (const reconcile of enterpriseReconcilers) {
    try {
      await reconcile();
    } catch (error) {
      logger.warn('Enterprise reconciler failed during startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  startPollScheduler();
  startAlertScheduler();
  startCrawlerScheduler();
  startAnalysisScheduler();
  startRedTeamScheduler();

  // Register queue consumers on every node so that whenever instance
  // routing forwards a job to another node, that node can execute it.
  // The consumers are no-ops for memory queue + single-node deployments.
  try {
    await Promise.all([
      startAgentQueueConsumer(),
      startMcpQueueConsumer(),
      startJsSandboxQueueConsumer(),
      startBrowserQueueConsumer(),
      startCrawlerQueueConsumer(),
      startOcrJobQueueConsumer(),
      startBatchQueueConsumer(),
      startDatasetGenerationConsumer(),
      startRedTeamQueueConsumer(),
      startEvaluationRunQueueConsumer(),
      startAnalysisRunQueueConsumer(),
    ]);
  } catch (error) {
    logger.warn('Queue consumer registration failed; cluster routing limited', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info('Application started', {
    cacheProvider: cfg.cache.provider,
    corsEnabled: cfg.cors.enabled,
    logLevel: cfg.logging.level,
    nodeEnv: cfg.nodeEnv,
    rateLimitProvider: cfg.rateLimit.provider,
  });
}
