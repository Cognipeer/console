/**
 * Tenant authorization mode (C2).
 *
 *   legacy  the default: rbac.ts decides, the policy engine is never called.
 *   shadow  rbac.ts still decides; the engine is evaluated off the request path
 *           and the differences are recorded (see observer.ts / aggregate.ts).
 *   enforce the policy engine decides (iam/enforce.ts); the legacy decision is
 *           still computed (fallback + audit trail: shadow keeps recording the
 *           legacy-vs-engine differences).
 *
 * Kill switches (operator, env, no deploy of code): IAM_SHADOW_DISABLED=1 stops
 * the shadow recording; IAM_ENFORCE_DISABLED=1 forces LEGACY decisions
 * everywhere even for tenants stored as `enforce`.
 *
 * Where it lives: the platform has no tenant-settings document (tenant-level
 * knobs are spread over typed collections), so the mode is one small document
 * in the policy engine's own lazily-created `iam_meta` collection/table
 * (id `authz_mode`) in the tenant database. Nothing to migrate, identical on
 * MongoDB and SQLite, and a tenant that never touches it never creates it
 * (reads of a missing collection/table return "no document" and run no DDL).
 *
 * Hot path: the request gate calls `peekAuthzMode()`, which is a synchronous
 * Map lookup. A stale or missing entry triggers a background refresh and the
 * previous value (default `legacy`) is used meanwhile, so the gate never waits
 * for the database. Safe direction: when the mode cannot be read, the tenant
 * falls back to `legacy` (shadow off) for a back-off period instead of staying
 * in shadow; `IAM_SHADOW_DISABLED=1` is an operator kill switch that forces
 * `legacy` for every tenant without touching the database. A tenant in
 * `legacy` is re-checked every LEGACY_TTL_MS, a tenant in `shadow` every
 * MODE_TTL_MS, so a change made on another node is picked up within those.
 */

import { runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('iam:mode');

export type AuthzMode = 'legacy' | 'shadow' | 'enforce';
/** Modes a tenant may select. */
export const AUTHZ_MODES: readonly AuthzMode[] = ['legacy', 'shadow', 'enforce'];
/** Modes announced but not selectable yet (none: enforce shipped in C4). */
export const COMING_AUTHZ_MODES: readonly string[] = [];

/** Re-check interval while a tenant is in shadow (how fast "off" propagates). */
export const MODE_TTL_MS = 5_000;
/** Re-check interval while a tenant is in legacy (the common case: keep it cheap). */
export const LEGACY_TTL_MS = 30_000;
/** After a failed refresh, wait this long before trying again. */
const FAILURE_BACKOFF_MS = 30_000;
const MAX_TENANTS = 5_000;
const MODE_DOC_ID = 'authz_mode';
const META = 'iam_meta' as const;

export interface AuthzModeInfo {
  mode: AuthzMode;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface Entry {
  info: AuthzModeInfo;
  expiresAt: number;
  refreshing: boolean;
  /** First-access stand-in (nothing was read yet); not an answer for enforcement. */
  placeholder?: boolean;
}

const cache = new Map<string, Entry>();
const DEFAULT_INFO: AuthzModeInfo = { mode: 'legacy', updatedAt: null, updatedBy: null };

export function isAuthzMode(value: unknown): value is AuthzMode {
  return typeof value === 'string' && (AUTHZ_MODES as readonly string[]).includes(value);
}

function parse(data: Record<string, unknown> | undefined): AuthzModeInfo {
  if (!data || !isAuthzMode(data.mode)) return { ...DEFAULT_INFO };
  return {
    mode: data.mode,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null,
  };
}

/** Operator kill switch, read on every call so it can be flipped without a deploy of code. */
export function isShadowKillSwitchOn(): boolean {
  const v = process.env.IAM_SHADOW_DISABLED;
  return v === '1' || v === 'true';
}

/** Operator kill switch for enforcement: every decision is the legacy one. */
export function isEnforceKillSwitchOn(): boolean {
  const v = process.env.IAM_ENFORCE_DISABLED;
  return v === '1' || v === 'true';
}

/** `shadow` and `enforce` both record the legacy-vs-engine differences. */
export function recordsShadow(mode: AuthzMode): boolean {
  return mode === 'shadow' || mode === 'enforce';
}

// A tenant in shadow/enforce is re-checked quickly: "off" (or a switch back
// from enforce) must propagate to every node within MODE_TTL_MS.
const ttlFor = (mode: AuthzMode): number => (mode === 'legacy' ? LEGACY_TTL_MS : MODE_TTL_MS);

/** Tenants whose engine we already started warming up in this process. */
const warmed = new Set<string>();

/** Load Cedar + the tenant's policy set off the request path, once per tenant. */
function warmEngine(tenantDbName: string): void {
  if (warmed.has(tenantDbName) || warmed.size >= MAX_TENANTS) return;
  warmed.add(tenantDbName);
  import('./selfTest')
    .then((m) => m.engineSelfTest(tenantDbName))
    .catch(() => {
      warmed.delete(tenantDbName);
    });
}

function remember(tenantDbName: string, info: AuthzModeInfo, ttlMs: number, placeholder = false): void {
  if (!cache.has(tenantDbName) && cache.size >= MAX_TENANTS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(tenantDbName, { info, expiresAt: Date.now() + ttlMs, refreshing: false, placeholder });
}

/** Authoritative read from the database (also refreshes the cache). */
export async function getAuthzMode(tenantDbName: string): Promise<AuthzModeInfo> {
  const doc = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(META, MODE_DOC_ID));
  const info = parse(doc?.data);
  remember(tenantDbName, info, ttlFor(info.mode));
  if (recordsShadow(info.mode)) warmEngine(tenantDbName);
  return info;
}

/** Persist a new mode. Throws for a mode that is not selectable. */
export async function setAuthzMode(tenantDbName: string, mode: AuthzMode, actor: string): Promise<AuthzModeInfo> {
  if (!isAuthzMode(mode)) throw new Error(`Unsupported authorization mode "${String(mode)}"`);
  const info: AuthzModeInfo = { mode, updatedAt: new Date().toISOString(), updatedBy: actor };
  await runWithTenantScope(tenantDbName, (db) => db.iamDocPut(META, MODE_DOC_ID, { ...info }));
  remember(tenantDbName, info, ttlFor(info.mode));
  return info;
}

function refreshInBackground(tenantDbName: string, entry: Entry | undefined): void {
  if (entry?.refreshing) return;
  if (entry) entry.refreshing = true;
  getAuthzMode(tenantDbName).catch((error) => {
    // Shadow fails toward legacy (a database problem must never leave extra
    // background work running). ENFORCE keeps its last known mode for the
    // back-off period instead: the request gate must not flip an enforce
    // tenant to legacy decisions because of a database blip (the engine and the
    // legacy fallback already cover a failing engine). Retry after a back-off.
    const previous = cache.get(tenantDbName);
    const keep = previous && !previous.placeholder && previous.info.mode === 'enforce'
      ? { ...previous.info }
      : { ...DEFAULT_INFO };
    remember(tenantDbName, keep, FAILURE_BACKOFF_MS);
    logger.debug('Could not refresh authorization mode', {
      tenantDbName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Raw, synchronous cache lookup (no kill switches). Never throws, never waits. */
function peekStoredMode(tenantDbName: string): AuthzMode {
  try {
    const entry = cache.get(tenantDbName);
    if (entry && entry.expiresAt > Date.now()) return entry.info.mode;
    if (!entry) {
      // Placeholder so concurrent first requests start only one read.
      remember(tenantDbName, { ...DEFAULT_INFO }, FAILURE_BACKOFF_MS, true);
      refreshInBackground(tenantDbName, cache.get(tenantDbName));
      return 'legacy';
    }
    refreshInBackground(tenantDbName, entry);
    return entry.info.mode;
  } catch {
    return 'legacy';
  }
}

/**
 * Synchronous mode lookup for the SHADOW recording of the request gate (and
 * for anything that only needs the stored mode). Never throws, never waits.
 * The first call for a tenant in a process returns `legacy` and starts a
 * background read. IAM_SHADOW_DISABLED forces `legacy`.
 */
export function peekAuthzMode(tenantDbName: string): AuthzMode {
  try {
    if (isShadowKillSwitchOn()) return 'legacy';
    return peekStoredMode(tenantDbName);
  } catch {
    return 'legacy';
  }
}

/** How long the gate waits for the very first mode read of a tenant before it uses legacy. */
export const ENFORCEMENT_LOOKUP_TIMEOUT_MS = 1_000;
/** After a timed-out first read, how long legacy is assumed before asking again. */
const TIMEOUT_BACKOFF_MS = 2_000;

const inFlight = new Map<string, Promise<AuthzModeInfo>>();

function sharedRead(tenantDbName: string): Promise<AuthzModeInfo> {
  let pending = inFlight.get(tenantDbName);
  if (!pending) {
    pending = getAuthzMode(tenantDbName).finally(() => {
      inFlight.delete(tenantDbName);
    });
    inFlight.set(tenantDbName, pending);
  }
  return pending;
}

/** Counts the times the gate had to assume `legacy` because the mode could not be read in time. */
export interface ModeLookupStats {
  /** First read of a tenant timed out or failed -> legacy assumed for a short back-off. */
  fallbacks: number;
  lastFallbackAt: string | null;
  /** Coarse reason only (`mode_lookup_timeout` | `mode_lookup_failed`), never an error message. */
  lastFallbackReason: 'mode_lookup_timeout' | 'mode_lookup_failed' | null;
}
const modeLookupStats: ModeLookupStats = { fallbacks: 0, lastFallbackAt: null, lastFallbackReason: null };
let lastModeLookupLogAt = 0;

export function getModeLookupStats(): ModeLookupStats {
  return { ...modeLookupStats };
}

function recordModeLookupFallback(
  tenantDbName: string,
  reason: 'mode_lookup_timeout' | 'mode_lookup_failed',
  error?: unknown,
): void {
  modeLookupStats.fallbacks++;
  modeLookupStats.lastFallbackAt = new Date().toISOString();
  modeLookupStats.lastFallbackReason = reason;
  const now = Date.now();
  if (now - lastModeLookupLogAt >= 10_000) {
    lastModeLookupLogAt = now;
    logger.warn('IAM: authorization mode could not be read in time, assuming legacy for a short while', {
      tenantDbName,
      reason,
      error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    });
  }
}

/**
 * Is the policy engine DECIDING for this tenant (stored mode `enforce`, operator
 * kill switch IAM_ENFORCE_DISABLED not set)? Never answers from a placeholder.
 *
 *  - A known mode (fresh OR expired) answers immediately; an expired one is
 *    refreshed in the background (stale-while-revalidate), so the request path of
 *    a legacy tenant never waits for the database again after the first read, and
 *    a database blip cannot flip an enforce tenant (refreshInBackground keeps
 *    `enforce` while the read fails).
 *  - A tenant never read in this process reads the mode first (concurrent requests
 *    share one read), waiting at most ENFORCEMENT_LOOKUP_TIMEOUT_MS. When the read
 *    fails or times out the tenant is `legacy` for a short back-off (the safe
 *    direction), the event is counted and logged, and a timed-out read keeps
 *    running and corrects the cache when it lands.
 */
export async function resolveEnforcement(tenantDbName: string): Promise<boolean> {
  try {
    if (isEnforceKillSwitchOn()) return false;
    const entry = cache.get(tenantDbName);
    if (entry && !entry.placeholder) {
      if (entry.expiresAt <= Date.now()) refreshInBackground(tenantDbName, entry);
      return entry.info.mode === 'enforce';
    }

    const fallback = (backoffMs: number, reason: 'mode_lookup_timeout' | 'mode_lookup_failed', error?: unknown): boolean => {
      try {
        remember(tenantDbName, { ...DEFAULT_INFO }, backoffMs);
        recordModeLookupFallback(tenantDbName, reason, error);
      } catch {
        // nothing may escape into the request path
      }
      return false;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('timeout');
    const read = sharedRead(tenantDbName);
    let outcome: AuthzModeInfo | typeof timedOut;
    try {
      outcome = await Promise.race([
        read,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), ENFORCEMENT_LOOKUP_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      return fallback(FAILURE_BACKOFF_MS, 'mode_lookup_failed', error);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome === timedOut) {
      // Keep the late result from becoming an unhandled rejection.
      read.catch(() => undefined);
      return fallback(TIMEOUT_BACKOFF_MS, 'mode_lookup_timeout');
    }
    return outcome.mode === 'enforce';
  } catch {
    return false;
  }
}

export function resetAuthzModeCacheForTests(): void {
  modeLookupStats.fallbacks = 0;
  modeLookupStats.lastFallbackAt = null;
  modeLookupStats.lastFallbackReason = null;
  lastModeLookupLogAt = 0;
  cache.clear();
  warmed.clear();
  inFlight.clear();
}

/** Test seam: pin the cached mode without touching the database. */
export function primeAuthzModeForTests(tenantDbName: string, mode: AuthzMode, ttlMs = 60_000): void {
  remember(tenantDbName, { mode, updatedAt: null, updatedBy: null }, ttlMs);
}
