/**
 * Tenant authorization mode (C2).
 *
 *   legacy  the default: rbac.ts decides, the policy engine is never called.
 *   shadow  rbac.ts still decides; the engine is evaluated off the request path
 *           and the differences are recorded (see observer.ts / aggregate.ts).
 *
 * `enforce` arrives in C4 and is deliberately not accepted yet.
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

export type AuthzMode = 'legacy' | 'shadow';
/** Modes a tenant may select today. */
export const AUTHZ_MODES: readonly AuthzMode[] = ['legacy', 'shadow'];
/** Arrives in C4; listed so the UI can render it as "coming soon". */
export const COMING_AUTHZ_MODES: readonly string[] = ['enforce'];

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

const ttlFor = (mode: AuthzMode): number => (mode === 'shadow' ? MODE_TTL_MS : LEGACY_TTL_MS);

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

function remember(tenantDbName: string, info: AuthzModeInfo, ttlMs: number): void {
  if (!cache.has(tenantDbName) && cache.size >= MAX_TENANTS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(tenantDbName, { info, expiresAt: Date.now() + ttlMs, refreshing: false });
}

/** Authoritative read from the database (also refreshes the cache). */
export async function getAuthzMode(tenantDbName: string): Promise<AuthzModeInfo> {
  const doc = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(META, MODE_DOC_ID));
  const info = parse(doc?.data);
  remember(tenantDbName, info, ttlFor(info.mode));
  if (info.mode === 'shadow') warmEngine(tenantDbName);
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
    // Fail toward legacy (shadow off): a database problem must never leave the
    // extra background work running. Retry after a back-off.
    remember(tenantDbName, { ...DEFAULT_INFO }, FAILURE_BACKOFF_MS);
    logger.debug('Could not refresh authorization mode', {
      tenantDbName,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Synchronous mode lookup for the request gate. Never throws, never waits.
 * The first call for a tenant in a process returns `legacy` and starts a
 * background read.
 */
export function peekAuthzMode(tenantDbName: string): AuthzMode {
  try {
    if (isShadowKillSwitchOn()) return 'legacy';
    const entry = cache.get(tenantDbName);
    if (entry && entry.expiresAt > Date.now()) return entry.info.mode;
    if (!entry) {
      // Placeholder so concurrent first requests start only one read.
      remember(tenantDbName, { ...DEFAULT_INFO }, FAILURE_BACKOFF_MS);
      refreshInBackground(tenantDbName, cache.get(tenantDbName));
      return 'legacy';
    }
    refreshInBackground(tenantDbName, entry);
    return entry.info.mode;
  } catch {
    return 'legacy';
  }
}

export function resetAuthzModeCacheForTests(): void {
  cache.clear();
  warmed.clear();
}

/** Test seam: pin the cached mode without touching the database. */
export function primeAuthzModeForTests(tenantDbName: string, mode: AuthzMode, ttlMs = 60_000): void {
  remember(tenantDbName, { mode, updatedAt: null, updatedBy: null }, ttlMs);
}
