/**
 * Resource Registry service: fans out to every registered type's provider, then
 * filters / facets / paginates the mapped records.
 *
 * Invariants (see the R1 spec):
 *  - providers run inside runWithTenantScope(tenantDbName) — never bare switchToTenant;
 *  - a failing or slow provider is isolated (errors[]), the rest still return;
 *  - nothing is silently capped (truncated[]);
 *  - a record that claims a different tenant is dropped (defence in depth: the
 *    DB handle is the real boundary);
 *  - only MAPPED records are cached, never raw documents.
 */
import { runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { buildCrn } from './crn';
import { getResourceTypeDefinition, listResourceTypeDefinitions } from './registry';
import { ensureCommunityResourceTypesRegistered } from './providers';
import type {
  GetResourceInput,
  ListResourcesInput,
  ListResourcesResult,
  ResourceDetail,
  ResourceListItem,
  ResourceProviderContext,
  ResourceProviderError,
  ResourceRecord,
  ResourceTruncation,
  ResourceTypeDefinition,
} from './types';

const logger = createLogger('resources');

export const PROVIDER_TIMEOUT_MS = 10_000;
export const SOFT_CAP_PER_TYPE = 5000;
export const CACHE_TTL_MS = 30_000;
export const CACHE_MAX_TENANTS = 50;
/** Total mapped records held across ALL cached tenants (memory bound). */
export const CACHE_MAX_TOTAL_RECORDS = 200_000;
/** refresh=1 inside this window serves the cached snapshot (no DB amplification). */
export const MIN_REFRESH_INTERVAL_MS = 5_000;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Bad caller input (unknown type id). The API maps it to 400. */
export class ResourceQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceQueryError';
  }
}

interface Directory {
  projects: Array<{ id: string; name: string }>;
  /** user id -> display label (email, else name). */
  userLabels: Map<string, string>;
}

interface Snapshot extends Directory {
  tenantId: string;
  records: ResourceRecord[];
  errors: ResourceProviderError[];
  truncated: ResourceTruncation[];
  generatedAt: string;
  at: number;
}

// Insertion order doubles as recency: a hit re-inserts, so the first key is the
// least recently used and is evicted when the map is over capacity.
const cache = new Map<string, Snapshot>();
const inflight = new Map<string, Promise<Snapshot>>();

export function clearResourceCache(): void {
  cache.clear();
  inflight.clear();
  detailInflight.clear();
}

function cacheGet(tenantDbName: string, tenantId: string): Snapshot | null {
  const hit = cache.get(tenantDbName);
  if (!hit) return null;
  if (hit.tenantId !== tenantId || Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(tenantDbName);
    return null;
  }
  cache.delete(tenantDbName);
  cache.set(tenantDbName, hit);
  return hit;
}

