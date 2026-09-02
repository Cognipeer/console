/**
 * Read-path record caches for the guardrail hook plane.
 *
 * WHY THIS EXISTS. `runHook` is on the request path of every gateway call,
 * every agent turn and every MCP/sandbox tool invocation, and a single streamed
 * answer runs it once per hold-back window (~17 times for a 4K answer at the
 * 256-char default). Without a cache each of those windows pays a
 * `findGuardrailByKey` round trip, and a lifted PII policy pays a
 * `findPiiPolicyByKey` on top — so the guardrail's own latency would be
 * dominated by re-reading a row nobody changed. This is the same trade
 * `wordListService.ts:219-268` already made for word lists, with the same TTL
 * and the same one-sentence justification ("evaluateGuardrail runs on every
 * request; hitting the DB for each referenced list would double the guardrail's
 * own latency"), so operators only have one staleness window to reason about.
 *
 * THE CACHED VALUE IS SHARED. Callers get the SAME object on every hit, so it
 * must be treated as immutable: writing `record.hooks` in place would publish a
 * derived config to every other holder, and `hooks/legacy.ts#ensureHooks` is
 * deliberately non-mutating for exactly this reason. Outside production the
 * entry is shallow-frozen so that mistake throws in dev and in tests instead of
 * becoming a cross-request bug in prod.
 *
 * NEGATIVE RESULTS ARE CACHED TOO, and they are not an optimisation for the
 * happy path: an unknown guardrail key is a MISCONFIGURED tenant, i.e. exactly
 * the case that repeats on every request, and the legacy facade turns it into a
 * thrown error and a 404. Their TTL is short (5s), so a guardrail created
 * through the UI becomes visible almost immediately rather than a minute later.
 *
 * INVALIDATION IS EXPLICIT. Every save path that writes a guardrail or a PII
 * policy must call the matching `invalidate*` — a TTL is a bound on how long a
 * stale answer can survive an operator's edit, not a substitute for telling the
 * cache about it.
 */

import { getDatabase, runWithTenantScope } from '@/lib/database';
import type { IGuardrail, IPiiPolicy, ITenant } from '@/lib/database';

/** Same window as the word-list cache, deliberately: one staleness story. */
export const RECORD_CACHE_TTL_MS = 60_000;

/**
 * Negative results expire fast. A miss usually means "not created yet", and a
 * minute of remembering that a guardrail does not exist would make a freshly
 * created one look broken for a minute. Mirrors the failure TTL
 * `hooks/legacy.ts` uses for the same reason.
 */
export const RECORD_CACHE_MISS_TTL_MS = 5_000;

/**
 * A tenant's `dbName` is effectively immutable — it is chosen at provisioning
 * and every stored row is addressed by it — so this one gets the 5-minute
 * window the MCP bridge it replaces already used, rather than the 60s window
 * that exists for operator edits.
 */
export const TENANT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Per-map entry cap. TTLs alone never shrink a Map: an expired entry is only
 * replaced when its key is read again, so a map keyed by tenant x guardrail key
 * grows with the fleet and never gives memory back. Eviction is
 * insertion-order (Map iteration order), which is a FIFO rather than an LRU —
 * good enough here, because the working set of a busy process is a handful of
 * keys per tenant and the penalty for evicting a hot key is one DB read.
 */
const MAX_ENTRIES = 500;

/**
 * Written as an ESCAPE rather than as a literal NUL byte in the source: a raw
 * NUL makes the file read as binary to `grep`, `file` and every diff viewer,
 * which two sibling modules in this tree have already had to fix.
 */
const KEY_SEP = '\u0000';

interface CacheEntry<T> {
  value: T | null;
  expiresAt: number;
}

/**
 * A TTL map with single-flight loading.
 *
 * SINGLE FLIGHT MATTERS HERE. On a cold cache — process start, a deploy, or the
 * first request after a TTL expiry — N concurrent requests for one tenant would
 * otherwise issue N identical reads against the same row, which is the shape of
 * the read storm that has already taken a tenant database down in this repo.
 * Sharing one in-flight promise costs one Map entry and collapses the burst.
 * A rejection is NOT remembered: the entry is dropped in `finally`, so the next
 * caller retries rather than inheriting a failure it never made.
 */
class RecordCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T | null>>();

  constructor(
    private readonly ttlMs: number,
    private readonly missTtlMs: number,
  ) {}

  async get(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    // The in-flight map is also the WRITE PERMIT for this load. `invalidate`
    // removes the entry, and a load that is no longer the registered one when
    // it resolves returns its (pre-save) row to its own caller but does NOT
    // write it back — otherwise a save racing a cold read is undone for a full
    // TTL by the read it raced, while the UI shows the new policy. The same
    // identity check keeps the `finally` from evicting a NEWER load that
    // replaced this one after an invalidation.
    const task: Promise<T | null> = load()
      .then((value) => {
        if (this.inflight.get(key) === task) this.set(key, value);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === task) this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  private set(key: string, value: T | null): void {
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, {
      value: freezeInDev(value),
      expiresAt: Date.now() + (value === null ? this.missTtlMs : this.ttlMs),
    });
  }

  /** Drops every entry whose key starts with `prefix`; `undefined` clears all.
   *  Iterating is fine: the map is capped, and invalidation runs on save, not
   *  on the request path. */
  invalidate(prefix?: string): void {
    if (prefix === undefined) {
      this.entries.clear();
      this.inflight.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    // In-flight loads started before the write may still resolve with the old
    // row. Dropping them here revokes their write permit (see `get`): the
    // promise still settles for its callers, but `set` is skipped, so a save
    // racing a read cannot repopulate the cache with the value it replaced.
    for (const key of this.inflight.keys()) {
      if (key.startsWith(prefix)) this.inflight.delete(key);
    }
  }
}

/**
 * Shallow-freeze outside production so an accidental in-place edit of a shared
 * record throws where a developer will see it. Production keeps the raw object:
 * a `TypeError` on a hot path is a worse outcome than a stale field, and the
 * dev/test run is what catches the mistake in the first place.
 */
function freezeInDev<T>(value: T | null): T | null {
  if (value !== null && typeof value === 'object' && process.env.NODE_ENV !== 'production') {
    return Object.freeze(value);
  }
  return value;
}

const guardrailCache = new RecordCache<IGuardrail>(RECORD_CACHE_TTL_MS, RECORD_CACHE_MISS_TTL_MS);
const piiPolicyCache = new RecordCache<IPiiPolicy>(RECORD_CACHE_TTL_MS, RECORD_CACHE_MISS_TTL_MS);
const tenantCache = new RecordCache<ITenant>(TENANT_CACHE_TTL_MS, RECORD_CACHE_MISS_TTL_MS);

/**
 * The key mirrors the LOOKUP ARGUMENTS, not the row: `findGuardrailByKey`
 * answers THREE different questions depending on `projectId` — a string is
 * that project's row, `null` is the tenant-wide row, `undefined` is the first
 * row of any project — so all three must occupy distinct cache slots. The
 * project -> tenant fallback composes two cached lookups; see
 * `resolveGuardrail` in engine.ts.
 *
 * A NUL separator because it cannot occur in a slug key, a project id or a
 * database name, so no two distinct argument tuples can collide onto one
 * cache key; the two sentinels below start with it for the same reason.
 */
const TENANT_WIDE_SLOT = `${KEY_SEP}null`;
const ANY_PROJECT_SLOT = `${KEY_SEP}any`;

function recordKey(tenantDbName: string, key: string, projectId?: string | null): string {
  const slot =
    projectId === null ? TENANT_WIDE_SLOT : projectId === undefined ? ANY_PROJECT_SLOT : projectId;
  return `${tenantDbName}${KEY_SEP}${key}${KEY_SEP}${slot}`;
}

/** Prefix shared by every projectId variant of one (tenantDbName, key) pair. */
function recordPrefix(tenantDbName?: string, key?: string): string | undefined {
  if (tenantDbName === undefined) return undefined;
  if (key === undefined) return `${tenantDbName}${KEY_SEP}`;
  return `${tenantDbName}${KEY_SEP}${key}${KEY_SEP}`;
}

/**
 * `findGuardrailByKey(key, projectId)`, cached and tenant-scoped. `projectId`
 * keeps the provider contract's three-way meaning: pass `null` for the
 * tenant-wide row, never `undefined`, on a fallback path.
 *
 * The read runs inside `runWithTenantScope` rather than a bare
 * `switchToTenant`: this is called from SDK, MCP and sandbox frames that the
 * console's request ALS does not own, and `switchToTenant` is `enterWith` under
 * the hood — the documented cross-tenant race this repo has already been bitten
 * by.
 */
export async function getCachedGuardrail(
  tenantDbName: string,
  key: string,
  projectId?: string | null,
): Promise<IGuardrail | null> {
  return guardrailCache.get(recordKey(tenantDbName, key, projectId), () =>
    runWithTenantScope(tenantDbName, (db) => db.findGuardrailByKey(key, projectId)),
  );
}

/**
 * `findPiiPolicyByKey(key, projectId)`, cached and tenant-scoped.
 *
 * The `pii` family resolves its `piiPolicyKey` through `scanWithPolicy`, which
 * does an uncached lookup per call — once per hook call plus once per obfuscated
 * segment. This is the cache that lookup should be routed through; it is
 * deliberately the ONLY policy cache, so there is one invalidation surface
 * rather than two that can disagree.
 */
export async function getCachedPiiPolicy(
  tenantDbName: string,
  key: string,
  projectId?: string | null,
): Promise<IPiiPolicy | null> {
  return piiPolicyCache.get(recordKey(tenantDbName, key, projectId), () =>
    runWithTenantScope(tenantDbName, (db) => db.findPiiPolicyByKey(key, projectId)),
  );
}

/**
 * `findTenantById`, cached. This one is a GLOBAL lookup — the tenant registry
 * lives outside any tenant database — so it deliberately does NOT run inside a
 * tenant scope.
 *
 * A failed read resolves to `null` rather than throwing: the one caller that
 * needs it (the MCP bridge, which has a `tenantId` and no `tenantDbName`
 * because `McpGuardrailContext` is frozen) must degrade to "cannot evaluate",
 * not take down the tool call with a database error.
 */
export async function getCachedTenant(tenantId: string): Promise<ITenant | null> {
  return tenantCache.get(tenantId, async () => {
    const db = await getDatabase();
    return db.findTenantById(tenantId).catch(() => null);
  });
}

/** The one thing callers actually want from a tenant record here. */
export async function resolveTenantDbName(tenantId: string): Promise<string | null> {
  const tenant = await getCachedTenant(tenantId);
  return tenant?.dbName ?? null;
}

/**
 * Call from EVERY path that writes a guardrail — create, update and delete in
 * `guardrailService`, and `ensureDefaultToolGuardrail`'s materialisation.
 * Omitting `key` clears the whole tenant (right for a bulk import); omitting
 * both clears everything (tests, and a provider swap).
 */
export function invalidateGuardrailCache(tenantDbName?: string, key?: string): void {
  guardrailCache.invalidate(recordPrefix(tenantDbName, key));
}

/** Call from every PII policy save/delete, including the generated
 *  `pii-migrated-<guardrailKey>` policies the legacy lift provisions. */
export function invalidatePiiPolicyCache(tenantDbName?: string, key?: string): void {
  piiPolicyCache.invalidate(recordPrefix(tenantDbName, key));
}

/** Only needed when a tenant's `dbName` changes, which is a migration event. */
export function invalidateTenantCache(tenantId?: string): void {
  tenantCache.invalidate(tenantId);
}

/** Test hook: drops all three maps. Module-level caches otherwise leak state
 *  between cases in the same file and make ordering matter. */
export function resetRecordCaches(): void {
  invalidateGuardrailCache();
  invalidatePiiPolicyCache();
  invalidateTenantCache();
}
