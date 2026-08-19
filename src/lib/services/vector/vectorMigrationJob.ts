/**
 * Vector migration background job.
 *
 * Copying an index can take minutes to hours, so migrations never run inside
 * the HTTP request. `startVectorMigration` marks the record `queued` and
 * publishes a job here; the queue consumer (`vectorMigrationConsumer.ts`)
 * executes it on whichever node picks it up:
 *
 *   - progress (cursor + batch index + heartbeat) is persisted on the
 *     migration record after every batch, so a job that dies mid-way resumes
 *     where it stopped instead of re-copying everything;
 *   - `resumeInterruptedVectorMigrations` re-enqueues `queued`/`running`
 *     records at boot, which is what makes the memory queue driver survive a
 *     restart;
 *   - cancellation is read from the DB on every batch boundary, so it works
 *     across nodes (the in-memory set only makes it instant on this node).
 */

import { getDatabase, runWithTenantScope, type DatabaseProvider } from '@/lib/database';
import type { IVectorIndexRecord } from '@/lib/database';
import type { IVectorMigration } from '@/lib/database/provider/types.base';
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { runtimePool, hashCredentials } from '@/lib/core/runtimePool';
import {
  providerRegistry,
  type VectorProviderRuntime,
  type VectorIndexHandle,
} from '@/lib/providers';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';

const logger = createLogger('vector-migration-job');

export const VECTOR_MIGRATION_QUEUE = 'vector-migration';
export const VECTOR_MIGRATION_JOB = 'vector-migration.run';

export interface VectorMigrationJobPayload extends QueuePayload {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  migrationKey: string;
}

/** Progress checkpoint kept inside `migration.metadata`. */
interface MigrationProgress {
  cursor?: string;
  batchIndex?: number;
  heartbeatAt?: string;
}

// Cancellation requested on THIS node — lets a running loop stop before its
// next DB read. The DB status is the cross-node source of truth.
const cancelRequests = new Set<string>();

// Keys currently executing in this process, so a duplicate delivery (or a
// resume sweep racing an in-flight job) cannot copy the same batch twice.
const activeMigrations = new Set<string>();

export function requestVectorMigrationCancel(key: string): void {
  cancelRequests.add(key);
}

export async function enqueueVectorMigration(
  payload: VectorMigrationJobPayload,
): Promise<void> {
  cancelRequests.delete(payload.migrationKey);
  const queue = await getQueue();
  await queue.publish(VECTOR_MIGRATION_QUEUE, VECTOR_MIGRATION_JOB, payload, {
    // Retries are handled by the job itself (it resumes from the cursor);
    // a driver-level retry would double-report progress.
    attempts: 1,
    dedupKey: `${payload.tenantDbName}:${payload.migrationKey}`,
  });
}

function readProgress(migration: IVectorMigration): MigrationProgress {
  const metadata = migration.metadata ?? {};
  const progress = (metadata.progress ?? {}) as MigrationProgress;
  return {
    cursor: typeof progress.cursor === 'string' ? progress.cursor : undefined,
    batchIndex: typeof progress.batchIndex === 'number' ? progress.batchIndex : 0,
    heartbeatAt: typeof progress.heartbeatAt === 'string' ? progress.heartbeatAt : undefined,
  };
}

function withProgress(
  migration: IVectorMigration,
  progress: MigrationProgress,
): Record<string, unknown> {
  return { ...(migration.metadata ?? {}), progress };
}

