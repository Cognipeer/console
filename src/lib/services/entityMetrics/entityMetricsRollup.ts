/**
 * Entity metrics rollup — buffers per-entity health counters in memory and
 * periodically flushes them into the `entity_metrics` collection as additive
 * upserts (5-minute buckets, latency histogram, see latencyHistogram.ts).
 *
 * Multi-instance safe: increments are commutative, so concurrent flushers from
 * different processes never conflict. Loss window on crash = one flush
 * interval; acceptable for health analytics (raw logs are written separately).
 *
 * Differences from the usage rollup this is modelled on:
 *  - started explicitly from `server/bootstrap.ts` (timers must not inherit a
 *    request's tenant scope), never lazily from the first event;
 *  - the cap only drops NEW rows, events for buffered keys always merge;
 *  - in-flight guard, tenant concurrency, chunked flush, only failed chunks are
 *    re-buffered;
 *  - own retention loop (TTL is not reliable on every Mongo tier and SQLite has
 *    none).
 */

import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { getCache } from '@/lib/core/cache';
import { getRequestContext } from '@/lib/core/requestContext';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import {
  ENTITY_METRIC_BUCKET_MS,
  ENTITY_METRIC_COUNTER_FIELDS,
  type EntityMetricCounters,
  type EntityMetricSource,
  type EntityMetricType,
  type IEntityMetricIncrement,
} from '@/lib/database/provider/types.base';
import { addLatency, emptyCounters } from './latencyHistogram';

const log = createLogger('entity-metrics-rollup');

const CHUNK_SIZE = 500;
const TENANT_CONCURRENCY = 4;
const MAX_ENTITY_KEY_LENGTH = 200;
const MAX_PAST_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const DAY_MS = 86_400_000;
const WARN_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
const RETENTION_LOCK_KEY = 'scheduler:entity-metrics-retention';
const RETENTION_LOCK_TTL_SECONDS = 10 * 60;
const RETENTION_BATCH_SIZE = 1000;

export interface EntityMetricInput {
  tenantDbName?: string;
  tenantId?: string;
  projectId?: string;
  entityType: EntityMetricType;
  entityKey: string;
  source: EntityMetricSource;
  /** 'none' = counters only (requests 0). Default 'ok'. */
  outcome?: 'ok' | 'error' | 'cancelled' | 'abandoned' | 'none';
  /** Default 1 unless outcome is 'none' (0); may be 0 or negative for corrections. */
  requests?: number;
  /** Recorded into the histogram only when outcome is 'ok' (or `latencyForce`). */
  latencyMs?: number | null;
  /** Record `latencyMs` regardless of outcome (e.g. a correction row that adds the latency of a late-finished session). */
  latencyForce?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  errorEvents?: number;
  toolCalls?: number;
  toolErrors?: number;
  aiCalls?: number;
  aiErrors?: number;
  abandoned?: number;
  emptyResults?: number;
  /** Explicit error delta (corrections); otherwise outcome 'error' => +1. */
  errorsDelta?: number;
  /** Event time (ms); clamped to [now-24h, now+5min], non-finite => now. */
  at?: number;
}

interface BufferedRow {
  tenantId: string;
  projectId: string;
  entityType: EntityMetricType;
  entityKey: string;
  source: EntityMetricSource;
  bucketMs: number;
  counters: EntityMetricCounters;
}

/** tenantDbName -> rowKey -> accumulating row */
const buffer = new Map<string, Map<string, BufferedRow>>();
let pendingRows = 0;
let droppedRows = 0;
/** tenantDbName -> rows dropped (global cap or per-tenant share). */
const droppedByTenant = new Map<string, number>();
let lastDropWarnAt = 0;
let lastFlushAt: Date | null = null;
let lastError: string | null = null;

let flushTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let retentionFirstRunTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let retentionRunning = false;

