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
import type { IAgentTracingSession } from '@/lib/database/provider/types.base';
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

export async function sweepStaleTracingSessions(now = Date.now()): Promise<TracingFinalizerResult> {
  const staleMinutes = getConfig().health.tracingStaleSessionMinutes;
  const updatedBefore = new Date(now - staleMinutes * 60_000);
  const otlpQuietBefore = new Date(now - Math.min(OTLP_QUIET_MINUTES, staleMinutes) * 60_000);
  const deadline = Date.now() + SWEEP_BUDGET_MS;

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
        const quiet = await db.listStaleAgentTracingSessions({ updatedBefore: otlpQuietBefore, limit: OTLP_PASS_LIMIT });
        for (const candidate of quiet) {
          if (candidate.source !== 'otlp') continue;
          if (Date.now() > deadline) break;
          const projectId = candidate.projectId ?? '';
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
          await recordAgentSessionOutcome({
            tenantDbName,
            tenantId: claimed.tenantId || tenantId,
            projectId: claimed.projectId ?? projectId,
            session: { ...claimed, status },
            previousOutcome: claimed.metricsOutcome,
            source: 'tracing',
            atMs: Date.now(),
          });
        }

        for (let page = 0; page < MAX_PAGES_PER_TENANT; page += 1) {
          const stale = await db.listStaleAgentTracingSessions({ updatedBefore, limit: PAGE_SIZE });
          for (const candidate of stale) {
            const abandoned = await db.abandonAgentTracingSession({
              projectId: candidate.projectId ?? '',
              sessionId: candidate.sessionId,
              updatedBefore,
            });
            // null: a late event or /end won the race.
            if (!abandoned) continue;
            result.abandoned += 1;
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
