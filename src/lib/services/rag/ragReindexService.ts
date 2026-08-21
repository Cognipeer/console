/**
 * Knowledge Engine re-index service
 *
 * CRUD + lifecycle for the runs that rebuild every document in a module after
 * its chunk config or embedding model changed. The rebuild itself never
 * happens in the HTTP request: `startRagReindex` queues a background job
 * (`ragReindexJob.ts`), which is resumable and cancellable.
 */

import slugify from 'slugify';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { IRagReindexRun } from '@/lib/database/provider/types.domain';
import { enqueueRagReindex, requestRagReindexCancel, moduleReindexFingerprint } from './ragReindexJob';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const FALLBACK_KEY = 'module';
const MAX_KEY_ATTEMPTS = 50;
const ACTIVE_STATUSES: IRagReindexRun['status'][] = ['pending', 'queued', 'running'];

export interface StartRagReindexRequest {
  ragModuleKey: string;
  reason?: IRagReindexRun['reason'];
  batchSize?: number;
  createdBy: string;
}

// ── Private helpers ──────────────────────────────────────────────────────

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

async function generateUniqueRunKey(
  db: DatabaseProvider,
  ragModuleKey: string,
): Promise<string> {
  const slug = slugify(ragModuleKey, SLUG_OPTIONS);
  const base = `${slug.length > 0 ? slug : FALLBACK_KEY}-reindex`;

  // Runs accumulate for the lifetime of a module, so the key carries a time
  // suffix instead of a collision counter that would have to walk every run
  // the module ever had.
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
    const candidate = `${base}-${Date.now().toString(36)}${attempt > 0 ? `-${attempt}` : ''}`;
    const existing = await db.findRagReindexRunByKey(candidate);
    if (!existing) return candidate;
  }

  throw new Error('Could not generate unique re-index run key.');
}

/** Drop the module's pointer at `runKey`, leaving another run's pointer alone. */
async function releaseModuleRun(
  db: DatabaseProvider,
  ragModuleKey: string,
  projectId: string | undefined,
  runKey: string,
): Promise<void> {
  const ragModule = await db.findRagModuleByKey(ragModuleKey, projectId);
  if (!ragModule?._id || ragModule.activeReindexRunKey !== runKey) return;
  await db.updateRagModule(String(ragModule._id), { activeReindexRunKey: undefined });
}

// ── Public service functions ─────────────────────────────────────────────

export async function startRagReindex(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  request: StartRagReindexRequest,
): Promise<IRagReindexRun> {
  const db = await withTenantDb(tenantDbName);

  const ragModule = await db.findRagModuleByKey(request.ragModuleKey, projectId);
  if (!ragModule) {
    throw new Error(`Knowledge Engine module "${request.ragModuleKey}" not found.`);
  }
  if (ragModule.status !== 'active') {
    throw new Error('Knowledge Engine module is not active.');
  }

  // The run records, not the module's pointer, decide whether one is in
  // flight: the pointer can outlive a run that was cancelled while its node
  // was down.
  const inFlight = await db.listRagReindexRuns({
    ragModuleKey: request.ragModuleKey,
    projectId,
    statuses: ACTIVE_STATUSES,
    limit: 1,
  });
  if (inFlight.length > 0) {
    throw new Error('A re-index is already running for this module.');
  }

  const key = await generateUniqueRunKey(db, request.ragModuleKey);
  const run = await db.createRagReindexRun({
    tenantId,
    projectId,
    key,
    ragModuleKey: request.ragModuleKey,
    status: 'queued',
    reason: request.reason ?? 'manual',
    attempt: 1,
    totalDocuments: await db.countRagDocuments(request.ragModuleKey, projectId),
    processedDocuments: 0,
    failedDocuments: 0,
    batchSize: request.batchSize ?? 1,
    progress: {},
    // The configuration this run rebuilds against. If the module is changed
    // again while it is in flight, the run must not report the module fresh on
    // completion — it rebuilt the previous configuration.
    metadata: { moduleFingerprint: moduleReindexFingerprint(ragModule) },
    createdBy: request.createdBy,
  });

  await db.updateRagModule(String(ragModule._id), { activeReindexRunKey: key });

  await enqueueRagReindex({ tenantDbName, tenantId, projectId, runKey: key });

  return run;
}

export async function listRagReindexRuns(
  tenantDbName: string,
  ragModuleKey?: string,
  options?: {
    projectId?: string;
    statuses?: IRagReindexRun['status'][];
    limit?: number;
  },
): Promise<IRagReindexRun[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listRagReindexRuns({ ragModuleKey, ...options });
}

export async function getRagReindexRun(
  tenantDbName: string,
  key: string,
): Promise<IRagReindexRun | null> {
  const db = await withTenantDb(tenantDbName);
  return db.findRagReindexRunByKey(key);
}

/** The run a module's progress banner should be following, if any. */
export async function getActiveRagReindexRun(
  tenantDbName: string,
  ragModuleKey: string,
  projectId?: string,
): Promise<IRagReindexRun | null> {
  const db = await withTenantDb(tenantDbName);
  const runs = await db.listRagReindexRuns({
    ragModuleKey,
    projectId,
    statuses: ACTIVE_STATUSES,
    limit: 1,
  });
  return runs[0] ?? null;
}

export async function cancelRagReindex(
  tenantDbName: string,
  key: string,
): Promise<IRagReindexRun> {
  const db = await withTenantDb(tenantDbName);
  const run = await db.findRagReindexRunByKey(key);

  if (!run) {
    throw new Error(`Re-index run "${key}" not found.`);
  }
  if (!ACTIVE_STATUSES.includes(run.status)) {
    throw new Error(`Re-index run is not running (current status: ${run.status}).`);
  }

  // Persisted status is what a worker on any node reads at its next document
  // boundary; the in-memory signal just makes it immediate on this node.
  requestRagReindexCancel(key);

  const updated = await db.updateRagReindexRun(key, {
    status: 'cancelled',
    completedAt: new Date(),
  });

  // A run cancelled before any worker picked it up never reaches the job's own
  // cleanup, so the module would keep pointing at it forever.
  await releaseModuleRun(db, run.ragModuleKey, run.projectId, key);

  return updated ?? run;
}

export async function deleteRagReindexRun(
  tenantDbName: string,
  key: string,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  const run = await db.findRagReindexRunByKey(key);

  if (!run) {
    throw new Error(`Re-index run "${key}" not found.`);
  }
  if (ACTIVE_STATUSES.includes(run.status)) {
    throw new Error('Cannot delete a running re-index. Cancel it first.');
  }

  await db.deleteRagReindexRun(key);
}
