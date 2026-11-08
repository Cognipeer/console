/**
 * Managed-provider credits seam - COMMUNITY (open-source) edition.
 *
 * A hosted deployment can offer "managed" providers: provider records whose
 * upstream belongs to the operator rather than the tenant, and whose calls are
 * paid with credits. Core knows nothing about credits, catalogs or vendors. It
 * asks a registered host (1) whether a provider record is managed, (2) which
 * routes (upstream connections) can serve a managed model or search right now,
 * (3) for the connection behind a route, and (4) to reserve before a managed
 * call, settle with the real usage after it and release the hold when the call
 * fails.
 *
 * A managed record is a stable public face: the route that serves a call is
 * chosen by the host at call time, so the operator can move a model to another
 * upstream without touching tenant records. Routes and connections are
 * operator-side facts and never reach a tenant-readable surface.
 *
 * Without a registered host (community, on-prem, or hosted without the overlay)
 * nothing is managed and every branch that reads this seam is skipped: the cost
 * on the hot path is one null check.
 *
 * Leaf module: no imports, so the overlay can import it at load.
 */

export type ManagedCallKind = 'chat' | 'embedding' | 'search';

/** The parts of a provider record the host needs to decide whether it is managed (core passes the stored record). */
export interface ManagedProviderRef {
  key?: string;
  driver?: string;
  type?: string;
  settings?: Record<string, unknown>;
  allProjects?: boolean;
  metadata?: Record<string, unknown> | null;
}

/**
 * One upstream that can serve a managed model (or managed search) right now. Operator-side: never written to a
 * tenant-readable surface (records, responses, usage rows, logs a tenant can read, error messages).
 */
export interface ManagedRoute {
  /** Stable id of the route (circuit-breaker keys, server logs, credit attribution). */
  id: string;
  /** Opaque id of the connection the route uses; routes sharing it share one pooled runtime. */
  connectionId: string;
  /** Provider contract id that serves the route. */
  driver: string;
  /** Upstream model id; undefined = the record's own model id. */
  modelId?: string;
  /** Model settings applied over the record's for this route (shallow merge). */
  settings?: Record<string, unknown>;
  /** Relative share of traffic; default 1. */
  weight?: number;
}

export interface ManagedRouteQuery {
  providerKey: string;
  /** Model key (chat, embedding); undefined for search. */
  modelKey?: string;
  modelId?: string;
  kind: ManagedCallKind;
}

/** What the runtime of a route is built from. Holds secrets: never log, persist or return it. */
export interface ManagedConnection {
  driver: string;
  settings: Record<string, unknown>;
  credentials: Record<string, unknown>;
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
  /** The managed route that will serve the call (operator-side attribution only). */
  routeId?: string;
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
  /** Routes that can serve this managed model or search now, live ones only. [] = not available right now. */
  listRoutes?(query: ManagedRouteQuery): ManagedRoute[];
  /**
   * The connection behind a route, for a managed record. The only door to operator secrets: null refuses the call.
   */
  resolveConnection?(ref: ManagedProviderRef, connectionId: string): ManagedConnection | null;
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

/** True when the model's provider is managed (by its key and driver; no record lookup). */
export function isManagedModel(model: { providerKey?: string; providerDriver?: string } | null | undefined): boolean {
  if (!host || !model?.providerKey) return false;
  return isManagedProviderRecord({ key: model.providerKey, driver: model.providerDriver });
}

/** The host's live routes for a managed model or search. Never throws: no host, no method or a throw gives []. */
export function listManagedRoutes(query: ManagedRouteQuery): ManagedRoute[] {
  if (!host?.listRoutes) return [];
  try {
    const routes = host.listRoutes(query);
    return Array.isArray(routes) ? routes.filter((route) => Boolean(route?.id && route.connectionId && route.driver)) : [];
  } catch (error) {
    console.error('managed-credits: listRoutes threw; no route is available', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/** Tests only. */
export function resetManagedCreditsHostForTests(): void {
  host = null;
}
