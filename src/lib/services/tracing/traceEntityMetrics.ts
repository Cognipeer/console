/**
 * Entity-health emission for traced agents.
 *
 * Two feeds, both written through `recordEntityMetric` (5-minute buckets):
 *
 *  - `recordTraceEventMetrics`: per-event call and error counters on the AGENT
 *    row and, for externally traced agents only (`source: 'tracing'`), one
 *    model row per `ai_call` and one tool row per `tool_call`. Hosted runs emit
 *    agent rows only: their model and tool calls are counted where they execute
 *    (gateway, tool and MCP services).
 *  - `recordAgentSessionOutcome`: the session itself (requests, errors,
 *    abandoned, duration, tokens, cost), counted ONCE per terminal outcome. What
 *    was already counted is stored on the session (`metricsOutcome`), so a late
 *    `/end` on an abandoned session or a late error on a finished one only emits
 *    a correction row.
 *
 * A run that pauses for a person (agent-sdk ≥ 0.14: a tool approval, a question, a client tool) reports `paused`
 * and resumes into the same session. It is booked once, when it finishes, over the events of every part, and its
 * latency is the agent's time: wall-clock time minus the time spent waiting on people or the calling app.
 *
 * Booking time of events: event timestamps are client-controlled, and an ingest of old events would otherwise
 * touch up to 288 five-minute buckets per key. For externally traced runs (`source: 'tracing'`) the time an event is
 * booked at is clamped to [now - 3 h, now + 5 min]: an event between 3 h and 24 h old is booked at the now-3h bucket
 * (its counts are kept, only its time moves), a later one at now + 5 min. Events older than 24 h are still skipped
 * (history, re-imports) and hosted runs, whose times are the console's own, keep theirs.
 *
 * Known limitation: tokens and cost are booked with the FIRST terminal outcome
 * only (`metricsOutcome` stores no booked totals, so growth cannot be booked as
 * a delta). Legs of a multi-leg run that end after the first `/end`, and events
 * that arrive after an abandon followed by a revive, change status/latency
 * through a correction row but add no tokens or cost. Closing this needs a
 * `booked` totals field on `metricsOutcome` (database layer).
 *
 * Nothing here throws: health accounting must not break ingestion.
 */

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { IAgentTracingSession } from '@/lib/database/provider/types.base';
import {
  createTraceModelPricerLoader,
  eventModelName,
  isGatewayServed,
  type TraceModelPricer,
  type TraceModelPricerLoader,
} from '@/lib/services/agentTracing';
import { recordEntityMetric } from '@/lib/services/entityMetrics/entityMetricsRollup';
import {
  countTraceErrors,
  isErrorTraceEvent,
  isRunTraceEvent,
  type TraceEventLike,
} from '@/lib/shared/traceHealth';

const logger = createLogger('trace-entity-metrics');

const DAY_MS = 86_400_000;
/** Distinct model (and, separately, tool) keys one ingest may create: names come from untrusted event data. */
const MAX_DISTINCT_KEYS_PER_INGEST = 50;
const CAP_WARN_INTERVAL_MS = 60_000;
let lastCapWarnAt = 0;
const FUTURE_SLACK_MS = 5 * 60_000;
/** How far back an externally traced event may be booked (see the header): older events are booked at `now - this`. */
const MAX_BOOKING_PAST_MS = 3 * 60 * 60_000;

export type TraceMetricsSource = 'tracing' | 'hosted';
export type SessionMetricsOutcome = NonNullable<IAgentTracingSession['metricsOutcome']>;

/** Loose event shape accepted from every ingest path (OTLP, batch, stream, hosted sink). */
export interface TraceEntityEventLike extends TraceEventLike {
  id?: unknown;
  spanId?: unknown;
  traceId?: unknown;
  label?: unknown;
  sequence?: unknown;
  timestamp?: unknown;
  modelNames?: unknown;
  toolName?: unknown;
  durationMs?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedInputTokens?: unknown;
  cachedWriteTokens?: unknown;
  metadata?: Record<string, unknown>;
}

