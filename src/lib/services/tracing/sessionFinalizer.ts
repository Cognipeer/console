/**
 * Stale tracing session finalizer.
 *
 * A traced run that never reports an end (process killed, network cut, an
 * OTLP root span that never exported) would stay 'in_progress' forever and
 * hide from every health view. This sweep does two things:
 *
 *  1. OTLP sessions (`source === 'otlp'`) have no end signal except a root span
 *     (no parent) that may never be exported (remote W3C parent, a dropped HTTP
 *     root). After a short quiet window (`OTLP_QUIET_MINUTES`, capped by the
 *     stale window) they are FINALIZED from what was received: 'error' when any
 *     error was recorded, else 'success', and booked as that outcome. Spans
 *     arriving later correct the booking like any late event.
 *     A run that is waiting for a person is not finished and not abandoned: an OTLP session whose latest event
 *     is `pending` (an approval or a question, which the SDK marks with `cognipeer.event.status`) is left open
 *     until it becomes history, so the leg that follows the answer lands in the same session.
 *  2. Every other session whose last activity is older than
 *     `health.tracingStaleSessionMinutes` is marked 'abandoned' (not an error)
 *     and booked as such. A late `/end` or root span revives the session and is
 *     booked as a correction.
 *
 * Runs on its own slow timer (not the 30 s run reconciler tick). The write is a
 * compare-and-set in the database, so overlapping sweeps (or a late event
 * racing the sweep) never abandon a session twice; the cache lock only avoids
 * the duplicate work.
 */

import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import { getConfig } from '@/lib/core/config';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import type { DatabaseProvider } from '@/lib/database';
import type { IAgentTracingSession } from '@/lib/database/provider/types.base';
import { foldSupersededSpans } from '@/lib/shared/foldSupersededSpans';
import { createTraceModelPricerLoader, type TraceModelPricerLoader } from '@/lib/services/agentTracing';
import { recordAgentSessionOutcome } from './traceEntityMetrics';

const logger = createLogger('tracing-session-finalizer');

const SCHEDULER_LOCK_KEY = 'scheduler:tracing-session-finalizer';
/** Longer than the sweep budget, so a slow sweep never loses its lock to the next tick. */
const SCHEDULER_LOCK_TTL_SECONDS = 10 * 60;
const PAGE_SIZE = 500;
/** Per tenant and sweep: bounds the work when a long outage left many sessions behind. */
const MAX_PAGES_PER_TENANT = 10;
const SWEEP_BUDGET_MS = 4 * 60_000;
/**
 * Idle time after which an OTLP session without an end signal is finalized
 * from the spans received. A module constant (the health config section is owned elsewhere); never above the stale window.
 */
const OTLP_QUIET_MINUTES = 10;
/** One fetch (no paging: finalized sessions stay behind as candidates only while they are skipped). */
const OTLP_PASS_LIMIT = 2000;
/**
 * A session whose last activity is older than this (and than the stale window plus a margin) is history, not
 * current health: it is closed so it stops being a candidate, but no outcome is booked for it. Without the cap
 * the first sweep on an existing tenant would book every session ever stranded 'in_progress' as a fresh
 * request + abandon in the current rollup bucket.
 */
const HISTORY_AGE_MS = 24 * 60 * 60_000;
const HISTORY_MARGIN_MS = 60 * 60_000;

