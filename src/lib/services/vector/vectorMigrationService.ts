/**
 * Vector Migration Service
 *
 * Orchestrates the migration of vector data from one index (source) to
 * another (destination). Uses the registered VectorProviderRuntime to
 * page through source vectors and upsert them into the destination.
 *
 * Migration jobs run as fire-and-forget background tasks so that the HTTP
 * request returns immediately while the work proceeds asynchronously.
 */

import slugify from 'slugify';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type {
  IVectorMigration,
  IVectorMigrationLog,
  VectorMigrationStatus,
} from '@/lib/database/provider/types.base';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { runtimePool, hashCredentials } from '@/lib/core/runtimePool';
import {
  providerRegistry,
  type VectorProviderRuntime,
  type VectorIndexHandle,
} from '@/lib/providers';
import {
  loadProviderRuntimeData,
} from '@/lib/services/providers/providerService';
import type { IVectorIndexRecord, IProviderRecord } from '@/lib/database';

const logger = createLogger('vector-migration');

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const FALLBACK_KEY = 'migration';
const MAX_KEY_ATTEMPTS = 50;

// ── In-memory cancel signal registry ────────────────────────────────────
// Keyed by migration key. A running migration polls this set to honour
// cancellation requests.
const cancelRequests = new Set<string>();

// ── Types ────────────────────────────────────────────────────────────────

export interface CreateVectorMigrationRequest {
  name: string;
  description?: string;
  sourceProviderKey: string;
  sourceIndexKey: string;
  destinationProviderKey: string;
  destinationIndexKey: string;
  batchSize?: number;
  createdBy: string;
}

export interface VectorMigrationView extends IVectorMigration {
  logCount?: number;
}

// ── Private helpers ──────────────────────────────────────────────────────

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function normalizeKeyCandidate(input: string | undefined): string {
  const fallback = input && input.trim().length > 0 ? input.trim() : FALLBACK_KEY;
  const slug = slugify(fallback, SLUG_OPTIONS);
  return slug.length > 0 ? slug : FALLBACK_KEY;
}

