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
 *  - only MAPPED records are cached, never raw documents;
 *  - the reference graph (uses / used by / health) is built ONCE per snapshot and
 *    cached with it; the internal `edges` of a record are dropped right after.
 */
import { runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { buildCrn } from './crn';
import { EMPTY_GRAPH, buildResourceGraph, type ResourceGraph } from './graph';
import { HEALTH_ISSUE_KINDS } from './health';
import { getResourceTypeDefinition, listResourceTypeDefinitions } from './registry';
import { ensureCommunityResourceTypesRegistered } from './providers';
import type {
  GetResourceHealthInput,
  GetResourceInput,
  HealthIssue,
  ListResourcesInput,
  ListResourcesResult,
  ResourceDetail,
  ResourceEdgeInput,
  ResourceHealthResult,
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
  /** Mapped records WITHOUT their internal `edges` (those live in `graph`). */
  records: ResourceRecord[];
  graph: ResourceGraph;
  /** The reference analysis threw: issues/uses/usedBy are empty because nothing was checked. */
  graphFailed: boolean;
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

function stripEdges(r: ResourceRecord): ResourceRecord {
  if (!r.edges) return r;
  const { edges: _edges, ...rest } = r;
  return rest;
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
    // Strip first and hand the edges over separately, so the cached snapshot (and
    // everything the graph keeps pointing at) only ever holds edge-free records.
    const edgesOf = new Map<ResourceRecord, readonly ResourceEdgeInput[]>();
    const stripped = records.map((r) => {
      const clean = stripEdges(r);
      if (r.edges?.length) edgesOf.set(clean, r.edges);
      return clean;
    });
    let graph = EMPTY_GRAPH;
    let graphFailed = false;
    try {
      graph = buildResourceGraph({
        tenantId: input.tenantId,
        records: stripped,
        edgesOf,
        projects: directory.projects,
        incompleteTypes: new Set([...errors.map((e) => e.type), ...truncated.map((t) => t.type)]),
      });
    } catch (error) {
      // A bug in the graph must not take the whole inventory down with it.
      logger.error('Resource reference graph failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Not a clean bill of health: surface it so "no issues" cannot mean "not checked".
      graphFailed = true;
      errors.push({ type: 'references', message: 'Failed to analyse resource references' });
    }
    const now = Date.now();
    return {
      tenantId: input.tenantId,
      // Edges are INTERNAL: they were consumed by the graph above and are never cached or served.
      records: stripped,
      graph,
      graphFailed,
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
  graph: ResourceGraph,
): ResourceListItem {
  const health = graph.issueSummaryOf(r.type, r.id);
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
    issueCount: health.count,
    issueSeverity: health.severity,
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
  if (input.health !== undefined && input.health !== 'issues') {
    throw new ResourceQueryError('health must be "issues"');
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
    if (input.health === 'issues' && snapshot.graph.issueSummaryOf(r.type, r.id).count === 0) return false;
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
    items: page.map((r) => toListItem(r, input.tenantId, snapshot, projectNames, snapshot.graph)),
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

export async function getResource(input: GetResourceInput): Promise<ResourceDetail | null> {
  ensureCommunityResourceTypesRegistered();
  const def = getResourceTypeDefinition(input.type);
  if (!def) return null;

  // The detail carries the reference graph, which only exists for the whole
  // tenant: serve it from the snapshot, never from a per-type read.
  const find = (snap: Snapshot) => snap.records.find((r) => r.type === input.type && r.id === input.id) ?? null;
  let snapshot = await getSnapshot(input, false);
  let record = find(snapshot);
  if (!record) {
    // The snapshot can be up to 30s old: a just-created id gets ONE forced
    // rebuild (still rate-limited by MIN_REFRESH_INTERVAL_MS and de-duplicated
    // with a build already running), then it is a 404.
    const fresh = await getSnapshot(input, true);
    if (fresh !== snapshot) {
      snapshot = fresh;
      record = find(fresh);
    }
  }

  if (!record) return null;
  if (record.tenantId && String(record.tenantId) !== input.tenantId) {
    logger.warn('Dropped resource claiming another tenant', { type: record.type, id: record.id });
    return null;
  }

  const projectNames = new Map(snapshot.projects.map((p) => [p.id, p.name]));
  const item = toListItem(record, input.tenantId, snapshot, projectNames, snapshot.graph);
  const usedBy = snapshot.graph.usedByOf(record.type, record.id);
  return {
    ...item,
    updatedBy: record.updatedBy,
    updatedByLabel: record.updatedBy ? snapshot.userLabels.get(record.updatedBy) ?? null : null,
    attributes: record.attributes,
    detailUrl: def.detailUrl?.(record) ?? null,
    uses: snapshot.graph.usesOf(record.type, record.id),
    usedBy: usedBy.edges,
    usedByTruncated: usedBy.truncated,
    issues: snapshot.graph.issuesOf(record.type, record.id),
  };
}

export const MAX_HEALTH_ISSUES = 1000;

/** Tenant-wide health: every issue of the snapshot, filtered and capped. */
export async function getResourceHealth(input: GetResourceHealthInput): Promise<ResourceHealthResult> {
  ensureCommunityResourceTypesRegistered();
  if (input.type && !getResourceTypeDefinition(input.type)) {
    throw new ResourceQueryError(`Unknown resource type "${input.type}"`);
  }
  if (input.severity && input.severity !== 'error' && input.severity !== 'warning') {
    throw new ResourceQueryError('severity must be "error" or "warning"');
  }
  if (input.kind && !HEALTH_ISSUE_KINDS.includes(input.kind)) {
    throw new ResourceQueryError(`Unknown health issue kind "${input.kind}"`);
  }
  const snapshot = await getSnapshot(input, input.refresh === true);

  // Scope filters first (the summary describes this scope), then severity/kind
  // narrow the list only, so the UI's kind/severity facets do not collapse.
  const inScope: HealthIssue[] = snapshot.graph.issues.filter((issue) => {
    if (input.type && issue.resource.type !== input.type) return false;
    if (input.projectId) {
      return input.projectId === 'tenant'
        ? issue.resource.projectId === null
        : issue.resource.projectId === input.projectId;
    }
    return true;
  });
  const summary = { error: 0, warning: 0, byKind: {} as Record<string, number> };
  for (const issue of inScope) {
    summary[issue.severity] += 1;
    summary.byKind[issue.kind] = (summary.byKind[issue.kind] ?? 0) + 1;
  }
  const filtered = inScope.filter(
    (issue) => (!input.severity || issue.severity === input.severity) && (!input.kind || issue.kind === input.kind),
  );
  return {
    summary,
    issues: filtered.slice(0, MAX_HEALTH_ISSUES),
    truncated: filtered.length > MAX_HEALTH_ISSUES,
    ...(snapshot.graphFailed ? { graphUnavailable: true } : {}),
    generatedAt: snapshot.generatedAt,
  };
}