async function buildRuntime(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
): Promise<VectorProviderRuntime> {
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

  return runtimePool.getOrCreate<VectorProviderRuntime>(
    `vector:${tenantId}:${record.key}`,
    hashCredentials(credentials),
    async () =>
      providerRegistry.createRuntime<VectorProviderRuntime>(record.driver, {
        tenantId,
        providerKey: record.key,
        credentials,
        settings: record.settings ?? {},
        metadata: record.metadata ?? {},
        logger: createLogger(`vector:${record.key}`),
      }),
  );
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

async function isCancelled(db: DatabaseProvider, key: string): Promise<boolean> {
  if (cancelRequests.has(key)) return true;
  const current = await db.findVectorMigrationByKey(key);
  return current?.status === 'cancelled';
}

async function copyVectors(
  db: DatabaseProvider,
  payload: VectorMigrationJobPayload,
  migration: IVectorMigration,
): Promise<void> {
  const { migrationKey, tenantDbName, tenantId, projectId } = payload;

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

  if (sourceIndex.dimension !== destIndex.dimension) {
    throw new Error(
      `Dimension mismatch: source is ${sourceIndex.dimension}, destination is ${destIndex.dimension}.`,
    );
  }

  const [srcRuntime, dstRuntime] = await Promise.all([
    buildRuntime(tenantDbName, tenantId, migration.sourceProviderKey, projectId),
    buildRuntime(tenantDbName, tenantId, migration.destinationProviderKey, projectId),
  ]);

  const srcHandle = toHandle(sourceIndex);
  const dstHandle = toHandle(destIndex);

  const resumed = readProgress(migration);
  let cursor = resumed.cursor;
  let batchIndex = resumed.batchIndex ?? 0;
  let totalMigrated = migration.migratedVectors;
  let totalFailed = migration.failedVectors;

  while (true) {
    if (await isCancelled(db, migrationKey)) {
      cancelRequests.delete(migrationKey);
      await db.updateVectorMigration(migrationKey, {
        status: 'cancelled',
        completedAt: new Date(),
        migratedVectors: totalMigrated,
        failedVectors: totalFailed,
        metadata: withProgress(migration, { cursor, batchIndex, heartbeatAt: new Date().toISOString() }),
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

    if (listResult.items.length === 0) break;

    const batchIds: string[] = [];
    let batchMigrated = 0;
    let batchFailed = 0;
    let batchError: string | undefined;

    try {
      await dstRuntime.upsertVectors(dstHandle, listResult.items);
      batchMigrated = listResult.items.length;
      batchIds.push(...listResult.items.map((item) => item.id));
    } catch (err) {
      batchFailed = listResult.items.length;
      batchError = err instanceof Error ? err.message : String(err);
      logger.warn('Migration batch failed', { migrationKey, batchIndex, error: batchError });
    }

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
      durationMs: Date.now() - batchStart,
    });

    totalMigrated += batchMigrated;
    totalFailed += batchFailed;
    batchIndex += 1;
    cursor = listResult.nextCursor;

    // Checkpoint: progress AND the resume cursor land in the same write, so a
    // crash right after it resumes from exactly this point.
    await db.updateVectorMigration(migrationKey, {
      migratedVectors: totalMigrated,
      failedVectors: totalFailed,
      totalVectors: listResult.total ?? totalMigrated + totalFailed,
      metadata: withProgress(migration, {
        cursor,
        batchIndex,
        heartbeatAt: new Date().toISOString(),
      }),
    });

    if (!cursor) break;
  }

  await db.updateVectorMigration(migrationKey, {
    status: totalMigrated === 0 && totalFailed > 0 ? 'failed' : 'completed',
    completedAt: new Date(),
    migratedVectors: totalMigrated,
    failedVectors: totalFailed,
    errorMessage: totalFailed > 0 ? `${totalFailed} vector(s) failed to migrate.` : undefined,
    metadata: withProgress(migration, {
      cursor: undefined,
      batchIndex,
      heartbeatAt: new Date().toISOString(),
    }),
  });

  logger.info('Migration completed', { migrationKey, totalMigrated, totalFailed });
}

/** Queue handler. Binds the tenant DB for the whole (async) execution. */
export async function runVectorMigrationJob(
  payload: VectorMigrationJobPayload,
): Promise<void> {
  const { migrationKey, tenantDbName } = payload;

  if (activeMigrations.has(`${tenantDbName}:${migrationKey}`)) {
    logger.warn('Migration already running on this node, ignoring duplicate job', { migrationKey });
    return;
  }
  activeMigrations.add(`${tenantDbName}:${migrationKey}`);

  try {
    await runWithTenantScope(tenantDbName, async (db) => {
      const migration = await db.findVectorMigrationByKey(migrationKey);
      if (!migration) {
        logger.error('Migration not found, aborting job', { migrationKey });
        return;
      }
      if (migration.status === 'completed' || migration.status === 'cancelled') {
        return;
      }

      await db.updateVectorMigration(migrationKey, {
        status: 'running',
        startedAt: migration.startedAt ?? new Date(),
        errorMessage: undefined,
      });

      try {
        await copyVectors(db, payload, migration);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Migration failed', { migrationKey, error: errorMessage });
        await db.updateVectorMigration(migrationKey, {
          status: 'failed',
          completedAt: new Date(),
          errorMessage,
        });
      }
    });
  } finally {
    activeMigrations.delete(`${tenantDbName}:${migrationKey}`);
  }
}

/**
 * Re-enqueue migrations left `queued`/`running` by a crash or restart.
 * Called from bootstrap after the consumers are registered; each job resumes
 * from its persisted cursor, so already-copied batches are not repeated.
 */
export async function resumeInterruptedVectorMigrations(): Promise<number> {
  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  let resumed = 0;

  for (const tenant of tenants) {
    if (!tenant.dbName) continue;
    try {
      const pending = await runWithTenantScope(tenant.dbName, (db) =>
        db.listVectorMigrations({ statuses: ['queued', 'running'] }),
      );

      for (const migration of pending) {
        await enqueueVectorMigration({
          tenantDbName: tenant.dbName,
          tenantId: migration.tenantId,
          projectId: migration.projectId,
          migrationKey: migration.key,
        });
        resumed += 1;
      }
    } catch (error) {
      logger.warn('Failed to resume vector migrations for tenant', {
        tenant: tenant.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (resumed > 0) logger.info('Resumed interrupted vector migrations', { resumed });
  return resumed;
}