async function generateUniqueMigrationKey(
  db: DatabaseProvider,
  desired: string | undefined,
): Promise<string> {
  const base = normalizeKeyCandidate(desired);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    const existing = await db.findVectorMigrationByKey(candidate);
    if (!existing) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt + 1}`;
  }

  throw new Error('Could not generate unique migration key.');
}

async function buildRuntime(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
): Promise<{ runtime: VectorProviderRuntime; record: IProviderRecord }> {
  const { record, credentials } = await loadProviderRuntimeData(
    tenantDbName,
    { tenantId, key: providerKey, projectId },
  );

  if (record.type !== 'vector') {
    throw new Error(`Provider "${providerKey}" is not a vector provider.`);
  }
  if (record.status !== 'active') {
    throw new Error(`Provider "${providerKey}" is not active.`);
  }

  const cacheKey = `vector:${tenantId}:${record.key}`;
  const credHash = hashCredentials(credentials);

  const runtime = await runtimePool.getOrCreate<VectorProviderRuntime>(
    cacheKey,
    credHash,
    async () => {
      return providerRegistry.createRuntime<VectorProviderRuntime>(
        record.driver,
        {
          tenantId,
          providerKey: record.key,
          credentials,
          settings: record.settings ?? {},
          metadata: record.metadata ?? {},
          logger: createLogger(`vector:${record.key}`),
        },
      );
    },
  );

  return { runtime, record };
}

function toHandle(index: IVectorIndexRecord): VectorIndexHandle {
  return {
    externalId: index.externalId,
    name: index.name,
    dimension: index.dimension,
    metric: index.metric,
    metadata: index.metadata,
  };
}

// ── Core migration worker ────────────────────────────────────────────────

async function runMigrationWorker(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  migrationKey: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  const migration = await db.findVectorMigrationByKey(migrationKey);

  if (!migration) {
    logger.error('Migration not found, aborting worker', { migrationKey });
    return;
  }

  // Mark as running
  await db.updateVectorMigration(migrationKey, {
    status: 'running',
    startedAt: new Date(),
  });

  try {
    const sourceIndex = await db.findVectorIndexByKey(
      migration.sourceProviderKey,
      migration.sourceIndexKey,
      projectId,
    );
    if (!sourceIndex) {
      throw new Error(
        `Source index "${migration.sourceIndexKey}" not found for provider "${migration.sourceProviderKey}".`,
      );
    }

    const destIndex = await db.findVectorIndexByKey(
      migration.destinationProviderKey,
      migration.destinationIndexKey,
      projectId,
    );
    if (!destIndex) {
      throw new Error(
        `Destination index "${migration.destinationIndexKey}" not found for provider "${migration.destinationProviderKey}".`,
      );
    }

    const { runtime: srcRuntime } = await buildRuntime(
      tenantDbName,
      tenantId,
      migration.sourceProviderKey,
      projectId,
    );
    const { runtime: dstRuntime } = await buildRuntime(
      tenantDbName,
      tenantId,
      migration.destinationProviderKey,
      projectId,
    );

    const srcHandle = toHandle(sourceIndex);
    const dstHandle = toHandle(destIndex);

    let cursor: string | undefined;
    let batchIndex = 0;
    let totalMigrated = 0;
    let totalFailed = 0;

    while (true) {
      // Honour cancellation
      if (cancelRequests.has(migrationKey)) {
        cancelRequests.delete(migrationKey);
        await db.updateVectorMigration(migrationKey, {
          status: 'cancelled',
          completedAt: new Date(),
          migratedVectors: totalMigrated,
          failedVectors: totalFailed,
        });
        logger.info('Migration cancelled', { migrationKey });
        return;
      }

      const batchStart = Date.now();

      let listResult;
      try {
        listResult = await srcRuntime.listVectors(srcHandle, {
          cursor,
          limit: migration.batchSize,
        });
      } catch (err) {
        throw new Error(
          `Source provider does not support vector listing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (listResult.items.length === 0) {
        break; // No more data
      }

      const batchIds: string[] = [];
      let batchMigrated = 0;
      let batchFailed = 0;
      let batchError: string | undefined;

      try {
        await dstRuntime.upsertVectors(dstHandle, listResult.items);
        batchMigrated = listResult.items.length;
        batchIds.push(...listResult.items.map((i) => i.id));
      } catch (err) {
        batchFailed = listResult.items.length;
        batchError = err instanceof Error ? err.message : String(err);
        logger.warn('Migration batch failed', {
          migrationKey,
          batchIndex,
          error: batchError,
        });
      }

      const durationMs = Date.now() - batchStart;

      // Persist log for this batch
      await db.createVectorMigrationLog({
        tenantId,
        projectId,
        migrationKey,
        batchIndex,
        vectorIds: batchIds,
        status: batchFailed > 0 ? 'failed' : 'success',
        migratedCount: batchMigrated,
        failedCount: batchFailed,
        errorMessage: batchError,
        durationMs,
      });

      totalMigrated += batchMigrated;
      totalFailed += batchFailed;

      // Update progress
      await db.updateVectorMigration(migrationKey, {
        migratedVectors: totalMigrated,
        failedVectors: totalFailed,
        totalVectors: listResult.total ?? totalMigrated + totalFailed,
      });

      batchIndex += 1;

      if (!listResult.nextCursor) {
        break; // Exhausted all pages
      }

      cursor = listResult.nextCursor;
    }

    await db.updateVectorMigration(migrationKey, {
      status: totalFailed > 0 ? 'completed' : 'completed',
      completedAt: new Date(),
      migratedVectors: totalMigrated,
      failedVectors: totalFailed,
    });

    logger.info('Migration completed', { migrationKey, totalMigrated, totalFailed });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Migration failed', { migrationKey, error: errorMessage });

    await db.updateVectorMigration(migrationKey, {
      status: 'failed',
      completedAt: new Date(),
      errorMessage,
    });
  }
}

// ── Public service functions ─────────────────────────────────────────────

