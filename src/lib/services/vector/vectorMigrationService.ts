/**
 * Vector Migration Service
 *
 * CRUD + lifecycle for migrations that copy vector data from one index
 * (source) to another (destination). The copying itself never happens in the
 * HTTP request: `startVectorMigration` queues a background job
 * (`vectorMigrationJob.ts`), which is resumable and cancellable.
 */

import slugify from 'slugify';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type {
  IVectorMigration,
  IVectorMigrationLog,
  IVectorMigrationRunSummary,
  VectorMigrationStatus,
} from '@/lib/database/provider/types.base';
import {
  enqueueVectorMigration,
  requestVectorMigrationCancel,
} from './vectorMigrationJob';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const FALLBACK_KEY = 'migration';
const MAX_KEY_ATTEMPTS = 50;

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
    attempt: 0,
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

  if (migration.status === 'running' || migration.status === 'queued') {
    throw new Error('Migration is already running.');
  }

  if (migration.status === 'completed') {
    throw new Error('Migration has already completed. Create a new migration to run again.');
  }

  // A restart always copies from scratch: counters, error and the resume
  // checkpoint in metadata are all cleared. `attempt` bumps so this run's
  // batch logs land in a fresh group instead of mixing with the last run's.
  const updated = await db.updateVectorMigration(key, {
    status: 'queued',
    attempt: (migration.attempt ?? 0) + 1,
    migratedVectors: 0,
    failedVectors: 0,
    totalVectors: 0,
    errorMessage: undefined,
    startedAt: undefined,
    completedAt: undefined,
    metadata: { ...(migration.metadata ?? {}), progress: {} },
  });

  if (!updated) {
    throw new Error(`Failed to update migration "${key}".`);
  }

  await enqueueVectorMigration({
    tenantDbName,
    tenantId,
    projectId: migration.projectId ?? projectId,
    migrationKey: key,
  });

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

  if (migration.status !== 'running' && migration.status !== 'queued') {
    throw new Error(`Migration is not running (current status: ${migration.status}).`);
  }

  // Persisted status is what a worker on any node reads at its next batch
  // boundary; the in-memory signal just makes it immediate on this node.
  requestVectorMigrationCancel(key);

  const updated = await db.updateVectorMigration(key, {
    status: 'cancelled',
    completedAt: new Date(),
  });
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

  if (migration.status === 'running' || migration.status === 'queued') {
    throw new Error('Cannot delete a running migration. Cancel it first.');
  }

  await db.deleteVectorMigration(key);
}

export async function listVectorMigrationLogs(
  tenantDbName: string,
  migrationKey: string,
  options?: { limit?: number; offset?: number; attempt?: number },
): Promise<IVectorMigrationLog[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listVectorMigrationLogs(migrationKey, options);
}

export async function countVectorMigrationLogs(
  tenantDbName: string,
  migrationKey: string,
  status?: 'success' | 'failed' | 'skipped',
  attempt?: number,
): Promise<number> {
  const db = await withTenantDb(tenantDbName);
  return db.countVectorMigrationLogs(migrationKey, status, attempt);
}

export async function listVectorMigrationRuns(
  tenantDbName: string,
  migrationKey: string,
): Promise<IVectorMigrationRunSummary[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listVectorMigrationRuns(migrationKey);
}
