/**
 * Plan limits: shared types. Every check reads a `TenantLimits` value and never
 * learns who produced it (the tenant license `plan` claim, or the deployment's
 * default plan). Hosted (saas) deployments only; see `mode.ts`.
 */

/** off = not measured; shadow = measured, would-be refusals recorded, nothing refused; on = refusals apply. */
export type PlanLimitsMode = 'off' | 'shadow' | 'on';

/** Things counted while they are in progress (a lease is held for each). */
export type ConcurrencyPool = 'agent' | 'flow' | 'job' | 'crawler' | 'browser' | 'realtime' | 'sandbox';

/** Things counted per calendar month (UTC). Sandbox time is stored in seconds and limited in hours. */
export type MonthlyMeter = 'searches' | 'flowRuns' | 'crawlerPages' | 'sandboxSeconds';

/** Every dimension a decision or an event can be about. */
export type PlanLimitKind =
  | 'api_rpm'
  | 'concurrency'
  | 'monthly'
  | 'storage'
  | 'seats'
  | 'credits'
  | 'context'
  | 'feature';

export interface TenantLimits {
  /** Where the values came from: the tenant license, or the deployment default plan (tenant has no plan claim). */
  source: 'license' | 'default';
  /** Plan id, e.g. `team`. */
  plan: string;
  planName?: string;
  capacityPacks?: number;
  /** Requests per minute across the tenant's API entry points; undefined = no limit. */
  apiRpm?: number;
  /** In-progress limits per pool; a missing pool has no limit, 0 = none allowed. */
  concurrency: Partial<Record<ConcurrencyPool, number>>;
  /**
   * Per calendar month (UTC); a missing entry has no limit, 0 = none allowed. Web searches are counted
   * but never limited here: hosted search is paid per search with credits.
   */
  monthly: { flowRuns?: number; crawlerPages?: number; sandboxHours?: number };
  /** Stored bytes the tenant may hold; undefined = no limit. */
  storageBytes?: number;
  seats: { console?: number; portal?: number };
  sandboxMaxSize?: { cpu: number; memoryMb: number };
  realtimeMaxSessionMinutes?: number;
  credits: { includedPerMonth?: number };
  /** License expiry, shown as the renewal date. */
  expiresAt?: Date;
}

export interface ResolvedTenantPlan {
  tenantId: string;
  /** Effective for this tenant (deployment mode × tenant enforcement). */
  mode: PlanLimitsMode;
  /** null = no plan applies (nothing to measure against). */
  limits: TenantLimits | null;
}

export type PlanLimitOutcome = 'allowed' | 'refused' | 'would_refuse';

export interface PlanLimitDecision {
  /** false only when the effective mode is `on` and the limit is reached. */
  allowed: boolean;
  outcome: PlanLimitOutcome;
  kind: PlanLimitKind;
  /** The pool, meter or other dimension name (e.g. `agent`, `flowRuns`). */
  dimension?: string;
  limit?: number;
  used?: number;
  retryAfterMs?: number;
  resetAt?: Date;
}

export type PlanLimitSourceType =
  | 'api_token'
  | 'user'
  | 'agent'
  | 'flow'
  | 'job'
  | 'webhook'
  | 'a2a'
  | 'mcp'
  | 'portal'
  | 'channel'
  | 'schedule'
  | 'system';

export interface PlanLimitSource {
  type: PlanLimitSourceType;
  id?: string;
  label?: string;
}

/** A refusal (on), a would-be refusal (shadow), or a wait for a free slot. */
export interface PlanLimitEvent {
  tenantId: string;
  kind: PlanLimitKind;
  dimension?: string;
  outcome: 'refused' | 'would_refuse' | 'queued' | 'waited';
  mode: 'shadow' | 'on';
  limit?: number;
  used?: number;
  waitMs?: number;
  source?: PlanLimitSource;
  /** Events folded into this one by sampling (at least 1). */
  count: number;
  at: Date;
}
