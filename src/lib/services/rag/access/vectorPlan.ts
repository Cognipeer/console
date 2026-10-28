/**
 * How a knowledge-base query keeps unreadable documents out of the vector search.
 *
 * Permissions live in the database, never in vector metadata: changing who may
 * read a folder must not re-embed or re-write a single vector. So the query is
 * planned from two counts, the documents the caller may read (A) and all the
 * module's documents (T):
 *
 *   A = 0          nothing to search: an empty result, no vector call.
 *   A = T          everything is readable: the query runs unfiltered.
 *   A small        `_documentId $in [readable ids]` is pushed to the store.
 *   T - A small    `_documentId $nin [unreadable ids]` is pushed to the store.
 *   otherwise      the store is asked for more candidates and the unreadable
 *                  ones are dropped afterwards (one wider retry when too few
 *                  survive and the store had more to give).
 *
 * Every mode is followed by the same check of each match against the database
 * (ragService), so a vector without a document id, or one whose metadata names
 * another document than its stored chunk, never comes through.
 */

import { errorStatusCodes } from '@/lib/core/resilience';
import type { DatabaseProvider, RagDocumentAccessFilter } from '@/lib/database';
import { VectorFilterError, type VectorFilterOperator } from '@/lib/providers/domains/vectorFilter';

/** Ids pushed to a store in one `$in` / `$nin`, by default. */
export const ACL_ID_LIST_MAX = 1000;
/** Stores whose filter grows one clause per id, or that cap filter size, take shorter lists. */
const ACL_ID_LIST_MAX_BY_DRIVER: Record<string, number> = {
  'azure-ai-search': 200,
  'aws-s3-vectors': 200,
  'system-default': 200,
};

/** Candidates one post-filtered search may ask for. */
export const ACL_POST_FETCH_MAX = 1000;
/**
 * Stores whose own query code puts a ceiling on one search. Every widened or
 * retried search is cut to it (runRagAclSearch), so an entry here is what keeps
 * a wider request from being refused. Only a ceiling the driver's contract
 * code fixes belongs here: Atlas sends numCandidates = limit x 10, capped at
 * 10000, and a hybrid search asks for 2 x limit. aws-s3-vectors and
 * system-default hand `topK` straight to QueryVectors, whose response holds at
 * most 100 results (S3 Vectors limits: "Results per page in a QueryVectors
 * response: Up to 100"), and the client this build uses cannot ask for a next
 * page.
 */
const ACL_POST_FETCH_MAX_BY_DRIVER: Record<string, { plain: number; hybrid: number }> = {
  mongodb: { plain: 1000, hybrid: 500 },
  'aws-s3-vectors': { plain: 100, hybrid: 100 },
  'system-default': { plain: 100, hybrid: 100 },
};

export const ACL_RETRY_FACTOR = 4;

export type RagAclQueryPlan =
  | { mode: 'none'; allowed: 0; total: number }
  | { mode: 'all'; allowed: number; total: number }
  | { mode: 'in'; allowed: number; total: number; ids: string[] }
  | { mode: 'nin'; allowed: number; total: number; ids: string[] }
  | { mode: 'post'; allowed: number; total: number; widen: number };

export type RagAclQueryMode = RagAclQueryPlan['mode'];

export function aclIdListMax(driver: string | undefined): number {
  return (driver && ACL_ID_LIST_MAX_BY_DRIVER[driver]) || ACL_ID_LIST_MAX;
}

export function aclPostFetchMax(driver: string | undefined, hybrid: boolean): number {
  const caps = driver ? ACL_POST_FETCH_MAX_BY_DRIVER[driver] : undefined;
  if (!caps) return ACL_POST_FETCH_MAX;
  return hybrid ? caps.hybrid : caps.plain;
}

/** How many times more candidates a post-filtered search asks for: about twice the unreadable share, 2..20. */
export function aclWidening(total: number, allowed: number): number {
  if (allowed <= 0) return 20;
  return Math.min(20, Math.max(2, Math.ceil(total / allowed) * 2));
}

/** The vector filter that pushes an `in` / `nin` plan to the store. */
export function aclVectorFilter(plan: RagAclQueryPlan): Record<string, unknown> | undefined {
  if (plan.mode === 'in') return { _documentId: { $in: plan.ids } };
  if (plan.mode === 'nin') return { _documentId: { $nin: plan.ids } };
  return undefined;
}

type PlanDb = Pick<DatabaseProvider, 'countRagDocuments' | 'listRagDocumentIds'>;

/** Widening when the documents cannot be counted (a module without a project). */
const UNCOUNTED_WIDENING = 4;

/**
 * The documents a module owns, as one database selection: its project's rows
 * plus the ones written before documents carried a project. A module without a
 * project has documents in any project, which one selection cannot count:
 * null, and the search is post-filtered.
 */
export function ragDocumentProjectScope(module: { projectId?: string }): { projectId: string } | null {
  return module.projectId ? { projectId: module.projectId } : null;
}

export interface PlanRagAclQueryInput {
  moduleKey: string;
  /** See ragDocumentProjectScope. */
  projectScope: { projectId: string } | null;
  filter: RagDocumentAccessFilter;
  /** What the store can push down; drivers without `$in` / `$nin` always post-filter. */
  operators: readonly VectorFilterOperator[];
  driver?: string;
  /** Pushing a list was refused by this store recently: post-filter right away. */
  pushdownBroken?: boolean;
}