function rowKey(row: Pick<BufferedRow, 'tenantId' | 'projectId' | 'entityType' | 'entityKey' | 'source' | 'bucketMs'>): string {
  return JSON.stringify([row.tenantId, row.projectId, row.entityType, row.entityKey, row.source, row.bucketMs]);
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function resolveAt(at: number | undefined, now: number): number {
  if (at === undefined || !Number.isFinite(at)) return now;
  return Math.min(Math.max(at, now - MAX_PAST_MS), now + MAX_FUTURE_MS);
}

function accumulate(target: EntityMetricCounters, source: EntityMetricCounters): void {
  for (const field of ENTITY_METRIC_COUNTER_FIELDS) {
    target[field] += source[field];
  }
  if (source.latencyMsMax > target.latencyMsMax) target.latencyMsMax = source.latencyMsMax;
}

function warnDropped(tenantDbName: string): void {
  const now = Date.now();
  if (now - lastDropWarnAt < WARN_INTERVAL_MS) return;
  lastDropWarnAt = now;
  log.warn('Entity metrics buffer is full; dropping new rows', {
    dropped: droppedRows,
    pending: pendingRows,
    tenant: tenantDbName,
    tenantDropped: droppedByTenant.get(tenantDbName) ?? 0,
    cap: getConfig().health.entityMetricsMaxBufferedRows,
  });
}

/**
 * Merge `row` into the buffer. Existing keys always merge; only NEW keys are
 * subject to the cap (dropped and counted).
 */
function bufferRow(tenantDbName: string, row: BufferedRow): void {
  let tenantRows = buffer.get(tenantDbName);
  const key = rowKey(row);
  const existing = tenantRows?.get(key);
  if (existing) {
    accumulate(existing.counters, row.counters);
    return;
  }
  const health = getConfig().health;
  // A tenant may hold only a share of the process-wide cap: row cardinality is
  // client-influenced (event timestamps, model/tool names), so one tenant must
  // not be able to fill the buffer and starve every other tenant's rows.
  const tenantCap = Math.min(health.entityMetricsMaxBufferedRowsPerTenant, health.entityMetricsMaxBufferedRows);
  if (pendingRows >= health.entityMetricsMaxBufferedRows || (tenantRows?.size ?? 0) >= tenantCap) {
    droppedRows += 1;
    droppedByTenant.set(tenantDbName, (droppedByTenant.get(tenantDbName) ?? 0) + 1);
    warnDropped(tenantDbName);
    return;
  }
  if (!tenantRows) {
    tenantRows = new Map();
    buffer.set(tenantDbName, tenantRows);
  }
  tenantRows.set(key, row);
  pendingRows += 1;
}

/**
 * Record one health observation for an entity. Synchronous, cheap and NEVER
 * throws: health accounting must not break the serving path.
 *
 * `tenantDbName` must be passed by the caller (the request context does not
 * carry it); `tenantId` / `projectId` fall back to the request context.
 */
export function recordEntityMetric(input: EntityMetricInput): void {
  try {
    const entityKey = typeof input.entityKey === 'string'
      ? input.entityKey.trim().slice(0, MAX_ENTITY_KEY_LENGTH)
      : '';
    if (!entityKey) return;
    const tenantDbName = input.tenantDbName;
    if (!tenantDbName) return;
    const ctx = getRequestContext();
    const tenantId = input.tenantId ?? ctx?.tenantId;
    if (!tenantId) return;
    const projectId = input.projectId ?? ctx?.projectId ?? '';

    const now = Date.now();
    const at = resolveAt(input.at, now);
    const bucketMs = at - (at % ENTITY_METRIC_BUCKET_MS);

    const outcome = input.outcome ?? 'ok';
    const counters = emptyCounters();
    counters.requests = input.requests !== undefined ? finite(input.requests) : (outcome === 'none' ? 0 : 1);
    counters.errors = input.errorsDelta !== undefined ? finite(input.errorsDelta) : (outcome === 'error' ? 1 : 0);
    counters.cancelled = outcome === 'cancelled' ? 1 : 0;
    counters.abandoned = input.abandoned !== undefined ? finite(input.abandoned) : (outcome === 'abandoned' ? 1 : 0);
    counters.inputTokens = finite(input.inputTokens);
    counters.outputTokens = finite(input.outputTokens);
    counters.costUsd = finite(input.costUsd);
    counters.errorEvents = finite(input.errorEvents);
    counters.toolCalls = finite(input.toolCalls);
    counters.toolErrors = finite(input.toolErrors);
    counters.aiCalls = finite(input.aiCalls);
    counters.aiErrors = finite(input.aiErrors);
    counters.emptyResults = finite(input.emptyResults);

    const latency = input.latencyMs;
    if ((outcome === 'ok' || input.latencyForce) && typeof latency === 'number' && Number.isFinite(latency) && latency >= 0) {
      addLatency(counters, latency);
    }

    // A row that adds nothing is not worth a buffer slot.
    const hasData = counters.latencyCount > 0
      || ENTITY_METRIC_COUNTER_FIELDS.some((field) => counters[field] !== 0);
    if (!hasData) return;

    bufferRow(tenantDbName, {
      tenantId,
      projectId,
      entityType: input.entityType,
      entityKey,
      source: input.source,
      bucketMs,
      counters,
    });
  } catch {
    // Best effort by contract.
  }
}

function toIncrement(row: BufferedRow, retentionDays: number): IEntityMetricIncrement {
  return {
    tenantId: row.tenantId,
    projectId: row.projectId,
    entityType: row.entityType,
    entityKey: row.entityKey,
    source: row.source,
    bucketMs: row.bucketMs,
    expiresAtMs: row.bucketMs + retentionDays * DAY_MS,
    ...row.counters,
  };
}

async function flushTenant(
  tenantDbName: string,
  rows: BufferedRow[],
  retentionDays: number,
): Promise<string | null> {
  let firstError: string | null = null;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      const increments = chunk.map((row) => toIncrement(row, retentionDays));
      await runWithTenantScope(tenantDbName, (db) => db.incrementEntityMetrics(increments));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      firstError ??= message;
      for (const row of chunk) bufferRow(tenantDbName, row);
      log.warn('Entity metrics chunk failed; re-buffered for the next flush (a partially applied chunk can be counted twice: at-least-once)', {
        tenant: tenantDbName,
        rows: chunk.length,
        error: message,
      });
    }
  }
  return firstError;
}

