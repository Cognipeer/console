/**
 * In-process reuse of what a model call needs from a provider: the record and its opened (decrypted) credentials.
 *
 * Every model call, and every step of an agent turn, goes through `loadProviderRuntimeData`, which reads the record
 * from the database and decrypts its credentials. Both only change when the provider is edited, so a short-lived
 * copy in this process removes one database read and one decrypt from each call.
 *
 * Deliberately NOT the shared cache (Redis): this holds plaintext credentials, so it never leaves the process's
 * memory. A node that did not perform an edit sees it after at most `PROVIDER_RUNTIME_TTL_MS`; the node that did
 * drops its copy at once (`invalidateProviderRuntimeCache`, called by every provider write path).
 *
 * A managed record is never stored: its connection is resolved per call by the credits host.
 */

export const PROVIDER_RUNTIME_TTL_MS = 10_000;
export const PROVIDER_RUNTIME_MAX_ENTRIES = 500;

interface Entry {
  value: unknown;
  expiresAt: number;
}

const SEP = '\u0000';

const entries = new Map<string, Entry>();
/** Bumped by every invalidation of a tenant: a load that began before it must not store what it read. */
const epochs = new Map<string, number>();

export interface ProviderRuntimeCacheKey {
  tenantDbName: string;
  projectId?: string;
  providerKey: string;
  connectionId?: string;
}

function entryKey(k: ProviderRuntimeCacheKey): string {
  return [k.tenantDbName, k.projectId ?? '', k.providerKey, k.connectionId ?? ''].join(SEP);
}

export function getCachedProviderRuntime<T>(k: ProviderRuntimeCacheKey): T | undefined {
  const key = entryKey(k);
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry.value as T;
}

/** Read this before the database read; hand it back to `setCachedProviderRuntime`. */
export function providerRuntimeEpoch(tenantDbName: string): number {
  return epochs.get(tenantDbName) ?? 0;
}

export function setCachedProviderRuntime(k: ProviderRuntimeCacheKey, value: unknown, epoch: number): void {
  // An edit landed while this value was being read: what was read may be the old record.
  if (providerRuntimeEpoch(k.tenantDbName) !== epoch) return;
  const key = entryKey(k);
  // Re-inserting moves the key to the end, so the Map's first key is always the oldest entry.
  entries.delete(key);
  entries.set(key, { value, expiresAt: Date.now() + PROVIDER_RUNTIME_TTL_MS });
  while (entries.size > PROVIDER_RUNTIME_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Drops every entry of the tenant (a provider write is rare; a precise key is not worth the risk of a miss). */
export function invalidateProviderRuntimeCache(tenantDbName: string): void {
  epochs.set(tenantDbName, (epochs.get(tenantDbName) ?? 0) + 1);
  const prefix = `${tenantDbName}${SEP}`;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/** Test only. */
export function clearProviderRuntimeCache(): void {
  entries.clear();
  epochs.clear();
}

/** Test only. */
export function providerRuntimeCacheSize(): number {
  return entries.size;
}