// ── Event identity ──────────────────────────────────────────────────────────

export function toIso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Stable identity of an event across re-posts: span id, else event id, else a
 * composite of trace/type/label/sequence/timestamp. Used by the OTLP path to
 * dedupe and by the metrics emitter to subtract what a previous post of the
 * same session already counted.
 */
export function buildEventFingerprint(event: {
  id?: unknown;
  label?: unknown;
  sequence?: unknown;
  spanId?: unknown;
  timestamp?: unknown;
  traceId?: unknown;
  type?: unknown;
}): string {
  if (event.spanId) return `span:${String(event.spanId)}`;
  if (event.id) return `id:${String(event.id)}`;
  return [
    event.traceId || 'no-trace',
    event.type || 'no-type',
    event.label || 'no-label',
    String(event.sequence ?? -1),
    toIso(event.timestamp) || 'no-ts',
  ].join('|');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function eventTimeMs(event: TraceEntityEventLike): number | undefined {
  const iso = toIso(event.timestamp);
  return iso ? Date.parse(iso) : undefined;
}

/** Events older than a day are history (re-imports, replays): never counted as current health. */
function isRecentEvent(event: TraceEntityEventLike, now: number): boolean {
  const at = eventTimeMs(event);
  return at === undefined || at >= now - DAY_MS;
}

/**
 * The time an event is booked at. External traces carry client-controlled times, so they are clamped to
 * [now - 3 h, now + 5 min]; hosted runs keep their own time. No usable time: undefined (the rollup books it at now).
 */
function bookingTimeMs(event: TraceEntityEventLike, source: TraceMetricsSource, now: number): number | undefined {
  const at = eventTimeMs(event);
  if (at === undefined || source !== 'tracing') return at;
  return Math.min(Math.max(at, now - MAX_BOOKING_PAST_MS), now + FUTURE_SLACK_MS);
}

function eventToolName(event: TraceEntityEventLike): string | undefined {
  if (typeof event.toolName === 'string' && event.toolName.trim()) return event.toolName.trim();
  const actor = event.actor;
  if (actor && typeof actor === 'object') {
    const record = actor as Record<string, unknown>;
    if (normalized(record.scope) === 'tool' && typeof record.name === 'string' && record.name.trim()) {
      return record.name.trim();
    }
  }
  return undefined;
}

function modelNameOf(event: TraceEntityEventLike): string | undefined {
  return eventModelName({
    model: typeof event.model === 'string' ? event.model : undefined,
    modelNames: Array.isArray(event.modelNames)
      ? (event.modelNames as unknown[]).filter((name): name is string => typeof name === 'string')
      : undefined,
  });
}

function isGatewayServedEvent(event: TraceEntityEventLike): boolean {
  return isGatewayServed({ metadata: event.metadata });
}

/**
 * Identity used to diff a re-post against what the previous post counted.
 * Events without a span or event id are keyed WITHOUT their timestamp: the
 * batch and hosted paths stamp `new Date()` on events that carry none, so a
 * timestamp would differ on every re-post and recount them.
 */
function diffKey(event: TraceEntityEventLike): string {
  if (event.spanId || event.id) return buildEventFingerprint(event);
  return [
    event.traceId || 'no-trace',
    event.type || 'no-type',
    event.label || 'no-label',
    String(event.sequence ?? -1),
  ].join('|');
}

/** Splits `current` into events not present in `previous` (by identity) and previous events no longer present. */
function diffByIdentity(
  current: TraceEntityEventLike[],
  previous: TraceEntityEventLike[],
): { fresh: TraceEntityEventLike[]; removed: TraceEntityEventLike[] } {
  if (previous.length === 0) return { fresh: current, removed: [] };
  const remaining = new Map<string, TraceEntityEventLike[]>();
  for (const event of previous) {
    const key = diffKey(event);
    const list = remaining.get(key);
    if (list) list.push(event);
    else remaining.set(key, [event]);
  }
  const fresh: TraceEntityEventLike[] = [];
  for (const event of current) {
    const list = remaining.get(diffKey(event));
    if (list && list.length > 0) list.pop();
    else fresh.push(event);
  }
  const removed = [...remaining.values()].flat();
  return { fresh, removed };
}

// ── Per-event counters ──────────────────────────────────────────────────────

export interface RecordTraceEventMetricsParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  /** Agent entity key: the same name the tracing UI uses. */
  agentName?: string;
  /** Events this ingest added. */
  events: TraceEntityEventLike[];
  /** Events a previous post of the same session already counted (batch and hosted re-posts delete and recreate them). */
  previousEvents?: TraceEntityEventLike[];
  source: TraceMetricsSource;
  /** Shared pricer for this ingest; built on demand when omitted. */
  pricerLoader?: TraceModelPricerLoader;
}

