/**
 * Usage events — THE single entry point for per-service usage accounting.
 *
 * Every service that logs usage calls `recordUsageEvent(...)` which:
 *   1. resolves the shared attribution envelope (userId / apiTokenId /
 *      actorType / requestId / projectId) from the request context
 *      (AsyncLocalStorage) — services never thread identity by hand,
 *   2. feeds the additive counters into the in-memory rollup buffer that is
 *      periodically flushed into the cross-service `usage_daily` table,
 *   3. returns the attribution so the caller can stamp it onto its own raw
 *      log row.
 *
 * Raw detail logs stay in each service's own collection; `usage_daily` is the
 * primary source for usage/spend reports.
 */

import { getRequestContext } from '@/lib/core/requestContext';
import type {
  IUsageAttributionFields,
  UsageActorType,
  UsageSource,
} from '@/lib/database';
import { bufferUsageIncrement } from './usageRollup';

export interface UsageAttribution extends IUsageAttributionFields {
  requestId?: string;
  projectId?: string;
}

/** Request origin derived from the actor: 1:1 mapping today, kept as its own
 *  rollup dimension so the mapping can diverge without a schema change. */
export function sourceForActor(actorType?: UsageActorType): UsageSource | undefined {
  switch (actorType) {
    case 'api_token':
      return 'api';
    case 'user':
      return 'dashboard';
    case 'system':
      return 'system';
    default:
      return undefined;
  }
}

/**
 * Resolve the attribution envelope from the ambient request context, with
 * optional explicit overrides for call sites where the AsyncLocalStorage
 * scope is unavailable (queued jobs that captured a snapshot, runners).
 */
export function resolveUsageAttribution(
  overrides?: Partial<UsageAttribution>,
): UsageAttribution {
  const ctx = getRequestContext();
  return {
    userId: overrides?.userId ?? ctx?.userId,
    apiTokenId: overrides?.apiTokenId ?? ctx?.apiTokenId,
    actorType: overrides?.actorType ?? ctx?.actorType,
    requestId: overrides?.requestId ?? ctx?.requestId,
    projectId: overrides?.projectId ?? ctx?.projectId,
  };
}

export interface UsageEventInput {
  /** Tenant DB the event belongs to — required, rollup flush groups by it. */
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  /** Service slug: 'models' | 'websearch' | 'mcp' | 'tools' | 'rag' | ... */
  service: string;
  /** Service-local resource key: modelKey, searchKey, toolKey, ... */
  refKey?: string;
  status?: 'success' | 'error';
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Service-specific additive counters (pages, audioSeconds, results, ...). */
  units?: Record<string, number>;
  /** Explicit attribution for call sites outside the request ALS scope. */
  attribution?: Partial<UsageAttribution>;
}

/**
 * Record one usage event: resolve attribution + buffer the rollup increment.
 * Returns the resolved attribution so the caller spreads it onto its raw log
 * row (`{ ...attribution }` → userId/apiTokenId/actorType columns).
 *
 * Never throws — usage accounting must not break the serving path.
 */
export function recordUsageEvent(event: UsageEventInput): UsageAttribution {
  const attribution = resolveUsageAttribution(event.attribution);
  try {
    bufferUsageIncrement(event, attribution);
  } catch {
    // Rollup buffering is best-effort; raw logging still proceeds.
  }
  return {
    userId: attribution.userId,
    apiTokenId: attribution.apiTokenId,
    actorType: attribution.actorType,
    requestId: attribution.requestId,
    projectId: attribution.projectId,
  };
}
