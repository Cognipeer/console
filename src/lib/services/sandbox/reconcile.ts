/**
 * Boot-time sandbox reconciliation.
 *
 * The console restart wipes the in-memory map of console-managed runner agents,
 * yet the DB still records runners as `online` and instances as `running`. That
 * leaves new sandboxes stuck in `pending` (commands queued to a dead agent) and
 * existing ones unreachable ("No such container"). On startup we:
 *
 *   1. Re-spawn every runner that was console-managed (labels.managed === 'true').
 *   2. Re-drive every instance that should be running, so the (now live) agent
 *      reuses or recreates its container — idempotently.
 *
 * Mirrors the browser-session reconcile pattern; independent of gpu-fleet.
 */

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { startLocalRunner, isRunnerManaged } from './localRunnerManager';
import { redriveInstance } from './instanceService';

const logger = createLogger('sandbox:reconcile');

const REDRIVE_STATES = new Set(['pending', 'creating', 'starting', 'running']);

// Boot-only: guard against the app's dual bootstrap (instrumentation + custom
// server) re-running reconciliation in the same process, which would spawn a
// redundant managed agent and churn the runner token.
let reconciled = false;

export async function reconcileSandboxRuntime(): Promise<{
  tenantsScanned: number;
  runnersRestarted: number;
  instancesRedriven: number;
}> {
  if (reconciled) return { tenantsScanned: 0, runnersRestarted: 0, instancesRedriven: 0 };
  reconciled = true;
  const port = process.env.PORT ?? '3000';
  const consoleUrl = process.env.SANDBOX_CONSOLE_URL ?? `http://localhost:${port}`;

  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();

  let tenantsScanned = 0;
  let runnersRestarted = 0;
  let instancesRedriven = 0;

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id || !tenant.slug) continue;
    tenantsScanned += 1;
    const tenantDbName = tenant.dbName;
    const tenantId = String(tenant._id);
    const tenantSlug = tenant.slug;

    try {
      const tenantDb = await getTenantDatabase(tenantDbName);
      const runners = await tenantDb.listSandboxRunners();

      // 1) Re-spawn console-managed runners that aren't running anymore.
      const restarted: string[] = [];
      for (const runner of runners) {
        const managed = (runner.labels as Record<string, string> | null)?.managed === 'true';
        if (!managed || isRunnerManaged(runner.id)) continue;
        try {
          await startLocalRunner({ tenantDbName, tenantSlug, runnerId: runner.id, consoleUrl });
          runnersRestarted += 1;
          restarted.push(runner.id);
        } catch (error) {
          logger.warn('failed to restart managed sandbox runner', {
            runnerId: runner.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (restarted.length === 0) continue;

      // 2) Re-drive instances that should be running on the restarted runners.
      const restartedSet = new Set(restarted);
      const instances = await tenantDb.listSandboxInstances();
      for (const inst of instances) {
        if (!inst.runnerId || !restartedSet.has(inst.runnerId)) continue;
        if (inst.desiredState !== 'running') continue;
        if (!REDRIVE_STATES.has(inst.actualState)) continue;
        try {
          if (await redriveInstance(tenantDbName, tenantId, inst.id)) instancesRedriven += 1;
        } catch (error) {
          logger.warn('failed to redrive sandbox instance', {
            instanceId: inst.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.warn('failed to reconcile tenant sandbox runtime', {
        tenantDbName,
        tenantSlug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (runnersRestarted > 0 || instancesRedriven > 0) {
    logger.info('reconciled sandbox runtime', { tenantsScanned, runnersRestarted, instancesRedriven });
  }
  return { tenantsScanned, runnersRestarted, instancesRedriven };
}