export interface TracingFinalizerResult {
  tenantsScanned: number;
  abandoned: number;
  /** OTLP sessions finalized as success or error after the quiet window. */
  finalized: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * One pass over every tenant, without the process guard or the cache lock.
 * Exported for tests (two concurrent passes must abandon or finalize each session once).
 */
/** 'error' when any error was recorded on the run (events or root exception), else 'success'. */
function deriveOtlpFinalStatus(session: IAgentTracingSession): 'error' | 'success' {
  const errored = (session.errorEvents ?? 0) > 0
    || (session.toolErrors ?? 0) > 0
    || (session.aiErrors ?? 0) > 0
    || (Array.isArray(session.errors) && session.errors.length > 0);
  return errored ? 'error' : 'success';
}

/**
 * True while an OTLP run is parked on a person: after the sub-agent records are folded, the latest event
 * (highest sequence, then newest) is still `pending`. The SDK exports a paused run's spans but not its root, so
 * this is the only signal the Console has that a quiet session is waiting rather than gone. A failed read counts
 * as "not waiting", which is what the sweep did before this check existed.
 */
async function isAwaitingPerson(db: DatabaseProvider, session: IAgentTracingSession): Promise<boolean> {
  try {
    const events = foldSupersededSpans(await db.listAgentTracingEvents(
      session.sessionId,
      session.projectId || undefined,
      { projection: { sections: 0, metadata: 0, actor: 0 } },
    ));
    let latest: (typeof events)[number] | undefined;
    const stamp = (event: (typeof events)[number]) => (event.timestamp ? new Date(event.timestamp).getTime() : 0);
    for (const event of events) {
      if (!latest) { latest = event; continue; }
      const bySequence = (event.sequence ?? 0) - (latest.sequence ?? 0);
      if (bySequence > 0 || (bySequence === 0 && stamp(event) >= stamp(latest))) latest = event;
    }
    return latest?.status === 'pending';
  } catch (error) {
    logger.warn('Could not read the latest event of an OTLP session', {
      sessionId: session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function sweepStaleTracingSessions(now = Date.now()): Promise<TracingFinalizerResult> {
  const staleMinutes = getConfig().health.tracingStaleSessionMinutes;
  const updatedBefore = new Date(now - staleMinutes * 60_000);
  const otlpQuietBefore = new Date(now - Math.min(OTLP_QUIET_MINUTES, staleMinutes) * 60_000);
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  const historyBeforeMs = now - Math.max(HISTORY_AGE_MS, staleMinutes * 60_000 + HISTORY_MARGIN_MS);
  // One lazy, memoized model-price loader per (tenant, project) and sweep: the Model Hub is read once, not once per session.
  const pricerLoaders = new Map<string, TraceModelPricerLoader>();
  const pricerLoaderFor = (tenantDbName: string, projectId: string): TraceModelPricerLoader => {
    const key = `${tenantDbName}\u0001${projectId}`;
    let loader = pricerLoaders.get(key);
    if (!loader) {
      loader = createTraceModelPricerLoader(tenantDbName, projectId || undefined);
      pricerLoaders.set(key, loader);
    }
    return loader;
  };
  /** Last activity older than the history cap (unknown time: not history). */
  const isHistory = (lastActivity: unknown): boolean => {
    if (lastActivity === undefined || lastActivity === null) return false;
    const at = new Date(lastActivity as Date | string).getTime();
    return Number.isFinite(at) && at < historyBeforeMs;
  };

  const mainDb = await getDatabase();
  const tenants = await mainDb.listTenants();
  const result: TracingFinalizerResult = { tenantsScanned: 0, abandoned: 0, finalized: 0 };

  for (const tenant of tenants) {
    if (!tenant.dbName || !tenant._id) continue;
    if (Date.now() > deadline) break;
    result.tenantsScanned += 1;
    const tenantDbName = tenant.dbName;
    const tenantId = String(tenant._id);

    try {
      await runWithTenantScope(tenantDbName, async (db) => {
        // OTLP first: a quiet OTLP run that is also past the stale window is finalized, not abandoned.
        // The source filter is applied by the database: idle runs of other sources (waiting for the stale window)
        // must not use up the page limit and starve the OTLP sessions behind them.
        const quiet = await db.listStaleAgentTracingSessions({ updatedBefore: otlpQuietBefore, limit: OTLP_PASS_LIMIT, source: 'otlp' });
        for (const candidate of quiet) {
          if (Date.now() > deadline) break;
          const projectId = candidate.projectId ?? '';
          // Waiting for an approval or an answer: not finished, not gone, until it is history.
          if (!isHistory(candidate.updatedAt) && await isAwaitingPerson(db, candidate)) continue;
          // The abandon CAS is the atomic claim (a late span or an overlapping sweep wins or loses here);
          // the final status is then written over 'abandoned', keeping its endedAt/durationMs (last activity).
          const claimed = await db.abandonAgentTracingSession({
            projectId,
            sessionId: candidate.sessionId,
            updatedBefore: otlpQuietBefore,
          });
          if (!claimed) continue;
          const status = deriveOtlpFinalStatus(claimed);
          await db.updateAgentTracingSession(claimed.sessionId, { status }, projectId || undefined);
          result.finalized += 1;
          if (isHistory(candidate.updatedAt)) continue;
          await recordAgentSessionOutcome({
            tenantDbName,
            tenantId: claimed.tenantId || tenantId,
            projectId: claimed.projectId ?? projectId,
            session: { ...claimed, status },
            previousOutcome: claimed.metricsOutcome,
            source: 'tracing',
            atMs: Date.now(),
            pricerLoader: pricerLoaderFor(tenantDbName, claimed.projectId ?? projectId),
          });
        }

        for (let page = 0; page < MAX_PAGES_PER_TENANT; page += 1) {
          const stale = await db.listStaleAgentTracingSessions({ updatedBefore, limit: PAGE_SIZE });
          for (const candidate of stale) {
            // The stale window is shorter than a person may take to answer; the same guard as the OTLP pass.
            if (candidate.source === 'otlp' && !isHistory(candidate.updatedAt) && await isAwaitingPerson(db, candidate)) continue;
            const abandoned = await db.abandonAgentTracingSession({
              projectId: candidate.projectId ?? '',
              sessionId: candidate.sessionId,
              updatedBefore,
            });
            // null: a late event or /end won the race.
            if (!abandoned) continue;
            result.abandoned += 1;
            if (isHistory(candidate.updatedAt)) continue;
            await recordAgentSessionOutcome({
              tenantDbName,
              tenantId: abandoned.tenantId || tenantId,
              projectId: abandoned.projectId ?? candidate.projectId ?? '',
              session: abandoned,
              previousOutcome: abandoned.metricsOutcome,
              // Hosted runs stamp their agent key into the metadata; everything else is an external trace.
              source: abandoned.metadata?.agentKey ? 'hosted' : 'tracing',
              // The abandon happens now, whenever the run last made progress.
              atMs: Date.now(),
              pricerLoader: pricerLoaderFor(tenantDbName, abandoned.projectId ?? candidate.projectId ?? ''),
            });
          }
          if (stale.length < PAGE_SIZE || Date.now() > deadline) break;
        }
      });
    } catch (error) {
      logger.error('Tracing session finalizer failed for tenant', {
        tenant: tenant.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function runOnce(): Promise<TracingFinalizerResult> {
  const empty: TracingFinalizerResult = { tenantsScanned: 0, abandoned: 0, finalized: 0 };
  if (running) return empty;
  running = true;
  let lockToken: string | undefined;

  try {
    const cache = await getCache();
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    if (!lockToken) return empty;

    const result = await sweepStaleTracingSessions();
    if (result.abandoned > 0 || result.finalized > 0) {
      logger.info('Closed stale tracing sessions', { ...result });
    }
    return result;
  } catch (error) {
    logger.error('Tracing session finalizer run failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  } finally {
    if (lockToken) {
      try {
        const cache = await getCache();
        await cache.releaseLock(SCHEDULER_LOCK_KEY, lockToken);
      } catch (error) {
        logger.warn('Failed to release tracing session finalizer lock', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    running = false;
  }
}

/** Start the periodic sweep (idempotent). Called from `server/bootstrap.ts`, never lazily from a request. */
export function startTracingSessionFinalizer(): void {
  if (timer !== null) return;
  const intervalMs = getConfig().health.tracingFinalizerIntervalMs;
  logger.info(`Started (interval: ${Math.round(intervalMs / 1000)}s)`);
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  if (timer.unref) timer.unref();
}

export function stopTracingSessionFinalizer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Run one guarded sweep now (tests, manual triggers). */
export async function triggerTracingSessionFinalizerRun(): Promise<TracingFinalizerResult> {
  return runOnce();
}
