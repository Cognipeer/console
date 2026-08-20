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
import {
  startCrawlerQueueConsumer,
  startCrawlerScheduler,
  reconcileOrphanedCrawlJobs,
} from '@/lib/services/crawler';
import { startOcrJobQueueConsumer } from '@/lib/services/ocrJobs';
import { startBatchQueueConsumer } from '@/lib/services/batch';
import { startDatasetGenerationConsumer } from '@/lib/services/evaluation/datasetGenerationConsumer';
import { startSnapshotQueueConsumer } from '@/lib/services/snapshots/snapshotConsumer';
import { startRedTeamQueueConsumer } from '@/lib/services/redteam/campaignConsumer';
import { startEvaluationRunQueueConsumer } from '@/lib/services/evaluation/evaluationRunConsumer';
import { startAnalysisRunQueueConsumer } from '@/lib/services/analysis/analysisRunConsumer';
import { startAgentQueueConsumer } from '@/lib/services/agents/agentConsumer';
import { startMcpQueueConsumer } from '@/lib/services/mcp/mcpConsumer';
import { startVectorMigrationQueueConsumer } from '@/lib/services/vector/vectorMigrationConsumer';
import { resumeInterruptedVectorMigrations } from '@/lib/services/vector/vectorMigrationJob';
import { startPollScheduler } from '@/lib/services/inferenceMonitoring/pollScheduler';
import { startAlertScheduler } from '@/lib/services/alerts/alertScheduler';
import { startAnalysisScheduler } from '@/lib/services/analysis/analysisScheduler';
import { startRedTeamScheduler } from '@/lib/services/redteam/redTeamScheduler';
import { enterpriseReconcilers , enterpriseQueueConsumers } from '@/enterprise/registry';
import { ensureBootstrapOrganization } from '@/lib/services/auth/bootstrapOrganization';
import { ensureServerEnvLoaded } from './env';

const logger = createLogger('startup');

// Promise-based singleton: `nextApp.prepare()` runs concurrently with this
// bootstrap and Next's instrumentation hook also calls it — concurrent
// callers must await the SAME in-flight run, not return early.
let bootstrapPromise: Promise<void> | null = null;

// The HTTP server now starts listening before this resolves (see app.ts) so
// that boot latency isn't fully on the critical path for "server responds to
// anything at all". Request-handling code that needs bootstrap to have
// finished (the global API `onRequest` hook, `/health/ready`) checks this
// flag instead and returns 503 rather than running against half-initialized
// providers (cache/queue/cluster) or racing the tenant reconciliation pass.
let applicationReady = false;

export function bootstrapApplication(): Promise<void> {
  ensureServerEnvLoaded();

  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap();
  }
  return bootstrapPromise;
}

export function isApplicationReady(): boolean {
  return applicationReady;
}

async function runBootstrap(): Promise<void> {
  const cfg = getConfig();
  const errors = validateConfig(cfg);

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(`Config error: ${error.key} - ${error.message}`);
    }
    // Production refuses to serve on an invalid config. These errors cover the
    // signing and at-rest encryption secrets, so booting anyway would run the
    // deployment on the shipped development defaults — a forgeable session
    // token and credentials encrypted under a publicly known key.
    if (cfg.nodeEnv === 'production') {
      throw new Error(
        `${errors.length} config validation error(s): ${errors.map((e) => e.key).join(', ')}. `
        + 'Refusing to start in production — fix the reported keys.',
      );
    }
    logger.warn(
      `${errors.length} config validation error(s). Some features may not work.`,
    );
  }

  initLifecycle();

  registerShutdownHandler('async-tasks', async () => {
    await drainPendingTasks();
  });
  registerShutdownHandler('cache', async () => {
    await destroyCache();
  });
  registerShutdownHandler('runtime-pool', async () => {
    runtimePool.destroy();
  });

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

  // The two groups below don't touch each other's state — `coreInfraInit`
  // only sets up process-local providers (cache/cluster/queue), while
  // `tenantReconciliation` scans tenant databases. Running them
  // concurrently (instead of one long sequential await chain) is what
  // actually shortens boot time; each step keeps its original try/catch so
  // a failure in one never blocks the rest, same as before.
  //
  // `tenantReconciliation`'s three steps stay sequential *with each other*:
  // they all read/write through the shared `db` singleton's tenant-switch
  // state (`switchToTenant`/`runWithTenantScope`), which is only safe for
  // one in-flight tenant-scoped call at a time — see the scheduler comments
  // in redTeamScheduler.ts / analysisScheduler.ts for the same rule.
  const coreInfraInit = (async () => {
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
  })();

  const tenantReconciliation = (async () => {
    try {
      await reconcileOrphanedBrowserSessions();
    } catch (error) {
      logger.warn('Browser session reconciliation failed during startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // On-prem: seed the single organization + owner from BOOTSTRAP_* envs.
    // No-op when the envs are unset or a tenant already exists.
    try {
      await ensureBootstrapOrganization();
    } catch (error) {
      logger.error('Bootstrap organization creation failed during startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Must complete BEFORE the crawler scheduler/consumers below start taking
    // new work: it treats every `running`/`queued` job as orphaned (resets it
    // and deletes its partial results), so a post-listen job must never be
    // observable here.
    try {
      await reconcileOrphanedCrawlJobs();
    } catch (error) {
      logger.warn('Crawl job reconciliation failed during startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  await Promise.all([coreInfraInit, tenantReconciliation]);

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
      startBrowserQueueConsumer(),
      startCrawlerQueueConsumer(),
      startOcrJobQueueConsumer(),
      startBatchQueueConsumer(),
      startDatasetGenerationConsumer(),
      startSnapshotQueueConsumer(),
      startRedTeamQueueConsumer(),
      startEvaluationRunQueueConsumer(),
      startVectorMigrationQueueConsumer(),
      // Enterprise modules contribute their consumers through the seam;
      // the collection is empty in the community edition.
      ...enterpriseQueueConsumers.map((start) => start()),
      startAnalysisRunQueueConsumer(),
    ]);
  } catch (error) {
    logger.warn('Queue consumer registration failed; cluster routing limited', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Index migrations interrupted by a restart resume from their persisted
  // cursor. Must run AFTER the consumer above is registered.
  try {
    await resumeInterruptedVectorMigrations();
  } catch (error) {
    logger.warn('Vector migration resume failed during startup', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  applicationReady = true;

  logger.info('Application started', {
    cacheProvider: cfg.cache.provider,
    corsEnabled: cfg.cors.enabled,
    logLevel: cfg.logging.level,
    nodeEnv: cfg.nodeEnv,
    rateLimitProvider: cfg.rateLimit.provider,
  });
}
