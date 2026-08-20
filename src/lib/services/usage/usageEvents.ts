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
  ModelUsageStatus,
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
 * Canonical rollup key for a `metadata` bag: sorted entries, JSON-serialized,
 * so `{b:'2',a:'1'}` and `{a:'1',b:'2'}` collapse into the same dimension.
 * '' when absent/empty — matches the '' convention every other dimension uses.
 *
 * Must be JSON (not a delimited `key=value&...` string): metadata values are
 * arbitrary text, so an unescaped delimiter join lets two different objects
 * collide onto the same key — e.g. `{a:'1&b=2'}` and `{a:'1',b:'2'}` would
 * both join to `'a=1&b=2'`, silently merging unrelated rollup rows.
 * JSON.stringify's quote-escaping keeps the encoding collision-free.
 */
export function canonicalMetadataKey(metadata?: Record<string, string>): string {
  if (!metadata) return '';
  const entries = Object.entries(metadata).filter(([key]) => key.length > 0);
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
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
  /** Agent the usage belongs to (tracing agentName); rollup dimension. */
  agentKey?: string;
  /** Free-form caller-supplied attribution tags (tracing `metadata`, e.g.
   *  `{ complexity: 'complex' }`); rollup dimension via `metadataKey`. */
  metadata?: Record<string, string>;
  /** Overrides the actor-derived origin — e.g. 'tracing' for usage derived
   *  from observability ingests rather than gateway-served calls. */
  source?: UsageSource;
  status?: ModelUsageStatus;
  latencyMs?: number;
  /** When `latencyMs` aggregates multiple calls (trace-derived usage), the
   *  number of calls it covers — weights the rollup's latency average. */
  latencySamples?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Subset of `outputTokens` (e.g. OpenAI `completion_tokens_details.reasoning_tokens`);
   *  never added into `totalTokens` or `costUsd`. Threaded straight into the
   *  `usage_daily` rollup increment, mirroring `cachedInputTokens`. */
  reasoningTokens?: number;
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
