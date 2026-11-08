/**
 * Managed-provider credits seam - COMMUNITY (open-source) edition.
 *
 * A hosted deployment can offer "managed" providers: provider records whose
 * upstream credentials belong to the operator rather than the tenant, and whose
 * calls are paid with credits. Core knows nothing about credits, catalogs or
 * vendors. It asks a registered host (1) whether a provider record is managed,
 * and (2) to reserve before a managed call, settle with the real usage after it
 * and release the hold when the call fails.
 *
 * Without a registered host (community, on-prem, or hosted without the overlay)
 * nothing is managed and every branch that reads this seam is skipped: the cost
 * on the hot path is one null check.
 *
 * Leaf module: no imports, so the overlay can import it at load.
 */

export type ManagedCallKind = 'chat' | 'embedding' | 'search';

/** The parts of a provider record the host needs to decide whether it is managed. */
export interface ManagedProviderRef {
  key?: string;
  driver?: string;
  type?: string;
  settings?: Record<string, unknown>;
}

export interface ManagedCallInfo {
  tenantId: string;
  tenantDbName: string;
  projectId?: string;
  providerKey: string;
  driver: string;
  modelKey?: string;
  modelId?: string;
  kind: ManagedCallKind;
  requestId: string;
  /**
   * chat: estimated prompt tokens + the output cap the request will be sent with;
   * embedding: estimated input tokens; search: units (1 basic, 2 advanced).
   */
  estimate: { inputTokens?: number; maxOutputTokens?: number; units?: number };
  attribution?: { agentKey?: string; runId?: string; route?: string; source?: string };
}

export interface ManagedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  units?: number;
  /** True when the counts are the gateway's own estimate, not the provider's report. */
  estimated?: boolean;
}

export interface ManagedCreditLease {
  readonly id: string;
  /** chat only: the highest output token limit this call may be sent with; undefined = no clamp. */
  readonly maxOutputTokens?: number;
  /** Books the real usage. Idempotent, never throws (the host logs and reconciles). */
  settle(usage: ManagedUsage): Promise<void>;
  /** Returns the hold. Idempotent, never throws. */
  release(reason: 'error' | 'cancelled' | 'no_usage'): Promise<void>;
}

export interface ManagedCreditsHost {
  isManagedProvider(ref: ManagedProviderRef): boolean;
  /**
   * Throws PlanLimitError (insufficient_credits 402, context_over_credit_cap 413,
   * credits_unavailable 503, plan_feature_unavailable 402) to refuse the call.
   */
  reserve(call: ManagedCallInfo): Promise<ManagedCreditLease>;
  /**
   * Upstream credentials of a managed record, supplied by the operator. null = not configured; the call is refused.
   */
  resolveCredentials?(ref: ManagedProviderRef): Record<string, unknown> | null;
}

let host: ManagedCreditsHost | null = null;

/** Called once by the overlay at load. A second call replaces the first. */
export function registerManagedCreditsHost(next: ManagedCreditsHost): void {
  host = next;
}

/** The registered host, or null (community edition, on-prem, hosted without the overlay). */
export function getManagedCreditsHost(): ManagedCreditsHost | null {
  return host;
}

/** True when a host is registered and says this provider record is managed. Never throws; fails closed (true) when the host throws. */
export function isManagedProviderRecord(ref: ManagedProviderRef | null | undefined): boolean {
  if (!host || !ref) return false;
  try {
    return host.isManagedProvider(ref) === true;
  } catch (error) {
    // Fail closed: a host that cannot answer is treated as managed, so refusal paths refuse and metered paths fail on reserve.
    console.error('managed-credits: isManagedProvider threw; treating the provider as managed', error);
    return true;
  }
}

/** Tests only. */
export function resetManagedCreditsHostForTests(): void {
  host = null;
}
