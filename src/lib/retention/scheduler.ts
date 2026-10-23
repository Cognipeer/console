/**
 * Retention jobs on the queue provider (BullMQ with Redis, in-process without).
 *
 *   tick    every RETENTION_INTERVAL_SECONDS, once per cluster: one `sweep` per tenant
 *   sweep   one tenant under its policy, for at most RETENTION_BUDGET_SECONDS;
 *           an unfinished sweep queues its own continuation
 *   purge   "Clean now" from the retention page: same engine, no dry run,
 *           its progress and cancel flag kept in the cache
 *
 * Nothing here needs the database for coordination: the per-tenant lock, the
 * purge status and the redaction watermarks live in the cache. What must
 * outlive Redis (the policy, the destruction records) is in the tenant
 * database. With `RETENTION_DRY_RUN` (the default until an operator turns it
 * off) a sweep only counts; a purge always acts.
 */

import { randomUUID } from 'node:crypto';
import { getCache, type CacheProvider } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getQueue } from '@/lib/core/queue';
import type { JobContext, QueuePayload } from '@/lib/core/queue';
import { getDatabase, runWithTenantScope, type DatabaseProvider } from '@/lib/database';
import { isRetentionClassId, type RetentionClassId } from './classes';
import { planWork, runWork, totalsByClass, type RetentionMode, type RetentionRunResult, type WatermarkStore } from './engine';
import { loadPolicy } from './policy';

const log = createLogger('retention');

export const RETENTION_QUEUE = 'retention';
const HOUR_MS = 3_600_000;
const DAY_SECONDS = 86_400;
const CONTINUE_DELAY_MS = 60_000;
const LOCK_RETRY_DELAY_MS = 30_000;
const PURGE_STATUS_TTL_SECONDS = 7 * DAY_SECONDS;
const LAST_SWEEP_TTL_SECONDS = 30 * DAY_SECONDS;
const WATERMARK_TTL_SECONDS = 30 * DAY_SECONDS;
/** A dry-run sweep leaves a record at most this often (it counts the same rows every hour). */
const DRY_RUN_RECORD_EVERY_SECONDS = DAY_SECONDS;
const BOOT_TICK_DELAY_MS = 2 * 60_000;

export interface TenantRef {
  tenantDbName: string;
  tenantId: string;
  tenantSlug: string;
}

export interface PurgeRequest {
  mode: RetentionMode;
  classes?: RetentionClassId[];
  projectId?: string;
}

export type PurgeState = 'queued' | 'running' | 'waiting' | 'done' | 'cancelled' | 'failed';

export interface PurgeStatus {
  id: string;
  state: PurgeState;
  request: PurgeRequest;
  requestedBy: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Last write; an active purge not written for a while was lost with its process. */
  updatedAt: string;
  /** Rows the preview counted when the purge was started. */
  estimate: number | null;
  deleted: number;
  redacted: number;
  byClass: Partial<Record<RetentionClassId, { deleted: number; redacted: number }>>;
  errors: number;
  error: string | null;
}

export interface SweepSummary {
  at: string;
  dryRun: boolean;
  done: boolean;
  deleted: number;
  redacted: number;
  byClass: Partial<Record<RetentionClassId, { deleted: number; redacted: number }>>;
  errors: number;
}

const ACTIVE_STATES: ReadonlySet<PurgeState> = new Set(['queued', 'running', 'waiting']);

// ── cache-backed state ────────────────────────────────────────────────────
// `CACHE_PROVIDER=none` keeps nothing, so a single-node install without a
// cache keeps the state in this process (the in-process queue runs the purge
// here too).

const local = new Map<string, unknown>();

type StateStore = Pick<CacheProvider, 'get' | 'set' | 'del'>;

async function store(): Promise<StateStore> {
  const cache = await getCache();
  if (cache.name !== 'none') return cache;
  return {
    get: async <T>(key: string) => local.get(key) as T | undefined,
    set: async (key: string, value: unknown) => { local.set(key, value); },
    del: async (key: string) => { local.delete(key); },
  };
}

