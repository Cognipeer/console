import { getDatabase, getTenantDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { browserManager } from './browserManager';

const logger = createLogger('browser:operations');

const ACTIVE_SESSION_STATUSES = new Set(['pending', 'running', 'idle']);

export async function reconcileOrphanedBrowserSessions(): Promise<{
  sessionsReconciled: number;
  tenantsScanned: number;
}> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();

  let tenantsScanned = 0;
  let sessionsReconciled = 0;

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    tenantsScanned += 1;

    try {
      const tenantDb = await getTenantDatabase(tenant.dbName);
      const tenantId = String(tenant._id);
      const sessions = await tenantDb.listBrowserSessions(tenantId);

      for (const session of sessions) {
        if (!ACTIVE_SESSION_STATUSES.has(session.status)) continue;
        if (browserManager.hasSession(session.sessionKey)) continue;

        await tenantDb.updateBrowserSession(String(session._id), {
          endedAt: new Date(),
          errorMessage: session.errorMessage ?? 'Browser runtime restarted before the session completed',
          status: 'expired',
          updatedBy: 'system:browser-reconcile',
        });
        sessionsReconciled += 1;
      }
    } catch (error) {
      logger.warn('Failed to reconcile tenant browser sessions', {
        error: error instanceof Error ? error.message : String(error),
        tenantDbName: tenant.dbName,
        tenantSlug: tenant.slug,
      });
    }
  }

  if (sessionsReconciled > 0) {
    logger.info('Reconciled orphaned browser sessions', {
      sessionsReconciled,
      tenantsScanned,
    });
  }

  return { sessionsReconciled, tenantsScanned };
}
