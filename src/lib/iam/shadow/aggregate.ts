/**
 * Shadow diff store: bounded aggregates of "where would the new engine decide
 * differently from rbac.ts", kept per tenant in the `iam_shadow` collection
 * (created lazily, same on MongoDB and SQLite).
 *
 * One document per distinct tuple
 *   (category, service, method, route, legacyAllowed, targetAllowed)
 * holding a counter, first/last seen and at most MAX_SAMPLES recent sample
 * requests (ids and role only — no bodies, no query strings).
 *
 * Memory and storage are bounded on every axis:
 *  - events are folded into an in-memory pending map (keys per tenant, samples
 *    per key and tenants are capped) and flushed in batches — every
 *    FLUSH_INTERVAL_MS or once FLUSH_EVENTS events are pending;
 *  - at most MAX_KEYS_PER_TENANT documents are ever stored per tenant; further
 *    new tuples are dropped and counted (`droppedKeys` / `droppedEvents`);
 *  - a failed flush loses that batch (counted) instead of growing the buffer.
 *
 * Multi-node note: aggregates are read-modify-write per document, so two nodes
 * flushing the very same tuple in the same instant can lose one update. The
 * numbers are diagnostics, not accounting; the loss is bounded by one batch.
 */

import { createHash } from 'node:crypto';
import { runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { bumpTenantMetric, shadowMetrics } from './metrics';
import {
  POLICY_MONITOR_CATEGORY,
  SHADOW_CATEGORIES,
  isShadowEventCategory,
  type ShadowCategory,
  type ShadowEntry,
  type ShadowEvent,
  type ShadowSample,
} from './types';

const logger = createLogger('iam:shadow');

export const MAX_SAMPLES = 20;
export const MAX_KEYS_PER_TENANT = 1_000;
export const FLUSH_INTERVAL_MS = 5_000;
export const FLUSH_EVENTS = 200;
/** A flush (one tenant) that has not finished by then is abandoned and its batch counted as dropped. */
export const FLUSH_TIMEOUT_MS = 10_000;
let flushTimeoutMs = FLUSH_TIMEOUT_MS;
/** Bounded wait for readers (report API) that want pending events included. */
export const READ_FLUSH_WAIT_MS = 3_000;
let readFlushWaitMs = READ_FLUSH_WAIT_MS;

/** Test seam: shrink the flush deadline and the bounded read wait. */
export function setShadowFlushTimeoutsForTests(flushMs: number, readWaitMs: number): void {
  flushTimeoutMs = flushMs;
  readFlushWaitMs = readWaitMs;
}
/** Distinct tuples buffered per tenant between two flushes. */
const MAX_PENDING_KEYS_PER_TENANT = 500;
const MAX_PENDING_TENANTS = 200;
const COLLECTION = 'iam_shadow' as const;
const ID_PREFIX = 'agg:';
const MAX_DETAIL_LEN = 300;

interface PendingAgg {
  event: Omit<ShadowEvent, 'sample'>;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: ShadowSample[];
}

interface TenantState {
  pending: Map<string, PendingAgg>;
  pendingEvents: number;
}

/**
 * Only tenants that currently have buffered events live here; a state is
 * removed once its batch has been flushed, so MAX_PENDING_TENANTS bounds
 * concurrent activity, not the number of tenants a process has ever served.
 */
const tenants = new Map<string, TenantState>();
/** Ids already stored per tenant (lazily hydrated on first flush), small LRU. */
const storedIds = new Map<string, Set<string>>();
const MAX_STORED_TENANTS = 500;
let autoFlushScheduled = false;
let totalPendingEvents = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let flushChain: Promise<void> = Promise.resolve();

function tuple(e: Omit<ShadowEvent, 'sample'>): string {
  const parts = [e.category, e.service, e.method, e.route, e.legacyAllowed ? '1' : '0', e.targetAllowed ? '1' : '0'];
  // Only policy-monitor events carry a policy; leaving it out for the others keeps
  // every pre-existing aggregate id exactly as it was.
  if (e.policyId) parts.push(e.policyId);
  return parts.join('|');
}

export function shadowDocId(e: Omit<ShadowEvent, 'sample'>): string {
  return ID_PREFIX + createHash('sha1').update(tuple(e)).digest('hex').slice(0, 24);
}

function clampSample(sample: ShadowSample): ShadowSample {
  const out: ShadowSample = {
    requestId: String(sample.requestId).slice(0, 80),
    userId: String(sample.userId).slice(0, 80),
    role: String(sample.role ?? '').slice(0, 40),
    at: sample.at,
  };
  if (sample.tokenId) out.tokenId = String(sample.tokenId).slice(0, 80);
  if (sample.detail) out.detail = String(sample.detail).slice(0, MAX_DETAIL_LEN);
  return out;
}

function getStored(tenantDbName: string): Set<string> | undefined {
  const set = storedIds.get(tenantDbName);
  if (set) {
    // refresh recency
    storedIds.delete(tenantDbName);
    storedIds.set(tenantDbName, set);
  }
  return set;
}

function setStored(tenantDbName: string, set: Set<string>): void {
  storedIds.delete(tenantDbName);
  if (storedIds.size >= MAX_STORED_TENANTS) {
    const oldest = storedIds.keys().next().value as string | undefined;
    if (oldest !== undefined) storedIds.delete(oldest);
  }
  storedIds.set(tenantDbName, set);
}

/** At most one automatic flush queued/running at a time (no chain build-up under a slow DB). */
function scheduleAutoFlush(): void {
  if (autoFlushScheduled) return;
  autoFlushScheduled = true;
  void flushShadowEvents().finally(() => {
    autoFlushScheduled = false;
  });
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(scheduleAutoFlush, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

function countDrop(tenantDbName: string, events: number, keys = 0): void {
  shadowMetrics.droppedEvents += events;
  bumpTenantMetric(tenantDbName, 'droppedEvents', events);
  if (keys) {
    shadowMetrics.droppedKeys += keys;
    bumpTenantMetric(tenantDbName, 'droppedKeys', keys);
  }
}

/** Fold one event into the pending buffer. Synchronous, cheap, never throws. */
export function recordShadowEvent(tenantDbName: string, event: ShadowEvent): void {
  try {
    let state = tenants.get(tenantDbName);
    if (!state) {
      if (tenants.size >= MAX_PENDING_TENANTS) {
        countDrop(tenantDbName, 1);
        return;
      }
      state = { pending: new Map(), pendingEvents: 0 };
      tenants.set(tenantDbName, state);
    }
    const { sample, ...rest } = event;
    const key = tuple(rest);
    let agg = state.pending.get(key);
    if (!agg) {
      if (state.pending.size >= MAX_PENDING_KEYS_PER_TENANT) {
        countDrop(tenantDbName, 1);
        return;
      }
      agg = { event: rest, count: 0, firstSeen: sample.at, lastSeen: sample.at, samples: [] };
      state.pending.set(key, agg);
    }
    agg.count++;
    agg.lastSeen = sample.at;
    agg.samples.push(clampSample(sample));
    if (agg.samples.length > MAX_SAMPLES) agg.samples.shift();
    state.pendingEvents++;
    totalPendingEvents++;
    shadowMetrics.events[event.category]++;
    ensureTimer();
    if (totalPendingEvents >= FLUSH_EVENTS) scheduleAutoFlush();
  } catch (error) {
    countDrop(tenantDbName, 1);
    logger.debug('Could not record shadow event', { error: error instanceof Error ? error.message : String(error) });
  }
}

export function getPendingShadowEventCount(): number {
  return totalPendingEvents;
}

// ── persistence ──────────────────────────────────────────────────────────

function mergeSamples(existing: ShadowSample[], added: ShadowSample[]): ShadowSample[] {
  return [...existing, ...added].slice(-MAX_SAMPLES);
}

function fromDoc(id: string, data: Record<string, unknown>): ShadowEntry | null {
  if (!isShadowEventCategory(data.category)) return null;
  return {
    id,
    category: data.category,
    service: String(data.service ?? ''),
    method: String(data.method ?? ''),
    route: String(data.route ?? ''),
    legacyAllowed: data.legacyAllowed === true,
    targetAllowed: data.targetAllowed === true,
    ...(typeof data.policyId === 'string' && data.policyId ? { policyId: data.policyId } : {}),
    count: typeof data.count === 'number' ? data.count : 0,
    firstSeen: String(data.firstSeen ?? ''),
    lastSeen: String(data.lastSeen ?? ''),
    samples: Array.isArray(data.samples) ? (data.samples as ShadowSample[]).slice(-MAX_SAMPLES) : [],
  };
}

function release(tenantDbName: string, state: TenantState): void {
  if (state.pending.size === 0 && tenants.get(tenantDbName) === state) tenants.delete(tenantDbName);
}

async function writeBatch(tenantDbName: string, batch: Map<string, PendingAgg>): Promise<void> {
  await runWithTenantScope(tenantDbName, async (db) => {
    let stored = getStored(tenantDbName);
    if (!stored) {
      const existing = await db.iamDocList(COLLECTION, { idPrefix: ID_PREFIX, limit: MAX_KEYS_PER_TENANT + 1 });
      stored = new Set(existing.map((d) => d.id));
      setStored(tenantDbName, stored);
    }
    for (const agg of batch.values()) {
      const id = shadowDocId(agg.event);
      const known = stored.has(id);
      if (!known && stored.size >= MAX_KEYS_PER_TENANT) {
        countDrop(tenantDbName, agg.count, 1);
        continue;
      }
      const current = known ? await db.iamDocGet(COLLECTION, id) : null;
      const prev = current ? fromDoc(id, current.data) : null;
      const next = {
        category: agg.event.category,
        service: agg.event.service,
        method: agg.event.method,
        route: agg.event.route,
        legacyAllowed: agg.event.legacyAllowed,
        targetAllowed: agg.event.targetAllowed,
        ...(agg.event.policyId ? { policyId: agg.event.policyId } : {}),
        count: (prev?.count ?? 0) + agg.count,
        firstSeen: prev?.firstSeen || agg.firstSeen,
        lastSeen: agg.lastSeen,
        samples: mergeSamples(prev?.samples ?? [], agg.samples),
      };
      await db.iamDocPut(COLLECTION, id, next);
      stored.add(id);
    }
  });
}

async function flushTenant(tenantDbName: string, state: TenantState): Promise<void> {
  const batch = state.pending;
  const eventCount = state.pendingEvents;
  state.pending = new Map();
  state.pendingEvents = 0;
  totalPendingEvents = Math.max(0, totalPendingEvents - eventCount);
  if (batch.size === 0) {
    release(tenantDbName, state);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      writeBatch(tenantDbName, batch),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`flush timed out after ${flushTimeoutMs} ms`)), flushTimeoutMs);
        timer.unref?.();
      }),
    ]);
    shadowMetrics.flushes++;
  } catch (error) {
    shadowMetrics.flushFailures++;
    countDrop(tenantDbName, eventCount);
    // The set may be out of date after a partial failure; re-hydrate next time.
    storedIds.delete(tenantDbName);
    logger.warn('Could not flush shadow aggregates; batch dropped', {
      tenantDbName,
      events: eventCount,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
    release(tenantDbName, state);
  }
}

/**
 * Flush every pending tenant (or just one). Serialised: concurrent callers
 * queue behind the running flush, so awaiting this guarantees every event
 * recorded before the call has been written (or counted as dropped). Every
 * tenant flush has its own deadline, so the chain cannot be stuck forever.
 */
export function flushShadowEvents(onlyTenant?: string): Promise<void> {
  const run = async () => {
    const names = onlyTenant ? [onlyTenant] : [...tenants.keys()];
    for (const name of names) {
      const state = tenants.get(name);
      if (state && state.pending.size > 0) await flushTenant(name, state);
    }
  };
  flushChain = flushChain.then(run, run);
  return flushChain;
}

/** Like flushShadowEvents but never waits longer than `ms` (report API reads). */
async function flushBounded(onlyTenant: string, ms = readFlushWaitMs): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flushShadowEvents(onlyTenant),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stop the timer and drop all buffered state (tests, shutdown). */
export function resetShadowBufferForTests(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  tenants.clear();
  storedIds.clear();
  totalPendingEvents = 0;
  autoFlushScheduled = false;
  flushTimeoutMs = FLUSH_TIMEOUT_MS;
  readFlushWaitMs = READ_FLUSH_WAIT_MS;
  flushChain = Promise.resolve();
}

// ── reading ──────────────────────────────────────────────────────────────

/**
 * Stored aggregates of the tenant. Pending events are flushed first (bounded
 * wait) unless `flush: false` - for callers with their own time budget that can
 * live with "a few seconds old".
 */
export async function listShadowEntries(tenantDbName: string, options: { flush?: boolean } = {}): Promise<ShadowEntry[]> {
  if (options.flush !== false) await flushBounded(tenantDbName);
  const docs = await runWithTenantScope(tenantDbName, (db) =>
    db.iamDocList(COLLECTION, { idPrefix: ID_PREFIX, limit: MAX_KEYS_PER_TENANT + 1 }),
  );
  const entries: ShadowEntry[] = [];
  for (const doc of docs) {
    const entry = fromDoc(doc.id, doc.data);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Remove every stored aggregate of the tenant (and anything still buffered). */
export async function resetShadowEntries(tenantDbName: string): Promise<number> {
  const state = tenants.get(tenantDbName);
  if (state) {
    totalPendingEvents = Math.max(0, totalPendingEvents - state.pendingEvents);
    tenants.delete(tenantDbName);
  }
  storedIds.delete(tenantDbName);
  // Serialise behind any in-flight flush (bounded) so a late write cannot resurrect rows.
  await Promise.race([
    flushChain.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, readFlushWaitMs).unref?.()),
  ]);
  return runWithTenantScope(tenantDbName, (db) => db.iamDocClear(COLLECTION));
}

/**
 * Forget the `policy-monitor` findings of ONE policy (its text, mode or
 * enablement changed, so the old counts no longer describe it). Pending events
 * are dropped too; returns the number of stored aggregates removed.
 */
export async function clearPolicyMonitorStats(tenantDbName: string, policyId: string): Promise<number> {
  const state = tenants.get(tenantDbName);
  if (state) {
    for (const [key, agg] of [...state.pending]) {
      if (agg.event.category === POLICY_MONITOR_CATEGORY && agg.event.policyId === policyId) {
        state.pending.delete(key);
        state.pendingEvents = Math.max(0, state.pendingEvents - agg.count);
        totalPendingEvents = Math.max(0, totalPendingEvents - agg.count);
      }
    }
    release(tenantDbName, state);
  }
  // Serialise behind any in-flight flush (bounded) so a late write cannot resurrect rows.
  await Promise.race([
    flushChain.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, readFlushWaitMs).unref?.()),
  ]);
  return runWithTenantScope(tenantDbName, async (db) => {
    const docs = await db.iamDocList(COLLECTION, { idPrefix: ID_PREFIX, limit: MAX_KEYS_PER_TENANT + 1 });
    let removed = 0;
    for (const doc of docs) {
      if (doc.data.category !== POLICY_MONITOR_CATEGORY || doc.data.policyId !== policyId) continue;
      if (await db.iamDocDelete(COLLECTION, doc.id)) removed++;
      getStored(tenantDbName)?.delete(doc.id);
    }
    return removed;
  });
}