async function stateGet<T>(key: string): Promise<T | undefined> {
  return (await store()).get<T>(key);
}

async function stateSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  await (await store()).set(key, value, ttlSeconds);
}

async function stateDel(key: string): Promise<void> {
  await (await store()).del(key);
}

const lockKey = (db: string) => `retention:lock:${db}`;
const purgeKey = (db: string) => `retention:purge:${db}`;
const cancelKey = (db: string) => `retention:purge-cancel:${db}`;
const lastSweepKey = (db: string) => `retention:last-sweep:${db}`;
const dryRecordKey = (db: string) => `retention:dry-record:${db}`;

function watermarks(tenantDbName: string): WatermarkStore {
  return {
    get: (key) => stateGet<string>(`retention:wm:${tenantDbName}:${key}`),
    set: (key, value) => stateSet(`retention:wm:${tenantDbName}:${key}`, value, WATERMARK_TTL_SECONDS),
  };
}

async function withTenantLock<T>(tenantDbName: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const cfg = getConfig().retention;
  const cache = await getCache();
  const key = lockKey(tenantDbName);
  const token = await cache.acquireLock(key, cfg.budgetSeconds + 300);
  if (!token) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    await cache.releaseLock(key, token).catch(() => undefined);
  }
}

// ── records ───────────────────────────────────────────────────────────────

async function writeRecord(
  db: DatabaseProvider,
  tenant: TenantRef,
  event: 'retention.sweep' | 'retention.purge',
  result: Pick<RetentionRunResult, 'dryRun' | 'deleted' | 'redacted' | 'errors'> & { byClass: SweepSummary['byClass'] },
  extra: { actorEmail?: string | null; metadata?: Record<string, unknown>; outcome?: 'success' | 'failure' },
): Promise<void> {
  await db.createAuditLog({
    tenantId: tenant.tenantId,
    actorType: extra.actorEmail ? 'user' : 'system',
    ...(extra.actorEmail ? { actorEmail: extra.actorEmail } : {}),
    service: 'retention',
    action: 'admin',
    event,
    outcome: extra.outcome ?? (result.errors > 0 ? 'failure' : 'success'),
    resourceType: 'retention',
    metadata: {
      dryRun: result.dryRun,
      deleted: result.deleted,
      redacted: result.redacted,
      errors: result.errors,
      byClass: result.byClass,
      ...extra.metadata,
    },
  });
}

// ── sweep ─────────────────────────────────────────────────────────────────

/** One budget slice of a tenant's scheduled sweep. Returns false when it must continue. */
export async function sweepTenant(tenant: TenantRef, now = new Date()): Promise<boolean> {
  const cfg = getConfig().retention;
  const outcome = await withTenantLock(tenant.tenantDbName, () =>
    runWithTenantScope(tenant.tenantDbName, async (db) => {
      const policy = await loadPolicy(db, now);
      const items = planWork(policy, { mode: { kind: 'policy' }, now });
      const result = await runWork(db, items, {
        dryRun: cfg.dryRun,
        batchSize: cfg.batchSize,
        deadline: Date.now() + cfg.budgetSeconds * 1000,
        watermarks: watermarks(tenant.tenantDbName),
      });
      const summary: SweepSummary = {
        at: now.toISOString(),
        dryRun: result.dryRun,
        done: result.done,
        deleted: result.deleted,
        redacted: result.redacted,
        byClass: totalsByClass(result.items),
        errors: result.errors,
      };
      await stateSet(lastSweepKey(tenant.tenantDbName), summary, LAST_SWEEP_TTL_SECONDS);

      let record = result.deleted + result.redacted > 0 || result.errors > 0;
      if (record && result.dryRun) {
        record = !(await stateGet<string>(dryRecordKey(tenant.tenantDbName)));
        if (record) await stateSet(dryRecordKey(tenant.tenantDbName), summary.at, DRY_RUN_RECORD_EVERY_SECONDS);
      }
      if (record) {
        await writeRecord(db, tenant, 'retention.sweep', { ...result, byClass: summary.byClass }, {
          metadata: { done: result.done, policyVersion: policy.version },
        });
      }
      return result.done;
    }),
  );
  // Locked by a purge or another node's sweep: the next tick tries again.
  return outcome.ran ? outcome.value : true;
}