function emitAgentCounters(
  params: RecordTraceEventMetricsParams,
  agentKey: string,
  events: TraceEntityEventLike[],
  sign: 1 | -1,
  now: number,
): void {
  for (const event of events) {
    const counts = countTraceErrors([event]);
    if (
      counts.errorEvents === 0 && counts.toolCalls === 0 && counts.aiCalls === 0
      && counts.toolErrors === 0 && counts.aiErrors === 0
    ) continue;
    recordEntityMetric({
      tenantDbName: params.tenantDbName,
      tenantId: params.tenantId,
      projectId: params.projectId ?? '',
      entityType: 'agent',
      entityKey: agentKey,
      source: params.source,
      outcome: 'none',
      errorEvents: sign * counts.errorEvents,
      toolCalls: sign * counts.toolCalls,
      toolErrors: sign * counts.toolErrors,
      aiCalls: sign * counts.aiCalls,
      aiErrors: sign * counts.aiErrors,
      at: bookingTimeMs(event, params.source, now),
    });
  }
}

/** Keeps events of the first MAX_DISTINCT_KEYS_PER_INGEST distinct keys (by first appearance); the rest are dropped with a rate-limited warning. */
function capDistinctKeys(
  events: TraceEntityEventLike[],
  keyOf: (event: TraceEntityEventLike) => string,
  kind: 'model' | 'tool',
  params: RecordTraceEventMetricsParams,
): TraceEntityEventLike[] {
  const allowed = new Set<string>();
  const kept: TraceEntityEventLike[] = [];
  let dropped = 0;
  for (const event of events) {
    const key = keyOf(event);
    if (!allowed.has(key)) {
      if (allowed.size >= MAX_DISTINCT_KEYS_PER_INGEST) {
        dropped += 1;
        continue;
      }
      allowed.add(key);
    }
    kept.push(event);
  }
  if (dropped > 0) {
    const nowMs = Date.now();
    if (nowMs - lastCapWarnAt >= CAP_WARN_INTERVAL_MS) {
      lastCapWarnAt = nowMs;
      logger.warn('Too many distinct trace entity keys in one ingest; extra rows skipped', {
        kind,
        cap: MAX_DISTINCT_KEYS_PER_INGEST,
        skippedEvents: dropped,
        agentName: params.agentName,
      });
    }
  }
  return kept;
}