export interface PolicyMonitorTotals {
  /** Requests the policy would newly ALLOW (denied today). */
  wouldAllow: number;
  /** Requests the policy would newly DENY (allowed today). */
  wouldDeny: number;
  /** First time a difference was recorded since the last reset of this policy. */
  since: string | null;
  lastSeen: string | null;
}

/** Fold `policy-monitor` aggregates into per-policy totals. */
export function foldPolicyMonitorEntries(entries: ShadowEntry[]): Map<string, PolicyMonitorTotals> {
  const out = new Map<string, PolicyMonitorTotals>();
  for (const e of entries) {
    if (e.category !== POLICY_MONITOR_CATEGORY || !e.policyId) continue;
    let t = out.get(e.policyId);
    if (!t) {
      t = { wouldAllow: 0, wouldDeny: 0, since: null, lastSeen: null };
      out.set(e.policyId, t);
    }
    if (e.legacyAllowed && !e.targetAllowed) t.wouldDeny += e.count;
    if (!e.legacyAllowed && e.targetAllowed) t.wouldAllow += e.count;
    if (e.firstSeen && (t.since === null || e.firstSeen < t.since)) t.since = e.firstSeen;
    if (e.lastSeen && (t.lastSeen === null || e.lastSeen > t.lastSeen)) t.lastSeen = e.lastSeen;
  }
  return out;
}