// ── purge ─────────────────────────────────────────────────────────────────

export class RetentionPurgeConflictError extends Error {
  constructor() {
    super('A purge is already running for this workspace');
    this.name = 'RetentionPurgeConflictError';
  }
}

/** An active purge that has not written its status for this long died with its process (memory queue, crash). */
function staleAfterMs(): number {
  return (getConfig().retention.budgetSeconds + 600) * 1000;
}

export async function getPurgeStatus(tenantDbName: string): Promise<PurgeStatus | null> {
  const status = await stateGet<PurgeStatus>(purgeKey(tenantDbName));
  if (!status) return null;
  if (ACTIVE_STATES.has(status.state) && Date.now() - Date.parse(status.updatedAt) > staleAfterMs()) {
    return { ...status, state: 'failed', error: 'Interrupted (the process running it stopped)' };
  }
  return status;
}

export async function getLastSweep(tenantDbName: string): Promise<SweepSummary | null> {
  return (await stateGet<SweepSummary>(lastSweepKey(tenantDbName))) ?? null;
}

export async function requestPurge(
  tenant: TenantRef,
  request: PurgeRequest,
  requestedBy: string | null,
  estimate: number | null,
): Promise<PurgeStatus> {
  const current = await getPurgeStatus(tenant.tenantDbName);
  if (current && ACTIVE_STATES.has(current.state)) throw new RetentionPurgeConflictError();
  const status: PurgeStatus = {
    id: randomUUID(),
    state: 'queued',
    request,
    requestedBy,
    requestedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date().toISOString(),
    estimate,
    deleted: 0,
    redacted: 0,
    byClass: {},
    errors: 0,
    error: null,
  };
  await stateDel(cancelKey(tenant.tenantDbName));
  await stateSet(purgeKey(tenant.tenantDbName), status, PURGE_STATUS_TTL_SECONDS);
  const queue = await getQueue();
  await queue.publish(RETENTION_QUEUE, 'purge', { ...tenant, purgeId: status.id }, { attempts: 1, dedupKey: `retention-purge-${status.id}-0` });
  return status;
}

/** Asks a queued or running purge to stop after its current batch. */
export async function cancelPurge(tenantDbName: string): Promise<PurgeStatus | null> {
  const current = await getPurgeStatus(tenantDbName);
  if (!current || !ACTIVE_STATES.has(current.state)) return current;
  await stateSet(cancelKey(tenantDbName), current.id, PURGE_STATUS_TTL_SECONDS);
  return current;
}

function mergeByClass(into: PurgeStatus['byClass'], add: PurgeStatus['byClass']): PurgeStatus['byClass'] {
  const out = { ...into };
  for (const [id, totals] of Object.entries(add)) {
    if (!isRetentionClassId(id) || !totals) continue;
    const prev = out[id] ?? { deleted: 0, redacted: 0 };
    out[id] = { deleted: prev.deleted + totals.deleted, redacted: prev.redacted + totals.redacted };
  }
  return out;
}