export async function recordTraceEventMetrics(params: RecordTraceEventMetricsParams): Promise<void> {
  try {
    const now = Date.now();
    const current = params.events.filter((event) => event && isRecentEvent(event, now));
    const previous = (params.previousEvents ?? []).filter((event) => event && isRecentEvent(event, now));
    if (current.length === 0 && previous.length === 0) return;

    const { fresh, removed } = diffByIdentity(current, previous);
    if (fresh.length === 0 && removed.length === 0) return;

    const agentKey = params.agentName?.trim();
    if (agentKey) {
      emitAgentCounters(params, agentKey, fresh, 1, now);
      emitAgentCounters(params, agentKey, removed, -1, now);
    }

    // Hosted runs count their model and tool calls where they execute.
    if (params.source !== 'tracing') return;

    const aiCalls = capDistinctKeys(
      fresh.filter((event) =>
        normalized(event.type) === 'ai_call'
        && isRunTraceEvent(event)
        && !isGatewayServedEvent(event)
        && modelNameOf(event)),
      (event) => modelNameOf(event)!,
      'model',
      params,
    );
    const toolCalls = capDistinctKeys(
      fresh.filter((event) =>
        normalized(event.type) === 'tool_call'
        && isRunTraceEvent(event)
        && eventToolName(event)),
      (event) => eventToolName(event)!,
      'tool',
      params,
    );

    let pricer: TraceModelPricer | undefined;
    if (aiCalls.length > 0) {
      try {
        const loader = params.pricerLoader ?? createTraceModelPricerLoader(params.tenantDbName, params.projectId);
        pricer = await loader();
      } catch (error) {
        logger.warn('Model pricing unavailable for trace health metrics', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const event of aiCalls) {
      const modelName = modelNameOf(event)!;
      const tokens = {
        inputTokens: num(event.inputTokens),
        outputTokens: num(event.outputTokens),
        cachedInputTokens: num(event.cachedInputTokens),
        cachedWriteTokens: num(event.cachedWriteTokens),
      };
      const priced = pricer?.price(modelName, tokens);
      const failed = isErrorTraceEvent(event);
      recordEntityMetric({
        tenantDbName: params.tenantDbName,
        tenantId: params.tenantId,
        projectId: params.projectId ?? '',
        entityType: 'model',
        entityKey: priced?.refKey ?? modelName,
        source: 'tracing',
        outcome: failed ? 'error' : 'ok',
        latencyMs: typeof event.durationMs === 'number' ? event.durationMs : null,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        costUsd: priced?.costUsd ?? 0,
        at: bookingTimeMs(event, 'tracing', now),
      });
    }

    for (const event of toolCalls) {
      recordEntityMetric({
        tenantDbName: params.tenantDbName,
        tenantId: params.tenantId,
        projectId: params.projectId ?? '',
        entityType: 'tool',
        entityKey: eventToolName(event)!,
        source: 'tracing',
        outcome: isErrorTraceEvent(event) ? 'error' : 'ok',
        latencyMs: typeof event.durationMs === 'number' ? event.durationMs : null,
        at: bookingTimeMs(event, 'tracing', now),
      });
    }
  } catch (error) {
    logger.warn('Trace event health metrics failed', {
      agentName: params.agentName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Session outcome ─────────────────────────────────────────────────────────

/**
 * A session status that counts as a finished run: everything except in_progress, unknown, missing and paused.
 * A `paused` run (agent-sdk ≥ 0.14) waits on a person (a tool approval, a question, a client tool) and resumes
 * into the same session, so it is booked when it finishes, like a run in progress.
 */
export function isTerminalSessionStatus(status: unknown): boolean {
  const value = normalized(status);
  return value !== '' && value !== 'in_progress' && value !== 'unknown' && value !== 'paused';
}

function isErrorStatus(status: string): boolean {
  return status === 'error' || status === 'failed';
}

export interface RecordAgentSessionOutcomeParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  /** The session AFTER the write that set its status. */
  session: Pick<
    IAgentTracingSession,
    'sessionId' | 'agentName' | 'status' | 'durationMs' | 'endedAt' | 'totalInputTokens' | 'totalOutputTokens'
  >;
  /** Outcome the caller read earlier; the stored one is re-read under a per-session lock and wins. */
  previousOutcome?: IAgentTracingSession['metricsOutcome'];
  source: TraceMetricsSource;
  /**
   * The session's events, for pricing its model calls and telling its waits apart. Loaded from the database when
   * omitted, or when they do not cover the whole session (a run resumed after a pause passes only its last part).
   */
  events?: TraceEntityEventLike[];
  pricerLoader?: TraceModelPricerLoader;
  /** Time the outcome is booked at (default: the session's end time, when recent). */
  atMs?: number;
}

const outcomeLocks = new Map<string, Promise<unknown>>();

/** Serializes outcome bookkeeping per session inside this process, so concurrent callers never both see "nothing counted yet". */
async function withOutcomeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = outcomeLocks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  outcomeLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (outcomeLocks.get(key) === tail) outcomeLocks.delete(key);
  }
}

/**
 * The session's events: the caller's when they cover the whole session (the stored `totalEvents` counts every part
 * of a run resumed after a pause), else the stored ones. A failed read books without them (no cost, no waits).
 */
async function loadSessionEvents(
  params: RecordAgentSessionOutcomeParams,
  stored: Pick<IAgentTracingSession, 'totalEvents'> | null | undefined,
): Promise<TraceEntityEventLike[]> {
  if (params.events && params.events.length >= num(stored?.totalEvents)) return params.events;
  try {
    return await runWithTenantScope(params.tenantDbName, (db) =>
      db.listAgentTracingEvents(params.session.sessionId, params.projectId || undefined, {
        projection: { sections: 0, metadata: 0 },
      }));
  } catch (error) {
    logger.warn('Session events unavailable for agent health metrics; booking without cost', {
      sessionId: params.session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return params.events ?? [];
  }
}

/** Event types of a person's step, in any integration's spelling (`*approval*` too). */
const WAITING_EVENT_TYPES = new Set(['tool_approval', 'user_question', 'human_input', 'interrupt']);

/**
 * Whether an event records the run waiting on someone else: a person approving a tool or answering a question
 * (actor scope `human`), a tool the calling app runs (`client`), or the step written when such a wait is abandoned
 * (role `approver`). Its duration is the wait, which ends at its timestamp.
 */
function isWaitingEvent(event: TraceEntityEventLike): boolean {
  const type = normalized(event.type);
  if (WAITING_EVENT_TYPES.has(type) || type.includes('approval')) return true;
  const actor = event.actor && typeof event.actor === 'object' ? event.actor as Record<string, unknown> : undefined;
  const scope = normalized(actor?.scope);
  return scope === 'human' || scope === 'client' || normalized(actor?.role) === 'approver';
}

/** Wall-clock time the run waited on others: waits that overlap (two approvals at once) count once. */
function waitingMs(events: TraceEntityEventLike[]): number {
  const waits: Array<[number, number]> = [];
  for (const event of events) {
    if (!event || !isWaitingEvent(event)) continue;
    const ms = num(event.durationMs);
    const end = eventTimeMs(event);
    if (ms > 0 && end !== undefined) waits.push([end - ms, end]);
  }
  waits.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let open: [number, number] | undefined;
  for (const [start, end] of waits) {
    if (open && start <= open[1]) {
      open[1] = Math.max(open[1], end);
      continue;
    }
    if (open) total += open[1] - open[0];
    open = [start, end];
  }
  return open ? total + open[1] - open[0] : total;
}

async function priceSessionEvents(
  params: RecordAgentSessionOutcomeParams,
  events: TraceEntityEventLike[],
): Promise<number> {
  const aiCalls = events.filter((event) =>
    normalized(event.type) === 'ai_call' && isRunTraceEvent(event) && modelNameOf(event));
  if (aiCalls.length === 0) return 0;
  try {
    const loader = params.pricerLoader ?? createTraceModelPricerLoader(params.tenantDbName, params.projectId);
    const pricer = await loader();
    let cost = 0;
    for (const event of aiCalls) {
      cost += pricer.price(modelNameOf(event)!, {
        inputTokens: num(event.inputTokens),
        outputTokens: num(event.outputTokens),
        cachedInputTokens: num(event.cachedInputTokens),
        cachedWriteTokens: num(event.cachedWriteTokens),
      }).costUsd;
    }
    return cost;
  } catch (error) {
    logger.warn('Session cost unavailable for agent health metrics', {
      sessionId: params.session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Book the session's terminal outcome into entity metrics, exactly once per
 * outcome. Returns the outcome now stored on the session (or null when the
 * session is not finished / cannot be attributed).
 */
export async function recordAgentSessionOutcome(
  params: RecordAgentSessionOutcomeParams,
): Promise<SessionMetricsOutcome | null> {
  try {
    const agentKey = params.session.agentName?.trim();
    if (!agentKey || !isTerminalSessionStatus(params.session.status)) return null;

    const lockKey = `${params.tenantDbName}\u0001${params.projectId ?? ''}\u0001${params.session.sessionId}`;
    return await withOutcomeLock(lockKey, async () => {
      const stored = await runWithTenantScope(params.tenantDbName, (db) =>
        db.findAgentTracingSessionById(params.session.sessionId, params.projectId || undefined));
      // The stored status is the truth: a concurrent event may have flipped it after the caller read the session.
      const status = stored && isTerminalSessionStatus(stored.status)
        ? normalized(stored.status)
        : normalized(params.session.status);
      const previous = stored ? (stored.metricsOutcome ?? null) : (params.previousOutcome ?? null);
      const previousStatus = previous ? normalized(previous.status) : '';
      if (previous && previousStatus === status) return previous;

      const now = Date.now();
      const endedMs = params.session.endedAt ? new Date(params.session.endedAt).getTime() : NaN;
      const at = params.atMs
        ?? (Number.isFinite(endedMs) && endedMs >= now - DAY_MS && endedMs <= now + FUTURE_SLACK_MS ? endedMs : undefined);
      // A session that ended long ago is history (re-import), not current health.
      if (!previous && at === undefined && Number.isFinite(endedMs) && endedMs < now - DAY_MS) return null;

      // Load and price the session's events BEFORE persisting the marker: a failed load must not leave a
      // counted-but-unemitted session. They price the run and hold its waits, so they are needed for the first
      // booking and for a latency not recorded yet.
      const events = !previous || !previous.latencyRecorded ? await loadSessionEvents(params, stored) : [];
      // The agent's time: a wait on a person or on the calling app is not latency.
      const durationMs = num(params.session.durationMs);
      const agentMs = durationMs - Math.min(waitingMs(events), durationMs);
      const recordLatency = status !== 'abandoned' && agentMs > 0;
      const costUsd = previous ? 0 : await priceSessionEvents(params, events);

      const next: SessionMetricsOutcome = {
        status,
        latencyRecorded: previous ? previous.latencyRecorded || recordLatency : recordLatency,
        recordedAt: new Date(now),
      };

      // Persist before emitting: a failed write must not leave a counted-but-unmarked session that the next call counts again.
      await runWithTenantScope(params.tenantDbName, (db) =>
        db.updateAgentTracingSession(params.session.sessionId, { metricsOutcome: next }, params.projectId || undefined));

      const base = {
        tenantDbName: params.tenantDbName,
        tenantId: params.tenantId,
        projectId: params.projectId ?? '',
        entityType: 'agent' as const,
        entityKey: agentKey,
        source: params.source,
        at,
      };

      if (!previous) {
        recordEntityMetric({
          ...base,
          outcome: isErrorStatus(status) ? 'error' : status === 'abandoned' ? 'abandoned' : 'ok',
          requests: 1,
          ...(recordLatency ? { latencyMs: agentMs, latencyForce: true } : {}),
          inputTokens: num(params.session.totalInputTokens),
          outputTokens: num(params.session.totalOutputTokens),
          costUsd,
        });
        return next;
      }

      // The status moved after the outcome was counted: add only the difference.
      recordEntityMetric({
        ...base,
        outcome: 'none',
        requests: 0,
        errorsDelta: (isErrorStatus(status) ? 1 : 0) - (isErrorStatus(previousStatus) ? 1 : 0),
        abandoned: (status === 'abandoned' ? 1 : 0) - (previousStatus === 'abandoned' ? 1 : 0),
        ...(!previous.latencyRecorded && recordLatency ? { latencyMs: agentMs, latencyForce: true } : {}),
      });
      return next;
    });
  } catch (error) {
    logger.warn('Agent session health outcome failed', {
      sessionId: params.session.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