async function doFlush(): Promise<void> {
  if (buffer.size === 0) {
    lastFlushAt = new Date();
    return;
  }
  const snapshot = new Map(buffer);
  buffer.clear();
  pendingRows = 0;

  let errorMessage: string | null = null;
  try {
    const retentionDays = getConfig().health.entityMetricsRetentionDays;
    const queue = [...snapshot.entries()].map(([tenantDbName, rows]) => ({
      tenantDbName,
      rows: [...rows.values()],
    }));
    const workers = Array.from({ length: Math.min(TENANT_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const error = await flushTenant(next.tenantDbName, next.rows, retentionDays);
        if (error) errorMessage ??= error;
      }
    });
    await Promise.all(workers);
  } catch (err) {
    // Not expected: flushTenant catches per chunk. Re-buffering the whole
    // snapshot here could double count chunks that already applied, so only
    // the failure is recorded.
    errorMessage = err instanceof Error ? err.message : String(err);
    log.error('Entity metrics flush crashed', { error: errorMessage });
  }
  lastError = errorMessage;
  lastFlushAt = new Date();
}

/** Flush the buffer now. Never rejects; concurrent calls run one after another. */
export function flushEntityMetricsRollup(): Promise<void> {
  const previous = inFlight ?? Promise.resolve();
  const run = previous.then(doFlush, doFlush).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

/** Delete buckets older than the retention window in every tenant. Returns the number of purged rows. */
export async function runEntityMetricsRetention(): Promise<number> {
  if (retentionRunning) return 0;
  retentionRunning = true;
  let lockToken: string | undefined;
  let purged = 0;
  try {
    const cache = await getCache();
    lockToken = await cache.acquireLock(RETENTION_LOCK_KEY, RETENTION_LOCK_TTL_SECONDS);
    if (!lockToken) return 0;

    const olderThanMs = Date.now() - getConfig().health.entityMetricsRetentionDays * DAY_MS;
    const mainDb = await getDatabase();
    const tenants = await mainDb.listTenants();
    for (const tenant of tenants) {
      if (!tenant.dbName) continue;
      try {
        purged += await runWithTenantScope(tenant.dbName, (db) =>
          db.purgeEntityMetrics({ olderThanMs, batchSize: RETENTION_BATCH_SIZE }),
        );
      } catch (err) {
        log.warn('Entity metrics retention failed for tenant', {
          tenant: tenant.slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (purged > 0) log.info(`Entity metrics retention purged ${purged} row(s)`);
  } catch (err) {
    log.warn('Entity metrics retention run failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (lockToken) {
      try {
        const cache = await getCache();
        await cache.releaseLock(RETENTION_LOCK_KEY, lockToken);
      } catch {
        // Lock expires on its own.
      }
    }
    retentionRunning = false;
  }
  return purged;
}

/**
 * Start the flush + retention loops. Idempotent. Call from `server/bootstrap.ts`
 * (never lazily from a request: timers inherit the tenant scope of their creator).
 */
export function startEntityMetricsRollup(): void {
  if (flushTimer) return;
  const cfg = getConfig().health;

  flushTimer = setInterval(() => {
    if (inFlight) return;
    void flushEntityMetricsRollup();
  }, cfg.entityMetricsFlushMs);
  flushTimer.unref();

  retentionTimer = setInterval(() => {
    void runEntityMetricsRetention();
  }, RETENTION_INTERVAL_MS);
  retentionTimer.unref();
  retentionFirstRunTimer = setTimeout(() => {
    retentionFirstRunTimer = null;
    void runEntityMetricsRetention();
  }, RETENTION_FIRST_RUN_DELAY_MS);
  retentionFirstRunTimer.unref();
}

function clearTimers(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  if (retentionFirstRunTimer) clearTimeout(retentionFirstRunTimer);
  flushTimer = null;
  retentionTimer = null;
  retentionFirstRunTimer = null;
}

/** Stop the loops and flush what is buffered. */
export async function stopEntityMetricsRollup(): Promise<void> {
  clearTimers();
  await flushEntityMetricsRollup();
}

export function getEntityMetricsRollupHealth(): {
  pending: number;
  dropped: number;
  /** Rows dropped per tenant database (cap or per-tenant share). */
  droppedByTenant: Record<string, number>;
  lastFlushAt: Date | null;
  lastError: string | null;
} {
  return { pending: pendingRows, dropped: droppedRows, droppedByTenant: Object.fromEntries(droppedByTenant), lastFlushAt, lastError };
}

/** Test helper: drop all state and timers. */
export function __resetEntityMetricsRollupForTests(): void {
  clearTimers();
  buffer.clear();
  pendingRows = 0;
  droppedRows = 0;
  droppedByTenant.clear();
  lastDropWarnAt = 0;
  lastFlushAt = null;
  lastError = null;
  inFlight = null;
  retentionRunning = false;
}