/** One budget slice of a purge; queues the next slice itself. */
export async function runPurgeSlice(tenant: TenantRef, purgeId: string, slice: number): Promise<void> {
  const cfg = getConfig().retention;
  const key = purgeKey(tenant.tenantDbName);
  const status = await getPurgeStatus(tenant.tenantDbName);
  if (!status || status.id !== purgeId || !ACTIVE_STATES.has(status.state)) return;

  const save = (next: PurgeStatus) => stateSet(key, { ...next, updatedAt: new Date().toISOString() }, PURGE_STATUS_TTL_SECONDS);
  const isCancelled = async () => (await stateGet<string>(cancelKey(tenant.tenantDbName))) === purgeId;
  const queue = await getQueue();
  const requeue = (delayMs: number) =>
    queue.publish(RETENTION_QUEUE, 'purge', { ...tenant, purgeId, slice: slice + 1 }, {
      attempts: 1,
      delayMs,
      dedupKey: `retention-purge-${purgeId}-${slice + 1}`,
    });

  if (await isCancelled()) {
    await finishPurge(tenant, { ...status, state: 'cancelled', finishedAt: new Date().toISOString() });
    return;
  }

  let current: PurgeStatus = { ...status, state: 'running', startedAt: status.startedAt ?? new Date().toISOString() };
  const outcome = await withTenantLock(tenant.tenantDbName, () =>
    runWithTenantScope(tenant.tenantDbName, async (db) => {
      await save(current);
      // The cut-off stays where it was when the purge was asked for.
      const now = new Date(status.requestedAt);
      const policy = await loadPolicy(db);
      const items = planWork(policy, { ...status.request, now });
      const base = { deleted: current.deleted, redacted: current.redacted, errors: current.errors, byClass: current.byClass };
      const merge = (result: RetentionRunResult): PurgeStatus => ({
        ...current,
        deleted: base.deleted + result.deleted,
        redacted: base.redacted + result.redacted,
        errors: base.errors + result.errors,
        byClass: mergeByClass(base.byClass, totalsByClass(result.items)),
      });
      // Progress is written at most every 2 s: a batch takes milliseconds.
      let lastWrite = 0;
      const result = await runWork(db, items, {
        dryRun: false,
        batchSize: cfg.batchSize,
        deadline: Date.now() + cfg.budgetSeconds * 1000,
        isCancelled,
        onProgress: async (partial) => {
          if (Date.now() - lastWrite < 2000) return;
          lastWrite = Date.now();
          await save(merge(partial));
        },
      });
      current = merge(result);
      return result;
    }),
  );

  if (!outcome.ran) {
    // A scheduled sweep holds the tenant: try again shortly.
    await save({ ...current, state: 'waiting' });
    await requeue(LOCK_RETRY_DELAY_MS);
    return;
  }
  const result = outcome.value;
  if (result.cancelled) {
    await finishPurge(tenant, { ...current, state: 'cancelled', finishedAt: new Date().toISOString() });
    return;
  }
  if (!result.done) {
    await save(current);
    await requeue(0);
    return;
  }
  await finishPurge(tenant, { ...current, state: 'done', finishedAt: new Date().toISOString() });
}

async function finishPurge(tenant: TenantRef, status: PurgeStatus): Promise<void> {
  await stateSet(purgeKey(tenant.tenantDbName), { ...status, updatedAt: new Date().toISOString() }, PURGE_STATUS_TTL_SECONDS);
  await stateDel(cancelKey(tenant.tenantDbName));
  await runWithTenantScope(tenant.tenantDbName, (db) =>
    writeRecord(db, tenant, 'retention.purge', { dryRun: false, ...status }, {
      actorEmail: status.requestedBy,
      outcome: status.state === 'failed' || status.errors > 0 ? 'failure' : 'success',
      metadata: {
        purgeId: status.id,
        state: status.state,
        request: status.request,
        estimate: status.estimate,
        requestedAt: status.requestedAt,
        finishedAt: status.finishedAt,
      },
    }),
  ).catch((err) => log.warn('Retention purge record failed', { tenant: tenant.tenantSlug, error: String(err) }));
}

async function failPurge(tenant: TenantRef, purgeId: string, err: unknown): Promise<void> {
  const status = await getPurgeStatus(tenant.tenantDbName);
  if (!status || status.id !== purgeId) return;
  await finishPurge(tenant, {
    ...status,
    state: 'failed',
    error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    finishedAt: new Date().toISOString(),
  });
}

