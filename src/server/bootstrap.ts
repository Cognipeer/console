import { getConfig, validateConfig } from '@/lib/core/config';
import { validateServiceSwitchConfig } from '@/lib/services/availability/serviceAvailability';
import { createLogger } from '@/lib/core/logger';
import { configureOutboundProxy } from '@/lib/core/outboundProxyBootstrap';
import { logProviderPrivateNetworks } from '@/lib/security/providerPrivateNetworks';
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
import { startFilesQueueConsumer } from '@/lib/services/files/jobs/filesConsumer';
import { startBatchQueueConsumer } from '@/lib/services/batch';
import { startDatasetGenerationConsumer } from '@/lib/services/evaluation/datasetGenerationConsumer';
import { startSnapshotQueueConsumer } from '@/lib/services/snapshots/snapshotConsumer';
import { startRedTeamQueueConsumer } from '@/lib/services/redteam/campaignConsumer';
import { startEvaluationRunQueueConsumer } from '@/lib/services/evaluation/evaluationRunConsumer';
import { startAnalysisRunQueueConsumer } from '@/lib/services/analysis/analysisRunConsumer';
import { startAgentQueueConsumer } from '@/lib/services/agents/agentConsumer';
import { startWebhookQueueConsumer } from '@/lib/services/webhooks/webhookConsumer';
import { startAgentTriggerScheduler, stopAgentTriggerScheduler } from '@/lib/services/agents/agentTriggerScheduler';
import { reconcileOrphanedAgentRuns, startAgentRunReconciler } from '@/lib/services/agents/agentRunReconciler';
import { startTracingSessionFinalizer } from '@/lib/services/tracing/sessionFinalizer';
import { startMcpQueueConsumer } from '@/lib/services/mcp/mcpConsumer';
import { startVectorMigrationQueueConsumer } from '@/lib/services/vector/vectorMigrationConsumer';
import { resumeInterruptedVectorMigrations } from '@/lib/services/vector/vectorMigrationJob';
import { startRagReindexQueueConsumer } from '@/lib/services/rag/ragReindexConsumer';
import { resumeInterruptedRagReindexRuns } from '@/lib/services/rag/ragReindexJob';
import { startRagIngestQueueConsumer } from '@/lib/services/rag/ragIngestConsumer';
import { resumePendingRagIngests } from '@/lib/services/rag/ragIngestJob';
import { startPollScheduler } from '@/lib/services/inferenceMonitoring/pollScheduler';
import { startAlertScheduler } from '@/lib/services/alerts/alertScheduler';
import {
  getEntityMetricsRollupHealth,
  startEntityMetricsRollup,
  stopEntityMetricsRollup,
} from '@/lib/services/entityMetrics/entityMetricsRollup';
import { startRetentionScheduler } from '@/lib/retention/scheduler';
import { startAnalysisScheduler } from '@/lib/services/analysis/analysisScheduler';
import { startRedTeamScheduler } from '@/lib/services/redteam/redTeamScheduler';
import { enterpriseReconcilers , enterpriseQueueConsumers } from '@/enterprise/registry';
import { ensureBootstrapOrganization } from '@/lib/services/auth/bootstrapOrganization';
import { markBootstrapStarted } from './bootstrapMarker';
import { ensureServerEnvLoaded } from './env';
import { resumeDeletingFileBuckets } from './resumeDeletingFileBuckets';

const logger = createLogger('startup');

// Promise-based singleton: concurrent callers must await the SAME in-flight
// run, not return early. It is per module instance, so the run is also marked
// on the process (bootstrapMarker.ts) for Next's instrumentation hook, which
// sees its own bundled copy of this module.
let bootstrapPromise: Promise<void> | null = null;

// The HTTP server now starts listening before this resolves (see app.ts) so
// that boot latency isn't fully on the critical path for "server responds to
// anything at all". Request-handling code that needs bootstrap to have
// finished (the global API `onRequest` hook, `/health/ready`) checks this
// flag instead and returns 503 rather than running against half-initialized
// providers (cache/queue/cluster) or racing the tenant reconciliation pass.
let applicationReady = false;

// Winston's console transport writes to a pipe in a container; exiting in the
// same tick can truncate the very message that explains the exit. Same
// convention as the uncaughtException handler in lifecycle.ts.
const FATAL_EXIT_DELAY_MS = 1000;

/**
 * Turn a boot failure that must never be served through into a dead container.
 *
 * Rejecting is not enough on its own: the only caller of
 * `bootstrapApplication()` that is not itself awaited (app.ts) just logs the
 * rejection, so the process would stay up with `applicationReady` false
 * forever — every /api/* request answering 503 while the liveness probe keeps
 * passing, so Kubernetes never restarts the pod and the rolling update
 * happily replaces all three healthy replicas with permanently dead ones.
 * Exiting non-zero restarts the container, keeps readiness failing, and stalls
 * the rollout on the previous (working) ReplicaSet.
 */