/** Per-policy `policy-monitor` totals of a tenant (pending events are flushed first, bounded). */
export async function getPolicyMonitorTotals(tenantDbName: string): Promise<Map<string, PolicyMonitorTotals>> {
  return foldPolicyMonitorEntries(await listShadowEntries(tenantDbName));
}

// ── reports ──────────────────────────────────────────────────────────────

export interface CategorySummary {
  category: ShadowCategory;
  /** Total requests recorded. */
  events: number;
  /** Distinct (service, method, route, legacy, target) tuples. */
  keys: number;
  /** Requests rbac.ts allows but the target rule would deny. */
  wouldDeny: number;
  /** Requests rbac.ts denies but the target rule would allow. */
  wouldAllow: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface ServiceSummary {
  service: string;
  total: number;
  byCategory: Record<ShadowCategory, number>;
}

export interface ShadowSummary {
  categories: CategorySummary[];
  services: ServiceSummary[];
  topRoutes: Array<Omit<ShadowEntry, 'id'> & { id: string }>;
  totals: { events: number; keys: number };
  firstSeen: string | null;
  lastSeen: string | null;
  maxKeys: number;
  maxSamples: number;
}

function zeroByCategory(): Record<ShadowCategory, number> {
  return { 'parity-mismatch': 0, 'token-groups': 0, 'project-narrowing': 0, 'unmapped-path': 0 };
}

function minIso(a: string | null, b: string): string {
  return a === null || (b && b < a) ? b : a;
}
function maxIso(a: string | null, b: string): string {
  return a === null || b > a ? b : a;
}

export function summarizeShadowEntries(
  allEntries: ShadowEntry[],
  options: { category?: ShadowCategory | typeof POLICY_MONITOR_CATEGORY; service?: string; limit?: number; sampleLimit?: number } = {},
): ShadowSummary {
  // The totals are about the engine vs the current rules. A monitor policy's own
  // counts are reported per policy (policyMonitorStats) and are only listed here
  // when asked for by name.
  const entries = allEntries.filter((e): e is ShadowEntry & { category: ShadowCategory } => e.category !== POLICY_MONITOR_CATEGORY);
  const topSource = options.category === POLICY_MONITOR_CATEGORY
    ? allEntries.filter((e) => e.category === POLICY_MONITOR_CATEGORY)
    : entries;
  const sampleLimit = Math.max(0, Math.min(options.sampleLimit ?? 5, MAX_SAMPLES));
  const limit = Math.max(1, Math.min(options.limit ?? 25, 200));

  const categories = new Map<ShadowCategory, CategorySummary>(
    SHADOW_CATEGORIES.map((category) => [
      category,
      { category, events: 0, keys: 0, wouldDeny: 0, wouldAllow: 0, firstSeen: null, lastSeen: null },
    ]),
  );
  const services = new Map<string, ServiceSummary>();
  let events = 0;
  let firstSeen: string | null = null;
  let lastSeen: string | null = null;

  for (const entry of entries) {
    const cat = categories.get(entry.category)!;
    cat.events += entry.count;
    cat.keys += 1;
    if (entry.legacyAllowed && !entry.targetAllowed) cat.wouldDeny += entry.count;
    if (!entry.legacyAllowed && entry.targetAllowed) cat.wouldAllow += entry.count;
    if (entry.firstSeen) cat.firstSeen = minIso(cat.firstSeen, entry.firstSeen);
    if (entry.lastSeen) cat.lastSeen = maxIso(cat.lastSeen, entry.lastSeen);

    let svc = services.get(entry.service);
    if (!svc) {
      svc = { service: entry.service, total: 0, byCategory: zeroByCategory() };
      services.set(entry.service, svc);
    }
    svc.total += entry.count;
    svc.byCategory[entry.category] += entry.count;

    events += entry.count;
    if (entry.firstSeen) firstSeen = minIso(firstSeen, entry.firstSeen);
    if (entry.lastSeen) lastSeen = maxIso(lastSeen, entry.lastSeen);
  }

  const top = topSource
    .filter((e) => (!options.category || e.category === options.category) && (!options.service || e.service === options.service))
    .sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1))
    .slice(0, limit)
    .map((e) => ({ ...e, samples: sampleLimit === 0 ? [] : e.samples.slice(-sampleLimit).reverse() }));

  return {
    categories: SHADOW_CATEGORIES.map((c) => categories.get(c)!),
    services: [...services.values()].sort((a, b) => b.total - a.total || a.service.localeCompare(b.service)),
    topRoutes: top,
    totals: { events, keys: entries.length },
    firstSeen,
    lastSeen,
    maxKeys: MAX_KEYS_PER_TENANT,
    maxSamples: MAX_SAMPLES,
  };
}