// ── jobs ──────────────────────────────────────────────────────────────────

function tenantFrom(data: QueuePayload): TenantRef | null {
  const { tenantDbName, tenantId, tenantSlug } = data as Record<string, unknown>;
  if (typeof tenantDbName !== 'string' || !tenantDbName) return null;
  return { tenantDbName, tenantId: String(tenantId ?? ''), tenantSlug: String(tenantSlug ?? '') };
}

/** Queues one sweep per tenant (the hour bucket keeps a second tick in the same hour from doubling them). */
export async function enqueueSweeps(now = Date.now()): Promise<number> {
  const queue = await getQueue();
  const tenants = await (await getDatabase()).listTenants();
  const bucket = Math.floor(now / HOUR_MS);
  let queued = 0;
  for (const tenant of tenants) {
    if (!tenant.dbName) continue;
    const ref: TenantRef = { tenantDbName: tenant.dbName, tenantId: String(tenant._id ?? ''), tenantSlug: tenant.slug };
    await queue.publish(RETENTION_QUEUE, 'sweep', { ...ref }, { attempts: 1, dedupKey: `retention-sweep-${tenant.dbName}-${bucket}` });
    queued += 1;
  }
  return queued;
}

export async function handleRetentionJob(ctx: JobContext<QueuePayload>): Promise<unknown> {
  if (ctx.name === 'tick') {
    if (!getConfig().retention.enabled) return { skipped: true };
    return { queued: await enqueueSweeps() };
  }
  const tenant = tenantFrom(ctx.data);
  if (!tenant) return { skipped: true };

  if (ctx.name === 'sweep') {
    if (!getConfig().retention.enabled) return { skipped: true };
    const done = await sweepTenant(tenant);
    if (!done) {
      const queue = await getQueue();
      await queue.publish(RETENTION_QUEUE, 'sweep', { ...tenant }, {
        attempts: 1,
        delayMs: CONTINUE_DELAY_MS,
        dedupKey: `retention-sweep-${tenant.tenantDbName}-c-${Date.now()}`,
      });
    }
    return { done };
  }

  if (ctx.name === 'purge') {
    const purgeId = String(ctx.data.purgeId ?? '');
    const slice = Number(ctx.data.slice ?? 0) || 0;
    try {
      await runPurgeSlice(tenant, purgeId, slice);
    } catch (err) {
      log.warn('Retention purge failed', { tenant: tenant.tenantSlug, error: String(err) });
      await failPurge(tenant, purgeId, err);
    }
    return { ok: true };
  }
  throw new Error(`Unknown retention job: ${ctx.name}`);
}

let started = false;

/**
 * Registers the consumer on every node (a purge must run even when scheduled
 * sweeps are off) and, when the engine is enabled, the cluster-wide tick.
 */
export async function startRetentionScheduler(): Promise<void> {
  if (started) return;
  started = true;
  const cfg = getConfig().retention;
  const queue = await getQueue();
  queue.consume(RETENTION_QUEUE, handleRetentionJob, { concurrency: 2 });
  if (!cfg.enabled) {
    log.info('Retention engine disabled (RETENTION_ENGINE_ENABLED=false); manual purge only');
    return;
  }
  await queue.schedule('retention-tick', RETENTION_QUEUE, 'tick', {}, { everyMs: cfg.intervalSeconds * 1000 });
  // The first sweep a little after boot, not an interval later.
  await queue.publish(RETENTION_QUEUE, 'tick', {}, {
    attempts: 1,
    delayMs: BOOT_TICK_DELAY_MS,
    dedupKey: `retention-boot-${Math.floor(Date.now() / HOUR_MS)}`,
  });
  log.info('Retention engine started', { dryRun: cfg.dryRun, intervalSeconds: cfg.intervalSeconds });
}