export async function createVectorMigration(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  userId: string,
  request: CreateVectorMigrationRequest,
): Promise<IVectorMigration> {
  const db = await withTenantDb(tenantDbName);

  // Validate source index exists
  const sourceIndex = await db.findVectorIndexByKey(
    request.sourceProviderKey,
    request.sourceIndexKey,
    projectId,
  );
  if (!sourceIndex) {
    throw new Error(
      `Source vector index "${request.sourceIndexKey}" not found.`,
    );
  }

  // Validate destination index exists
  const destIndex = await db.findVectorIndexByKey(
    request.destinationProviderKey,
    request.destinationIndexKey,
    projectId,
  );
  if (!destIndex) {
    throw new Error(
      `Destination vector index "${request.destinationIndexKey}" not found.`,
    );
  }

  if (
    request.sourceProviderKey === request.destinationProviderKey &&
    request.sourceIndexKey === request.destinationIndexKey
  ) {
    throw new Error('Source and destination index cannot be the same.');
  }

  const key = await generateUniqueMigrationKey(db, request.name);

  return db.createVectorMigration({
    tenantId,
    projectId,
    key,
    name: request.name,
    description: request.description,
    sourceProviderKey: request.sourceProviderKey,
    sourceIndexKey: request.sourceIndexKey,
    sourceIndexName: sourceIndex.name,
    destinationProviderKey: request.destinationProviderKey,
    destinationIndexKey: request.destinationIndexKey,
    destinationIndexName: destIndex.name,
    status: 'pending',
    totalVectors: 0,
    migratedVectors: 0,
    failedVectors: 0,
    batchSize: request.batchSize ?? 100,
    createdBy: request.createdBy,
  });
}

export async function listVectorMigrations(
  tenantDbName: string,
  projectId: string,
  status?: VectorMigrationStatus,
): Promise<IVectorMigration[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listVectorMigrations({ projectId, status });
}

export async function getVectorMigration(
  tenantDbName: string,
  key: string,
): Promise<IVectorMigration | null> {
  const db = await withTenantDb(tenantDbName);
  return db.findVectorMigrationByKey(key);
}

export async function startVectorMigration(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  key: string,
): Promise<IVectorMigration> {
  const db = await withTenantDb(tenantDbName);
  const migration = await db.findVectorMigrationByKey(key);

  if (!migration) {
    throw new Error(`Migration "${key}" not found.`);
  }

  if (migration.status === 'running') {
    throw new Error('Migration is already running.');
  }

  if (migration.status === 'completed') {
    throw new Error('Migration has already completed. Create a new migration to run again.');
  }

  // Reset progress if re-starting after failure/cancellation
  const updated = await db.updateVectorMigration(key, {
    status: 'pending',
    migratedVectors: 0,
    failedVectors: 0,
    totalVectors: 0,
    errorMessage: undefined,
    startedAt: undefined,
    completedAt: undefined,
  });

  if (!updated) {
    throw new Error(`Failed to update migration "${key}".`);
  }

  // Launch background worker
  fireAndForget(`vector-migration:${key}`, () =>
    runMigrationWorker(tenantDbName, tenantId, migration.projectId, key),
  );

  // Return the latest record after a brief tick
  return (await db.findVectorMigrationByKey(key)) ?? updated;
}

export async function cancelVectorMigration(
  tenantDbName: string,
  key: string,
): Promise<IVectorMigration> {
  const db = await withTenantDb(tenantDbName);
  const migration = await db.findVectorMigrationByKey(key);

  if (!migration) {
    throw new Error(`Migration "${key}" not found.`);
  }

  if (migration.status !== 'running') {
    throw new Error(`Migration is not running (current status: ${migration.status}).`);
  }

  // Signal the worker to stop at the next batch boundary
  cancelRequests.add(key);

  const updated = await db.updateVectorMigration(key, { status: 'cancelled' });
  return updated ?? migration;
}

export async function deleteVectorMigration(
  tenantDbName: string,
  key: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  const migration = await db.findVectorMigrationByKey(key);

  if (!migration) {
    throw new Error(`Migration "${key}" not found.`);
  }

  if (migration.status === 'running') {
    throw new Error('Cannot delete a running migration. Cancel it first.');
  }

  await db.deleteVectorMigration(key);
}

export async function listVectorMigrationLogs(
  tenantDbName: string,
  migrationKey: string,
  options?: { limit?: number; offset?: number },
): Promise<IVectorMigrationLog[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listVectorMigrationLogs(migrationKey, options);
}

export async function countVectorMigrationLogs(
  tenantDbName: string,
  migrationKey: string,
  status?: 'success' | 'failed' | 'skipped',
): Promise<number> {
  const db = await withTenantDb(tenantDbName);
  return db.countVectorMigrationLogs(migrationKey, status);
}
