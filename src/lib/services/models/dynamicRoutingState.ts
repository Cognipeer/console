/**
 * Dynamic LLM routing state — the history and counters the cost-aware pool
 * policies and guards read (the decisions themselves are pure, in
 * `dynamicRouting.ts`).
 *
 * - Conversation + router spend counters and the per-conversation sticky model
 *   live in the shared cache provider (Redis when configured, so every replica
 *   sees the same budget; in-process memory otherwise).
 * - Segment output/input ratios are an in-process EWMA learned from routed
 *   traffic. Each replica learns on its own; it is a prediction input, not an
 *   accounting figure, so that is acceptable.
 * - Per-model profiles (average output tokens, output/input ratio, cached
 *   share) come from the `usage_daily` rollup, which already aggregates every
 *   model call — no extra collection and no scan of raw usage logs.
 *
 * Every read is fail-soft: a cache or database error yields "no history", and
 * routing falls back to its static estimates instead of failing the request.
 */

import { getCache } from '@/lib/core/cache';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, type IModelUsageRouting } from '@/lib/database';
import type { TokenUsage } from './usageLogger';

const logger = createLogger('dynamic-routing-state');

const MICRO = 1_000_000;
const CONVERSATION_TTL_SECONDS = 24 * 3600;
const STICKY_TTL_SECONDS = 6 * 3600;
/** Spend buckets outlive the longest allowed budget window (168h). */
const SPEND_BUCKET_TTL_SECONDS = 8 * 24 * 3600;
export const MAX_BUDGET_WINDOW_HOURS = 168;
const SPEND_CACHE_MS = 30_000;
const PROFILE_TTL_MS = 15 * 60_000;
const PROFILE_LOOKBACK_DAYS = 14;
const EWMA_ALPHA = 0.2;
/** Segment ratios are trusted once this many samples have been folded in. */
export const MIN_SEGMENT_SAMPLES = 5;
/** Model profiles need this many requests in the lookback window. */
const MIN_PROFILE_REQUESTS = 20;
const MAX_IN_PROCESS_ENTRIES = 5_000;

const key = (tenantDbName: string, routerKey: string, ...parts: string[]) =>
  ['dynroute', tenantDbName, routerKey, ...parts].join(':');

function hourBucket(date: Date): string {
  return date.toISOString().slice(0, 13);
}

function boundedSet<V>(map: Map<string, V>, k: string, value: V): void {
  if (map.has(k)) map.delete(k);
  map.set(k, value);
  if (map.size > MAX_IN_PROCESS_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function ewma(previous: number | undefined, sample: number): number {
  return previous === undefined ? sample : previous + EWMA_ALPHA * (sample - previous);
}

// ── Conversation state ──────────────────────────────────────────────────

export interface ConversationState {
  /** Model that served the previous turn (prompt-cache stickiness). */
  lastModelKey?: string;
  /** EWMA output/input ratio of the conversation's previous turns. */
  ioRatio?: number;
  turns?: number;
}

export async function getConversationState(
  tenantDbName: string,
  routerKey: string,
  conversationId: string,
): Promise<ConversationState> {
  try {
    const cache = await getCache();
    return (await cache.get<ConversationState>(key(tenantDbName, routerKey, 'conv', conversationId))) ?? {};
  } catch (error) {
    logger.warn('Conversation state read failed', { error: (error as Error).message });
    return {};
  }
}

export async function getConversationCostUsd(
  tenantDbName: string,
  routerKey: string,
  conversationId: string,
): Promise<number | undefined> {
  try {
    const cache = await getCache();
    const { count } = await cache.incrementCounter(
      key(tenantDbName, routerKey, 'conv-cost', conversationId),
      CONVERSATION_TTL_SECONDS,
      0,
    );
    return count / MICRO;
  } catch (error) {
    logger.warn('Conversation cost read failed', { error: (error as Error).message });
    return undefined;
  }
}

// ── Router spend (budget guard) ─────────────────────────────────────────

const spendCache = new Map<string, { at: number; usd: number }>();

/** Realized spend through a router over the trailing window (hourly buckets). */
export async function getRouterSpendUsd(
  tenantDbName: string,
  routerKey: string,
  windowHours: number,
  now: Date = new Date(),
): Promise<number | undefined> {
  const hours = Math.max(1, Math.min(MAX_BUDGET_WINDOW_HOURS, Math.round(windowHours)));
  const cacheKey = `${tenantDbName}:${routerKey}:${hours}`;
  const cached = spendCache.get(cacheKey);
  if (cached && now.getTime() - cached.at < SPEND_CACHE_MS) return cached.usd;
  try {
    const cache = await getCache();
    const buckets = Array.from({ length: hours }, (_, i) =>
      hourBucket(new Date(now.getTime() - i * 3600_000)),
    );
    const counts = await Promise.all(
      buckets.map((bucket) =>
        cache
          .incrementCounter(key(tenantDbName, routerKey, 'spend', bucket), SPEND_BUCKET_TTL_SECONDS, 0)
          .then((r) => r.count),
      ),
    );
    const usd = counts.reduce((sum, c) => sum + c, 0) / MICRO;
    boundedSet(spendCache, cacheKey, { at: now.getTime(), usd });
    return usd;
  } catch (error) {
    logger.warn('Router spend read failed', { error: (error as Error).message });
    return undefined;
  }
}

// ── Segment output/input ratios (in-process) ────────────────────────────

const segmentRatios = new Map<string, { ratio: number; n: number }>();

/** EWMA output/input ratio of a router segment, once it has enough samples. */
export function getSegmentIoRatio(
  tenantDbName: string,
  routerKey: string,
  segment: string,
): { ratio: number; n: number } | undefined {
  const entry = segmentRatios.get(key(tenantDbName, routerKey, 'seg', segment));
  if (entry && entry.n >= MIN_SEGMENT_SAMPLES) return entry;
  const routerWide = segmentRatios.get(key(tenantDbName, routerKey, 'seg', '*'));
  return routerWide && routerWide.n >= MIN_SEGMENT_SAMPLES ? routerWide : undefined;
}

function foldSegmentRatio(tenantDbName: string, routerKey: string, segment: string, ratio: number) {
  for (const s of [segment, '*']) {
    const k = key(tenantDbName, routerKey, 'seg', s);
    const prev = segmentRatios.get(k);
    boundedSet(segmentRatios, k, { ratio: ewma(prev?.ratio, ratio), n: (prev?.n ?? 0) + 1 });
  }
}

// ── Model profiles (usage_daily) ────────────────────────────────────────

export interface ModelProfile {
  requests: number;
  avgOutputTokens: number;
  ioRatio: number;
  cachedShare: number;
}

const profileCache = new Map<string, { at: number; profile: ModelProfile | null }>();
const profileInflight = new Map<string, Promise<ModelProfile | null>>();

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function loadModelProfile(
  tenantDbName: string,
  projectId: string,
  modelKey: string,
): Promise<ModelProfile | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const rows = await db.listUsageDaily({
    projectId,
    service: 'models',
    refKey: modelKey,
    fromDay: dayString(new Date(Date.now() - PROFILE_LOOKBACK_DAYS * 86_400_000)),
    limit: 5_000,
  });
  let requests = 0;
  let errors = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const row of rows) {
    requests += row.requests ?? 0;
    errors += row.errors ?? 0;
    input += row.inputTokens ?? 0;
    output += row.outputTokens ?? 0;
    cached += row.cachedInputTokens ?? 0;
  }
  const served = requests - errors;
  if (served < MIN_PROFILE_REQUESTS || input <= 0) return null;
  return {
    requests: served,
    avgOutputTokens: output / served,
    ioRatio: output / input,
    cachedShare: Math.min(1, cached / input),
  };
}

