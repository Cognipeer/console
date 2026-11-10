/**
 * One-time (and repeatable) move of existing web search providers to the two-layer model: every own websearch
 * provider record gets a tenant-wide instance with the same key that carries the behavior settings, and the
 * provider keeps only the connection. Agent bindings, quota policies, run logs and cache entries are keyed by that
 * search key, so they keep matching.
 *
 * Once per provider: a provider that has been handled carries `metadata.behaviorOnInstances` (set here, and at
 * creation for providers made after the move) and is never touched again, so an instance the user deleted does not
 * come back and a connection-only provider does not get an instance of its own. A provider that an instance
 * already uses gets no new one. The behavior keys are stripped from the provider (a copy stays in
 * `metadata.migratedBehavior` for one release so the change can be rolled back). A key conflict is left unmarked so
 * it stays visible. Credentials and connection settings are never logged.
 *
 * Runs at boot for every tenant, on both database backends, through the tenant-scoped database API.
 */

import { getDatabase, runWithTenantScope, type DatabaseProvider } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { isManagedProviderRecord } from '@/enterprise/managed-credits';
import { splitWebSearchSettings } from '@/lib/providers/contracts/webSearchContracts';

const logger = createLogger('websearch-instance-migration');

const SYSTEM_ACTOR = 'system:websearch-instance-migration';

export interface WebSearchMigrationResult {
  providers: number;
  created: number;
  stripped: number;
  skipped: number;
  conflicts: string[];
}

export async function migrateWebSearchProvidersForTenant(
  db: DatabaseProvider,
  tenantId: string,
): Promise<WebSearchMigrationResult> {
  const result: WebSearchMigrationResult = { providers: 0, created: 0, stripped: 0, skipped: 0, conflicts: [] };
  const providers = await db.listProviders(tenantId, { type: 'websearch' });

  for (const provider of providers) {
    if (provider.platform === true || isManagedProviderRecord(provider)) {
      result.skipped += 1;
      continue;
    }
    if (provider.metadata?.behaviorOnInstances === true) {
      result.skipped += 1;
      continue;
    }
    result.providers += 1;
    const { connection, behavior } = splitWebSearchSettings(provider.driver, provider.settings);

    const existing = await db.findWebSearchInstanceByKey(tenantId, provider.key);
    if (existing && existing.providerKey !== provider.key) {
      // The key belongs to an instance of another provider: leave both alone.
      result.conflicts.push(provider.key);
      logger.warn('Web search provider key is taken by an instance of another provider; left as it is', {
        tenantId,
        key: provider.key,
        instanceProviderKey: existing.providerKey,
      });
      continue;
    }

    // An instance of any key on this provider already holds its behavior: nothing to create.
    const used = Boolean(existing) || (await db.listWebSearchInstances(tenantId, { providerKey: provider.key })).length > 0;
    if (!used) {
      await db.createWebSearchInstance({
        tenantId,
        projectId: null,
        key: provider.key,
        name: provider.label || provider.key,
        description: provider.description,
        providerKey: provider.key,
        status: provider.status === 'disabled' ? 'disabled' : 'active',
        settings: behavior,
        metadata: { migratedFromProvider: true },
        createdBy: provider.createdBy || SYSTEM_ACTOR,
        updatedBy: SYSTEM_ACTOR,
      });
      result.created += 1;
    }

    const hasBehavior = Object.keys(behavior).length > 0;
    await db.updateProvider(String(provider._id), {
      ...(hasBehavior ? { settings: connection } : {}),
      metadata: {
        ...(provider.metadata ?? {}),
        ...(hasBehavior ? { migratedBehavior: behavior } : {}),
        behaviorOnInstances: true,
      },
      updatedBy: SYSTEM_ACTOR,
    });
    if (hasBehavior) result.stripped += 1;
  }
  return result;
}

/** Boot sweep over every tenant. A failing tenant is logged and does not stop the others. */
export async function migrateWebSearchProvidersToInstances(): Promise<WebSearchMigrationResult> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const total: WebSearchMigrationResult = { providers: 0, created: 0, stripped: 0, skipped: 0, conflicts: [] };

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    const tenantId = String(tenant._id);
    try {
      const r = await runWithTenantScope(tenant.dbName, (db) => migrateWebSearchProvidersForTenant(db, tenantId));
      total.providers += r.providers;
      total.created += r.created;
      total.stripped += r.stripped;
      total.skipped += r.skipped;
      total.conflicts.push(...r.conflicts);
    } catch (error) {
      logger.warn('Web search instance migration failed for tenant', {
        tenant: tenant.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (total.created || total.stripped) logger.info('Web search providers migrated to instances', { ...total });
  return total;
}