function countIn(db: PlanDb, moduleKey: string, projectId: string, filter?: RagDocumentAccessFilter): Promise<number> {
  return db.countRagDocuments(moduleKey, projectId, { withUnscoped: true, ...(filter ? { access: filter } : {}) });
}

function idsIn(db: PlanDb, moduleKey: string, projectId: string, filter: RagDocumentAccessFilter, limit: number): Promise<string[]> {
  return db.listRagDocumentIds(moduleKey, { projectId, withUnscoped: true, access: filter, limit: limit + 1 });
}

export async function planRagAclQuery(db: PlanDb, input: PlanRagAclQueryInput): Promise<RagAclQueryPlan> {
  // Without a countable selection there is nothing to plan from: post-filter (the per-match check decides).
  if (!input.projectScope) return { mode: 'post', allowed: 0, total: 0, widen: UNCOUNTED_WIDENING };
  const { projectId } = input.projectScope;
  const [allowed, total] = await Promise.all([
    countIn(db, input.moduleKey, projectId, input.filter),
    countIn(db, input.moduleKey, projectId),
  ]);
  if (allowed <= 0) return { mode: 'none', allowed: 0, total };
  if (allowed >= total) return { mode: 'all', allowed, total };

  const listMax = aclIdListMax(input.driver);
  if (!input.pushdownBroken) {
    if (input.operators.includes('$in') && allowed <= listMax) {
      const ids = await idsIn(db, input.moduleKey, projectId, input.filter, listMax);
      // The counts and the list are separate reads; a list that grew past the cap falls through.
      if (ids.length === 0) return { mode: 'none', allowed: 0, total };
      if (ids.length <= listMax) return { mode: 'in', allowed, total, ids };
    }
    const denied = total - allowed;
    if (input.operators.includes('$nin') && denied <= listMax) {
      const ids = await idsIn(db, input.moduleKey, projectId, { ...input.filter, negate: true }, listMax);
      if (ids.length === 0) return { mode: 'all', allowed, total };
      if (ids.length <= listMax) return { mode: 'nin', allowed, total, ids };
    }
  }
  return { mode: 'post', allowed, total, widen: aclWidening(total, allowed) };
}

// ── stores that refused a pushed-down list ──────────────────────────────

/** Statuses an HTTP store answers with when it rejects the request itself: invalid (400, 422) or too large (413). */
const REFUSED_REQUEST_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * Whether a failed search says that the filter it carried was refused, as
 * opposed to the store being unwell (a timeout, a rate limit, an open circuit,
 * a dropped connection) or the call being cancelled. Only a refusal is worth a
 * second search without the pushed-down list, and only a refusal can show that
 * the store does not take the list. How the stores report one:
 *  - the filter layer and the drivers throw a VectorFilterError (an operator the
 *    store lacks, an index without filterable metadata, a `$raw` that cannot be
 *    combined);
 *  - a store that answers over HTTP rejects the request with 400, 413 or 422
 *    (S3 Vectors raises a ValidationException);
 *  - Atlas answers a filter on a path its index does not declare with a plain
 *    server error ("needs to be indexed") and no status;
 *  - elasticsearch-cloud turns the client's error into a plain one that keeps
 *    the status only in its message ("Elasticsearch error (HTTP 400): …").
 */
export function isAclFilterRefusal(error: unknown): boolean {
  if (error instanceof VectorFilterError) return true;
  if (!error || typeof error !== 'object') return false;
  if (errorStatusCodes(error).some((status) => REFUSED_REQUEST_STATUSES.has(status))) return true;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (typeof message !== 'string') return false;
  if (name === 'MongoServerError' && /needs to be indexed/i.test(message)) return true;
  const wrapped = /^Elasticsearch (?:error \(HTTP (\d{3})\)|HTTP (\d{3})):/.exec(message);
  return Boolean(wrapped && REFUSED_REQUEST_STATUSES.has(Number(wrapped[1] ?? wrapped[2])));
}

/**
 * A VectorFilterError about `$raw`: the module's own provider-native filter
 * replaces the whole filter, so an id list cannot be combined with it. That is
 * how the request was put together, not something the store refused, and it
 * says nothing about whether the store takes lists.
 */
export function isRawFilterConflict(error: unknown): boolean {
  return error instanceof VectorFilterError && error.message.includes('"$raw"');
}

const PUSHDOWN_BROKEN_TTL_MS = 10 * 60_000;
const pushdownBroken = new Map<string, number>();

/**
 * Remember that a store refused an `_documentId` list (an Atlas index that does
 * not declare the path, a filter too long for the service), so the next
 * queries go straight to post-filtering instead of failing first.
 */
export function markAclPushdownBroken(tenantDbName: string, providerKey: string): void {
  pushdownBroken.set(`${tenantDbName}\u0000${providerKey}`, Date.now() + PUSHDOWN_BROKEN_TTL_MS);
  if (pushdownBroken.size > 1000) {
    const now = Date.now();
    for (const [key, until] of pushdownBroken) if (until <= now) pushdownBroken.delete(key);
  }
}

export function isAclPushdownBroken(tenantDbName: string, providerKey: string): boolean {
  const key = `${tenantDbName}\u0000${providerKey}`;
  const until = pushdownBroken.get(key);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    pushdownBroken.delete(key);
    return false;
  }
  return true;
}