function scheduleFatalExit(message: string): void {
  logger.error(`FATAL: ${message}`);
  setTimeout(() => process.exit(1), FATAL_EXIT_DELAY_MS).unref();
}

/**
 * The authorization engine decides every request of every workspace, so a
 * process that cannot run it must not serve: load Cedar, compile the managed
 * policy set and the schema, evaluate a few canned decisions (lib/iam/selfTest.ts,
 * no database needed). A failure ends the process (see scheduleFatalExit: the
 * rollout stalls on the previous, working ReplicaSet). Success registers the
 * engine in the readiness report (`checks.authorization-engine`).
 */
async function verifyAuthorizationEngine(): Promise<void> {
  try {
    const { engineSelfTest, engineHealth } = await import('@/lib/iam/selfTest');
    const result = engineSelfTest();
    if (!result.ok) throw new Error(result.error);
    registerHealthCheck('authorization-engine', async () => engineHealth());
    logger.info('Authorization engine ready', {
      cedar: result.cedar,
      checks: result.checks,
      durationMs: result.durationMs,
    });
  } catch (error) {
    const message = `Authorization engine self-test failed: ${error instanceof Error ? error.message : String(error)}. `
      + 'Refusing to start - every request is decided by the engine.';
    scheduleFatalExit(message);
    throw new Error(message);
  }
}