function cacheSet(tenantDbName: string, snapshot: Snapshot): void {
  cache.delete(tenantDbName);
  cache.set(tenantDbName, snapshot);
  // Expired entries are otherwise only dropped when read, so sweep on write.
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (key !== tenantDbName && now - entry.at > CACHE_TTL_MS) cache.delete(key);
  }
  let total = 0;
  for (const entry of cache.values()) total += entry.records.length;
  // Evict least recently used until under both bounds; the newest entry always stays.
  while (cache.size > 1 && (cache.size > CACHE_MAX_TENANTS || total > CACHE_MAX_TOTAL_RECORDS)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    total -= cache.get(oldest)?.records.length ?? 0;
    cache.delete(oldest);
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Never keep the process alive just for the guard.
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sortKey(r: ResourceRecord): number {
  const t = Date.parse(r.updatedAt ?? r.createdAt ?? '');
  return Number.isNaN(t) ? 0 : t;
}

function compareRecords(a: ResourceRecord, b: ResourceRecord): number {
  // Same key as the soft cap, so what the cap keeps is what the list ranks first.
  const byTime = sortKey(b) - sortKey(a);
  if (byTime !== 0) return byTime;
  return a.name.localeCompare(b.name);
}

/** Free text is clipped so one pasted blob cannot bloat every list response and the cache. */
function clipRecord(r: ResourceRecord): ResourceRecord {
  const name = r.name.length > MAX_NAME_LENGTH ? `${r.name.slice(0, MAX_NAME_LENGTH)}…` : r.name;
  const description = r.description && r.description.length > MAX_DESCRIPTION_LENGTH
    ? `${r.description.slice(0, MAX_DESCRIPTION_LENGTH)}…`
    : r.description;
  return name === r.name && description === r.description ? r : { ...r, name, description };
}

async function loadType(
  def: ResourceTypeDefinition,
  ctx: ResourceProviderContext,
): Promise<{ records: ResourceRecord[]; error?: ResourceProviderError; truncated?: ResourceTruncation }> {
  try {
    const raw = await withTimeout(def.list(ctx), PROVIDER_TIMEOUT_MS, `Resource type ${def.type}`);
    const records: ResourceRecord[] = [];
    let dropped = 0;
    for (const r of raw) {
      if (r.tenantId && String(r.tenantId) !== ctx.tenantId) {
        dropped++;
        continue;
      }
      records.push(clipRecord(r));
    }
    // One aggregated line per type (identifiers only, never row content): a
    // systematic tenantId mismatch must be visible rather than silently hide a type.
    if (dropped > 0) logger.warn('Dropped resources claiming another tenant', { type: def.type, count: dropped });
    if (records.length > SOFT_CAP_PER_TYPE) {
      records.sort((a, b) => sortKey(b) - sortKey(a));
      return {
        records: records.slice(0, SOFT_CAP_PER_TYPE),
        truncated: { type: def.type, limit: SOFT_CAP_PER_TYPE },
      };
    }
    return { records };
  } catch (error) {
    logger.error('Resource provider failed', {
      type: def.type,
      error: error instanceof Error ? error.message : String(error),
    });
    const timedOut = error instanceof Error && /timed out/.test(error.message);
    return {
      records: [],
      error: {
        type: def.type,
        // Generic on purpose: provider errors can echo connection strings.
        message: timedOut ? 'Timed out while loading this resource type' : 'Failed to load this resource type',
      },
    };
  }
}

/** ONE projects read + ONE users read, shared by every row. */
async function loadDirectory(ctx: ResourceProviderContext): Promise<Directory> {
  // Same bound as the providers: a hung projects/users read degrades to empty
  // names/labels instead of stalling the request.
  const guarded = <T,>(work: Promise<T>, label: string): Promise<T | never[]> =>
    withTimeout(work, PROVIDER_TIMEOUT_MS, label).catch((error: unknown) => {
      logger.warn(`Resource registry could not read ${label}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
  const [projects, users] = (await Promise.all([
    guarded(ctx.db.listProjects(ctx.tenantId), 'projects'),
    guarded(ctx.db.listUsers(), 'users'),
  ])) as [Awaited<ReturnType<typeof ctx.db.listProjects>>, Awaited<ReturnType<typeof ctx.db.listUsers>>];
  const userLabels = new Map<string, string>();
  for (const u of users) {
    const label = u.email || u.name;
    if (u._id && label) userLabels.set(String(u._id), label);
  }
  return {
    projects: projects.map((p) => ({ id: String(p._id), name: p.name })),
    userLabels,
  };
}

async function buildSnapshot(input: { tenantDbName: string; tenantId: string }): Promise<Snapshot> {
  ensureCommunityResourceTypesRegistered();
  return runWithTenantScope(input.tenantDbName, async (db) => {
    const ctx: ResourceProviderContext = { db, tenantId: input.tenantId, tenantDbName: input.tenantDbName };
    const defs = listResourceTypeDefinitions();
    const [results, directory] = await Promise.all([
      Promise.all(defs.map((def) => loadType(def, ctx))),
      loadDirectory(ctx),
    ]);
    const records: ResourceRecord[] = [];
    const errors: ResourceProviderError[] = [];
    const truncated: ResourceTruncation[] = [];
    for (const result of results) {
      records.push(...result.records);
      if (result.error) errors.push(result.error);
      if (result.truncated) truncated.push(result.truncated);
    }
    const now = Date.now();
    return {
      tenantId: input.tenantId,
      records,
      errors,
      truncated,
      ...directory,
      generatedAt: new Date(now).toISOString(),
      at: now,
    };
  });
}

async function getSnapshot(
  input: { tenantDbName: string; tenantId: string },
  refresh: boolean,
): Promise<Snapshot> {
  // A build already running is always joined, refresh or not: the timeout only
  // abandons slow queries, it does not cancel them, so parallel rebuilds pile up.
  const pending = inflight.get(input.tenantDbName);
  if (pending) return pending;
  const hit = cacheGet(input.tenantDbName, input.tenantId);
  // refresh=1 is rate-limited per tenant: a snapshot younger than the minimum
  // interval is already "fresh enough".
  if (hit && (!refresh || Date.now() - hit.at < MIN_REFRESH_INTERVAL_MS)) return hit;
  const work = buildSnapshot(input)
    .then((snapshot) => {
      cacheSet(input.tenantDbName, snapshot);
      return snapshot;
    })
    .finally(() => {
      if (inflight.get(input.tenantDbName) === work) inflight.delete(input.tenantDbName);
    });
  inflight.set(input.tenantDbName, work);
  return work;
}

function toListItem(
  r: ResourceRecord,
  tenantId: string,
  directory: Directory,
  projectNames: Map<string, string>,
): ResourceListItem {
  return {
    crn: buildCrn({ tenantId, projectId: r.projectId, type: r.type, id: r.id }),
    type: r.type,
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    projectId: r.projectId,
    projectName: r.projectId ? projectNames.get(r.projectId) ?? null : null,
    status: r.status,
    statusTone: r.statusTone,
    createdBy: r.createdBy,
    createdByLabel: r.createdBy ? directory.userLabels.get(r.createdBy) ?? null : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function typeInfos() {
  return listResourceTypeDefinitions().map((d) => ({
    type: d.type,
    service: d.service,
    category: d.category,
    scope: d.scope,
    edition: d.edition,
  }));
}

function matchesQuery(r: ResourceRecord, needle: string): boolean {
  return (
    r.name.toLowerCase().includes(needle)
    || (r.key?.toLowerCase().includes(needle) ?? false)
    || (r.description?.toLowerCase().includes(needle) ?? false)
    || r.id.toLowerCase().includes(needle)
  );
}

export async function listResources(input: ListResourcesInput): Promise<ListResourcesResult> {
  ensureCommunityResourceTypesRegistered();
  if (input.type && !getResourceTypeDefinition(input.type)) {
    throw new ResourceQueryError(`Unknown resource type "${input.type}"`);
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(input.offset ?? 0) || 0, 0);

  const snapshot = await getSnapshot(input, input.refresh === true);

  const needle = input.q?.trim().toLowerCase() || '';
  const afterBase = snapshot.records.filter((r) => {
    if (input.projectId) {
      if (input.projectId === 'tenant') {
        if (r.projectId !== null) return false;
      } else if (r.projectId !== input.projectId && !r.projectIds?.includes(input.projectId)) {
        return false;
      }
    }
    return !needle || matchesQuery(r, needle);
  });

  // Status options reflect the selected type, but not the selected status.
  const statusSet = new Set<string>();
  for (const r of afterBase) {
    if (r.status && (!input.type || r.type === input.type)) statusSet.add(r.status);
  }

  const afterStatus = input.status ? afterBase.filter((r) => r.status === input.status) : afterBase;

  const counts: Record<string, number> = {};
  for (const def of listResourceTypeDefinitions()) counts[def.type] = 0;
  for (const r of afterStatus) counts[r.type] = (counts[r.type] ?? 0) + 1;

  const filtered = (input.type ? afterStatus.filter((r) => r.type === input.type) : afterStatus)
    .slice()
    .sort(compareRecords);

  const projectNames = new Map(snapshot.projects.map((p) => [p.id, p.name]));
  const page = filtered.slice(offset, offset + limit);

  return {
    items: page.map((r) => toListItem(r, input.tenantId, snapshot, projectNames)),
    total: filtered.length,
    counts,
    types: typeInfos(),
    projects: snapshot.projects,
    statuses: [...statusSet].sort(),
    errors: snapshot.errors,
    truncated: snapshot.truncated,
    generatedAt: snapshot.generatedAt,
  };
}

const detailInflight = new Map<string, Promise<{ found: ResourceRecord | null; directory: Directory | null }>>();

/** Concurrent identical detail loads share one provider read + one directory read. */
function loadSingle(
  def: ResourceTypeDefinition,
  input: GetResourceInput,
): Promise<{ found: ResourceRecord | null; directory: Directory | null }> {
  const key = `${input.tenantDbName}\u0000${input.type}\u0000${input.id}`;
  const pending = detailInflight.get(key);
  if (pending) return pending;
  const work = runWithTenantScope(input.tenantDbName, async (db) => {
    const ctx: ResourceProviderContext = { db, tenantId: input.tenantId, tenantDbName: input.tenantDbName };
    const found = await withTimeout(
      def.get ? def.get(ctx, input.id) : def.list(ctx).then((rows) => rows.find((r) => r.id === input.id) ?? null),
      PROVIDER_TIMEOUT_MS,
      `Resource type ${def.type}`,
    );
    // Unknown ids stop here: no users read for a 404.
    return { found, directory: found ? await loadDirectory(ctx) : null };
  }).finally(() => {
    if (detailInflight.get(key) === work) detailInflight.delete(key);
  });
  detailInflight.set(key, work);
  return work;
}

export async function getResource(input: GetResourceInput): Promise<ResourceDetail | null> {
  ensureCommunityResourceTypesRegistered();
  const def = getResourceTypeDefinition(input.type);
  if (!def) return null;

  const cached = cacheGet(input.tenantDbName, input.tenantId);
  let record: ResourceRecord | null = cached?.records.find((r) => r.type === input.type && r.id === input.id) ?? null;
  let directory: Directory | null = cached;

  if (!record) {
    // A cache miss for the id is not a 404: the snapshot can be up to 30s old and
    // is capped per type, so ask the provider for just this type (never a fan-out).
    const loaded = await loadSingle(def, input);
    record = loaded.found ? clipRecord(loaded.found) : null;
    directory = directory ?? loaded.directory;
  }

  if (!record || !directory) return null;
  if (record.tenantId && String(record.tenantId) !== input.tenantId) {
    logger.warn('Dropped resource claiming another tenant', { type: record.type, id: record.id });
    return null;
  }

  const projectNames = new Map(directory.projects.map((p) => [p.id, p.name]));
  const item = toListItem(record, input.tenantId, directory, projectNames);
  return {
    ...item,
    updatedBy: record.updatedBy,
    updatedByLabel: record.updatedBy ? directory.userLabels.get(record.updatedBy) ?? null : null,
    attributes: record.attributes,
    detailUrl: def.detailUrl?.(record) ?? null,
  };
}
