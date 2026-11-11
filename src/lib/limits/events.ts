/**
 * Limit events: refusals and waits. Recording is
 * fire-and-forget and sampled so a flood of refusals costs a handful of writes:
 * one stored event per key per 10 s per process, the dropped ones folded into
 * the `count` of the next stored one.
 */
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { PlanLimitDecision, PlanLimitEvent, PlanLimitKind, PlanLimitSource } from './types';

const log = createLogger('limits:events');

const SAMPLE_WINDOW_MS = 10_000;
const MAX_KEYS = 50_000;
const FLUSH_EVERY_MS = 2_000;
const FLUSH_BATCH = 100;
const RETENTION_MS = 90 * 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 6 * 3600 * 1000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export type RecordLimitEventInput = Omit<PlanLimitEvent, 'count' | 'at' | 'mode'> & { at?: Date };

const sampling = new Map<string, { lastStoredAt: number; folded: number }>();
let queue: PlanLimitEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastPruneAt = 0;
let exitHookInstalled = false;

function samplingKey(event: RecordLimitEventInput): string {
  return [
    event.tenantId,
    event.kind,
    event.dimension ?? '',
    event.outcome,
    event.source?.type ?? '',
    event.source?.id ?? '',
  ].join('|');
}

function pruneSampling(now: number): void {
  for (const [key, entry] of sampling) {
    if (entry.folded === 0 && now - entry.lastStoredAt >= SAMPLE_WINDOW_MS) sampling.delete(key);
  }
  while (sampling.size > MAX_KEYS) {
    const oldest = sampling.keys().next().value;
    if (oldest === undefined) break;
    sampling.delete(oldest);
  }
}

export async function flushLimitEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = queue;
  queue = [];
  const now = Date.now();
  const shouldPrune = now - lastPruneAt >= PRUNE_EVERY_MS;
  if (shouldPrune) lastPruneAt = now;
  if (batch.length > 0) {
    try {
      const db = await getDatabase();
      await db.insertPlanLimitEvents(batch);
    } catch (error) {
      log.warn('Limit events could not be stored', {
        dropped: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (shouldPrune) {
    pruneLimitEvents().catch(() => undefined);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLimitEvents();
  }, FLUSH_EVERY_MS);
  flushTimer.unref?.();
  if (!exitHookInstalled && typeof process !== 'undefined' && typeof process.once === 'function') {
    exitHookInstalled = true;
    process.once('beforeExit', () => {
      void flushLimitEvents();
    });
  }
}

export function recordLimitEvent(event: RecordLimitEventInput): void {
  try {
    const now = Date.now();
    const key = samplingKey(event);
    const entry = sampling.get(key);
    if (entry && now - entry.lastStoredAt < SAMPLE_WINDOW_MS) {
      entry.folded += 1;
      return;
    }
    const count = 1 + (entry?.folded ?? 0);
    if (entry) sampling.delete(key);
    sampling.set(key, { lastStoredAt: now, folded: 0 });
    if (sampling.size > MAX_KEYS) pruneSampling(now);

    queue.push({ ...event, mode: 'on', count, at: event.at ?? new Date(now) });
    if (queue.length >= FLUSH_BATCH) void flushLimitEvents();
    else scheduleFlush();
  } catch {
    /* recording must never affect the caller */
  }
}

/** Records an event for any decision that is not plain `allowed`. */
export function outcomeEventFor(
  decision: PlanLimitDecision,
  context: {
    tenantId: string;
    source?: PlanLimitSource;
    waitMs?: number;
  },
): void {
  if (decision.outcome === 'allowed') return;
  recordLimitEvent({
    tenantId: context.tenantId,
    kind: decision.kind,
    dimension: decision.dimension,
    outcome: decision.outcome,
    limit: decision.limit,
    used: decision.used,
    waitMs: context.waitMs,
    source: context.source,
  });
}

export async function listLimitEvents(
  tenantId: string,
  opts: { since?: Date; kind?: PlanLimitKind; limit?: number } = {},
): Promise<PlanLimitEvent[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_LIMIT);
  // Make recent events visible to the page that asked.
  await flushLimitEvents();
  const db = await getDatabase();
  const events = await db.listPlanLimitEvents(tenantId, { since: opts.since, kind: opts.kind, limit });
  // Rows from the retired measure-only mode (outcome would_refuse) were never refusals: not shown.
  return events.filter((event) => (event.outcome as string) !== 'would_refuse');
}

export async function pruneLimitEvents(): Promise<number> {
  const db = await getDatabase();
  return db.deletePlanLimitEventsBefore(new Date(Date.now() - RETENTION_MS));
}

export function clearLimitEventsForTests(): void {
  sampling.clear();
  queue = [];
  lastPruneAt = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