/** One boot step that must never stop the rest of boot: a failure is logged and boot carries on. */
async function bestEffort(
  step: () => unknown,
  message: string,
  level: 'warn' | 'error' = 'warn',
): Promise<void> {
  try {
    await step();
  } catch (error) {
    logger[level](message, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function bootstrapApplication(): Promise<void> {
  ensureServerEnvLoaded();

  if (!bootstrapPromise) {
    markBootstrapStarted();
    bootstrapPromise = runBootstrap();
  }
  return bootstrapPromise;
}

export function isApplicationReady(): boolean {
  return applicationReady;
}

async function runBootstrap(): Promise<void> {
  const cfg = getConfig();
  // As early as possible, and unconditionally before any provider/CRM call
  // has a chance to fire: those all use the plain `fetch()` this configures.
  configureOutboundProxy();
  const errors = [...validateConfig(cfg), ...validateServiceSwitchConfig(cfg.services)];

  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(`Config error: ${error.key} - ${error.message}`);
    }
    // Production refuses to serve on an invalid config. These errors cover the
    // signing and at-rest encryption secrets, so booting anyway would run the
    // deployment on the shipped development defaults — a forgeable session
    // token and credentials encrypted under a publicly known key.
    if (cfg.nodeEnv === 'production') {
      const message = `${errors.length} config validation error(s): `
        + `${errors.map((e) => e.key).join(', ')}. `
        + 'Refusing to start in production — fix the reported keys.';
      // Both: the exit is what makes the failure fatal and visible to the
      // orchestrator, the throw is what stops the rest of this bootstrap from
      // running during the flush window.
      scheduleFatalExit(message);
      throw new Error(message);
    }
    logger.warn(
      `${errors.length} config validation error(s). Some features may not work.`,
    );
  }

  // The private networks the operator opened for provider endpoints: one line of counts, and what opens nothing.
  await bestEffort(() => logProviderPrivateNetworks(logger), 'Provider private networks could not be read during startup');

  await verifyAuthorizationEngine();

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
  // actually shortens boot time; each step goes through `bestEffort` so a
  // failure in one never blocks the rest.
  //
  // `tenantReconciliation`'s three steps stay sequential *with each other*:
  // they all read/write through the shared `db` singleton's tenant-switch
  // state (`switchToTenant`/`runWithTenantScope`), which is only safe for
  // one in-flight tenant-scoped call at a time — see the scheduler comments
  // in redTeamScheduler.ts / analysisScheduler.ts for the same rule.
  const coreInfraInit = (async () => {
    await bestEffort(async () => {
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
    }, 'Failed to initialize cache provider', 'error');

    // Cluster + queue init. Both are safe no-ops on a single-node deployment:
    // the registry creates a single row in the `nodes` table and the queue
    // resolves to its in-memory driver when Redis is not configured. No
    // existing service is migrated yet — these are opt-in for future code.
    await bestEffort(async () => {
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
    }, 'Cluster node registration failed; continuing without it');

    await bestEffort(async () => {
      const queue = await getQueue();
      registerShutdownHandler('queue', async () => {
        await destroyQueue();
      });
      registerHealthCheck('queue', async () => ({
        status: 'ok',
        details: { provider: queue.name },
      }));
    }, 'Queue provider init failed; continuing without it');
  })();

  const tenantReconciliation = (async () => {
    await bestEffort(reconcileOrphanedBrowserSessions, 'Browser session reconciliation failed during startup');

    // On-prem: seed the single organization + owner from BOOTSTRAP_* envs.
    // No-op when the envs are unset or a tenant already exists.
    await bestEffort(ensureBootstrapOrganization, 'Bootstrap organization creation failed during startup', 'error');

    // Must complete BEFORE the crawler scheduler/consumers below start taking
    // new work: it treats every `running`/`queued` job as orphaned (resets it
    // and deletes its partial results), so a post-listen job must never be
    // observable here.
    await bestEffort(reconcileOrphanedCrawlJobs, 'Crawl job reconciliation failed during startup');

    // Same "must complete before new work starts" requirement as the crawl
    // reconciler above, for the identical reason: a run created after this
    // point must never be observable as orphaned here.
    await bestEffort(reconcileOrphanedAgentRuns, 'Agent run reconciliation failed during startup');
  })();

  await Promise.all([coreInfraInit, tenantReconciliation]);

  // ── Enterprise overlay seam ──────────────────────────────────────────────
  // Runs enterprise bootstrap reconcilers (e.g. sandbox runtime reconcile).
  // No-op in the community edition.
  for (const reconcile of enterpriseReconcilers) {
    await bestEffort(reconcile, 'Enterprise reconciler failed during startup');
  }

  startPollScheduler();
  startAlertScheduler();

  // Entity health rollup (5-minute buckets). Started here, never lazily from a
  // request: its timers must not inherit a request's tenant scope. Registered
  // after the database and async-task handlers, so on shutdown (LIFO) it runs
  // first: it drains in-flight fire-and-forget emitters itself, then flushes,
  // while the database is still open.
  startEntityMetricsRollup();
  registerShutdownHandler('entity-metrics-rollup', async () => {
    await drainPendingTasks();
    await stopEntityMetricsRollup();
  });
  registerHealthCheck('entity-metrics-rollup', async () => {
    const health = getEntityMetricsRollupHealth();
    return {
      status: health.lastError ? 'degraded' : 'ok',
      ...(health.lastError ? { message: health.lastError } : {}),
      details: {
        pending: health.pending,
        dropped: health.dropped,
        lastFlushAt: health.lastFlushAt?.toISOString() ?? null,
      },
    };
  });

  startCrawlerScheduler();
  // Every node ticks; the per-slot claim in the tenant DB decides who fires.
  startAgentTriggerScheduler();
  registerShutdownHandler('agent-trigger-scheduler', async () => {
    stopAgentTriggerScheduler();
  });
  startAgentRunReconciler();
  startTracingSessionFinalizer();
  startAnalysisScheduler();
  startRedTeamScheduler();

  // Register queue consumers on every node so that whenever instance
  // routing forwards a job to another node, that node can execute it.
  // The consumers are no-ops for memory queue + single-node deployments.
  await bestEffort(() => Promise.all([
    startAgentQueueConsumer(),
    startWebhookQueueConsumer(),
    startMcpQueueConsumer(),
    startBrowserQueueConsumer(),
    startCrawlerQueueConsumer(),
    startOcrJobQueueConsumer(),
    startFilesQueueConsumer(),
    startBatchQueueConsumer(),
    startDatasetGenerationConsumer(),
    startSnapshotQueueConsumer(),
    startRedTeamQueueConsumer(),
    startEvaluationRunQueueConsumer(),
    startVectorMigrationQueueConsumer(),
    startRagReindexQueueConsumer(),
    startRagIngestQueueConsumer(),
    // Enterprise modules contribute their consumers through the seam;
    // the collection is empty in the community edition.
    ...enterpriseQueueConsumers.map((start) => start()),
    startAnalysisRunQueueConsumer(),
    // Central log retention: the cluster-wide tick and the "clean now" purges.
    startRetentionScheduler(),
  ]), 'Queue consumer registration failed; cluster routing limited');

  // Index migrations interrupted by a restart resume from their persisted
  // cursor. Must run AFTER the consumer above is registered.
  await bestEffort(resumeInterruptedVectorMigrations, 'Vector migration resume failed during startup');

  // Same contract for Knowledge Engine re-index runs: they resume from the
  // last document they finished, and only after their consumer is registered.
  await bestEffort(resumeInterruptedRagReindexRuns, 'Knowledge Engine re-index resume failed during startup');

  // Documents left `pending` by a restart: the memory queue driver drops
  // in-flight jobs, so without this sweep a deferred ingest would never run.
  await bestEffort(resumePendingRagIngests, 'Knowledge Engine ingest resume failed during startup');

  // Buckets a restart left "being deleted": the memory queue driver drops the deletion job with the process, and
  // without this sweep the bucket would stay switched off and marked for good. After the files consumer above.
  await bestEffort(resumeDeletingFileBuckets, 'File bucket deletion resume failed during startup');

  applicationReady = true;

  logger.info('Application started', {
    appUrl: cfg.app.url,
    cacheProvider: cfg.cache.provider,
    corsEnabled: cfg.cors.enabled,
    logLevel: cfg.logging.level,
    nodeEnv: cfg.nodeEnv,
    rateLimitProvider: cfg.rateLimit.provider,
  });
}