/** Recent traffic profile of each model (null when there is too little history). */
export async function getModelProfiles(
  tenantDbName: string,
  projectId: string,
  modelKeys: string[],
): Promise<Map<string, ModelProfile | null>> {
  const result = new Map<string, ModelProfile | null>();
  await Promise.all(
    modelKeys.map(async (modelKey) => {
      const k = `${tenantDbName}:${projectId}:${modelKey}`;
      const cached = profileCache.get(k);
      if (cached && Date.now() - cached.at < PROFILE_TTL_MS) {
        result.set(modelKey, cached.profile);
        return;
      }
      let pending = profileInflight.get(k);
      if (!pending) {
        pending = loadModelProfile(tenantDbName, projectId, modelKey)
          .catch((error) => {
            logger.warn('Model profile load failed', { modelKey, error: (error as Error).message });
            return null;
          })
          .finally(() => profileInflight.delete(k));
        profileInflight.set(k, pending);
      }
      const profile = await pending;
      boundedSet(profileCache, k, { at: Date.now(), profile });
      result.set(modelKey, profile);
    }),
  );
  return result;
}

// ── Recording (called from usageLogger for routed rows) ─────────────────

/**
 * Folds one routed call into the counters and history. Child rows feed the
 * conversation's sticky model, its ratio and the segment ratio; child and
 * decider rows both count toward conversation and router spend (the decider's
 * classification is part of what the router costs).
 */
export async function recordRoutedUsage(args: {
  tenantDbName: string;
  routing: IModelUsageRouting;
  modelKey: string;
  usage: TokenUsage;
  costUsd: number;
  status: string;
  now?: Date;
}): Promise<void> {
  const { tenantDbName, routing, modelKey, usage, costUsd, status } = args;
  if (routing.role !== 'child' && routing.role !== 'decider') return;
  const now = args.now ?? new Date();
  const micro = Math.round(Math.max(0, costUsd) * MICRO);
  const routerKey = routing.routerKey;

  try {
    const cache = await getCache();
    const writes: Array<Promise<unknown>> = [];
    if (micro > 0) {
      writes.push(
        cache.incrementCounter(key(tenantDbName, routerKey, 'spend', hourBucket(now)), SPEND_BUCKET_TTL_SECONDS, micro),
      );
      if (routing.conversationId) {
        writes.push(
          cache.incrementCounter(
            key(tenantDbName, routerKey, 'conv-cost', routing.conversationId),
            CONVERSATION_TTL_SECONDS,
            micro,
          ),
        );
      }
    }

    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    if (routing.role === 'child' && status === 'success' && input > 0) {
      const ratio = output / input;
      if (routing.segment) foldSegmentRatio(tenantDbName, routerKey, routing.segment, ratio);
      if (routing.conversationId) {
        const convKey = key(tenantDbName, routerKey, 'conv', routing.conversationId);
        const prev = (await cache.get<ConversationState>(convKey)) ?? {};
        writes.push(
          cache.set<ConversationState>(
            convKey,
            { lastModelKey: modelKey, ioRatio: ewma(prev.ioRatio, ratio), turns: (prev.turns ?? 0) + 1 },
            STICKY_TTL_SECONDS,
          ),
        );
      }
    }
    await Promise.all(writes);
  } catch (error) {
    logger.warn('Routed usage record failed', { error: (error as Error).message });
  }
}

/** Test hook: forget in-process history. */
export function __resetDynamicRoutingStateForTests(): void {
  spendCache.clear();
  segmentRatios.clear();
  profileCache.clear();
  profileInflight.clear();
}
