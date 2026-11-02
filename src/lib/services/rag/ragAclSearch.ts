/**
 * The vector search of a knowledge base with access control, for a caller the
 * checks apply to (see access/vectorPlan.ts for how the search is planned).
 *
 * Whatever the plan, every candidate is checked against the database before
 * anything reads its text, and again after:
 *
 *  1. its document id comes from the vector (`_documentId`, else the id
 *     `<module>:<document>:<chunk>`); a vector naming no document is dropped;
 *  2. the documents are read (one batched read, no source text) and only the
 *     ones the scope may read survive;
 *  3. the survivors' chunks are read and must name the same document: a vector
 *     whose metadata points at a readable document while its stored chunk
 *     belongs to another is dropped, and so is a vector with no stored chunk.
 *
 * Only then do the reranker, the score threshold and the logs see anything,
 * so none of them is computed over passages the caller may not read.
 */

import type { DatabaseProvider, IRagChunk, IRagDocument } from '@/lib/database';
import type { VectorFilterOperator, VectorQueryMatch } from '@/lib/providers';
import type { RagAccessScope } from './access/scope';
import {
  ACL_RETRY_FACTOR,
  aclPostFetchMax,
  aclVectorFilter,
  aclWidening,
  isAclFilterRefusal,
  isRawFilterConflict,
  planRagAclQuery,
  ragDocumentProjectScope,
  type RagAclQueryMode,
  type RagAclQueryPlan,
} from './access/vectorPlan';

type AclSearchDb = Pick<
  DatabaseProvider,
  'countRagDocuments' | 'listRagDocumentIds' | 'findRagDocumentsByIds' | 'findRagChunksByVectorIds'
>;

export interface RagAclSearchInput {
  db: AclSearchDb;
  scope: RagAccessScope;
  moduleKey: string;
  /** The module's project; documents of another project never come through. */
  moduleProjectId?: string;
  driver?: string;
  operators: readonly VectorFilterOperator[];
  /** The store refused a pushed-down id list recently. */
  pushdownBroken: boolean;
  /** Candidates a search without access control would ask for. */
  fetchTopK: number;
  /** Results the caller wants; a post-filtered search retries once when fewer survive. */
  topK: number;
  hybrid: boolean;
  /**
   * Runs the store query; `aclFilter` is ANDed with the module's own filter by the caller.
   * The store's `usage` notes come back with the matches: a pushed-down list the store applied
   * itself over a short window is reported there.
   */
  search: (
    fetchTopK: number,
    aclFilter?: Record<string, unknown>,
  ) => Promise<{ matches: VectorQueryMatch[]; usage?: Record<string, unknown> }>;
  /**
   * The store refused a pushed-down list: remember it and post-filter instead. Called only for a
   * refusal of the filter (see isAclFilterRefusal), and only once the search without the list has
   * worked, so a filter of the caller's own that fails either way never gets the store blamed.
   */
  onPushdownRefused?: (error: unknown) => void;
  signal?: AbortSignal;
}

export interface RagAclSearchStats {
  mode: RagAclQueryMode;
  /** Readable / all documents of the module, as planned. */
  allowed: number;
  total: number;
  /** Candidates the store returned and the checks removed. */
  dropped: number;
  retried: boolean;
  /** The pushed-down list was refused, or applied in memory over too short a window, and the search fell back to post-filtering. */
  fellBack?: boolean;
}

export interface RagAclSearchResult {
  matches: VectorQueryMatch[];
  /** The survivors' chunks, by vector id (already read: the caller does not hydrate again). */
  chunks: Map<string, IRagChunk>;
  stats: RagAclSearchStats;
}

/** The document a vector belongs to, as the vector says (verified against its chunk later). */
export function vectorDocumentId(match: Pick<VectorQueryMatch, 'id' | 'metadata'>, moduleKey: string): string | undefined {
  const fromMetadata = match.metadata?._documentId;
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;
  const prefix = `${moduleKey}:`;
  if (typeof match.id === 'string' && match.id.startsWith(prefix)) {
    const rest = match.id.slice(prefix.length);
    const cut = rest.lastIndexOf(':');
    if (cut > 0 && /^\d+$/.test(rest.slice(cut + 1))) return rest.slice(0, cut);
  }
  return undefined;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

/** What a store reports in `usage.filterPushdown` when it applied the filter itself, over a short window of its nearest hits (an Azure index without filterable metadata). */
const FILTER_APPLIED_IN_MEMORY = 'in-memory';

/** The plan a refused, or too thin, pushed-down list falls back to. */
function postPlanOf(plan: RagAclQueryPlan): Extract<RagAclQueryPlan, { mode: 'post' }> {
  return { mode: 'post', allowed: plan.allowed, total: plan.total, widen: aclWidening(plan.total, plan.allowed) };
}

async function keepReadable(
  input: RagAclSearchInput,
  matches: VectorQueryMatch[],
): Promise<{ kept: VectorQueryMatch[]; chunks: Map<string, IRagChunk>; dropped: number }> {
  const docIdOf = new Map<VectorQueryMatch, string>();
  for (const match of matches) {
    const id = vectorDocumentId(match, input.moduleKey);
    if (id) docIdOf.set(match, id);
  }
  const ids = [...new Set(docIdOf.values())];
  const docs: IRagDocument[] = ids.length > 0 ? await input.db.findRagDocumentsByIds(ids) : [];
  const readable = new Set<string>();
  for (const doc of docs) {
    if (!doc?._id || doc.ragModuleKey !== input.moduleKey) continue;
    // A module with a project owns its project's rows and the ones written before rows carried one.
    if (input.moduleProjectId && doc.projectId && String(doc.projectId) !== input.moduleProjectId) continue;
    if (input.scope.canReadDocument(doc)) readable.add(String(doc._id));
  }
  const candidates = matches.filter((m) => {
    const id = docIdOf.get(m);
    return id !== undefined && readable.has(id);
  });

  // Read the text only of what may be shown; a failure here is a failure of the search, not an empty answer.
  const chunks = new Map<string, IRagChunk>();
  if (candidates.length > 0) {
    const stored = await input.db.findRagChunksByVectorIds(candidates.map((m) => m.id));
    for (const chunk of stored) chunks.set(chunk.vectorId, chunk);
  }
  const kept = candidates.filter((m) => {
    const chunk = chunks.get(m.id);
    return Boolean(chunk)
      && chunk!.ragModuleKey === input.moduleKey
      && String(chunk!.documentId) === docIdOf.get(m);
  });
  const keptIds = new Set(kept.map((m) => m.id));
  for (const key of [...chunks.keys()]) {
    if (!keptIds.has(key)) chunks.delete(key);
  }
  return { kept, chunks, dropped: matches.length - kept.length };
}

export async function runRagAclSearch(input: RagAclSearchInput): Promise<RagAclSearchResult> {
  const filter = input.scope.documentFilter();
  let plan: RagAclQueryPlan = filter
    ? await planRagAclQuery(input.db, {
      moduleKey: input.moduleKey,
      projectScope: ragDocumentProjectScope({ projectId: input.moduleProjectId }),
      filter,
      operators: input.operators,
      driver: input.driver,
      pushdownBroken: input.pushdownBroken,
    })
    : { mode: 'all', allowed: 0, total: 0 };

  if (plan.mode === 'none') {
    return { matches: [], chunks: new Map(), stats: { mode: 'none', allowed: 0, total: plan.total, dropped: 0, retried: false } };
  }

  let fellBack = false;
  let raw: VectorQueryMatch[];
  let requested = input.fetchTopK;
  // No search asks for more candidates than the store takes: a widened or retried request is cut to this.
  const cap = Math.max(input.fetchTopK, aclPostFetchMax(input.driver, input.hybrid));
  const widened = (post: { widen: number }) => Math.min(cap, input.fetchTopK * post.widen);
  let listInMemory = false;

  if (plan.mode === 'in' || plan.mode === 'nin') {
    try {
      const pushed = await input.search(input.fetchTopK, aclVectorFilter(plan));
      raw = pushed.matches;
      listInMemory = pushed.usage?.filterPushdown === FILTER_APPLIED_IN_MEMORY;
    } catch (error) {
      // Only a refused filter earns a second search, without the list. A timeout, a rate limit or an
      // open circuit is the store's state, not the list's: it fails the query, as it would without
      // access control, and the store is not marked.
      if (isAbort(error, input.signal) || !isAclFilterRefusal(error)) throw error;
      plan = postPlanOf(plan);
      requested = widened(plan);
      raw = (await input.search(requested)).matches;
      fellBack = true;
      // The list is blamed only now that the search without it has worked. A filter of the caller's
      // own is refused again (and its error is the one to report); a module `$raw` filter cannot be
      // combined with a list whatever the store does.
      if (!isRawFilterConflict(error)) input.onPushdownRefused?.(error);
    }
  } else if (plan.mode === 'post') {
    requested = widened(plan);
    raw = (await input.search(requested)).matches;
  } else {
    raw = (await input.search(input.fetchTopK)).matches;
  }

  let { kept, chunks, dropped } = await keepReadable(input, raw);

  // The store applied the list itself, in memory, over a short window of its nearest hits, and too
  // few came out: readable documents further down were never looked at. Search again as a
  // post-filtered search, which sizes its own window. (Enough survivors need no second search: they
  // are the nearest readable ones whatever lies beyond the window.)
  if (listInMemory && kept.length < input.topK) {
    plan = postPlanOf(plan);
    requested = widened(plan);
    raw = (await input.search(requested)).matches;
    fellBack = true;
    ({ kept, chunks, dropped } = await keepReadable(input, raw));
  }

  let retried = false;

  // Too few survived and the store had more to give: ask once more, wider.
  if (plan.mode === 'post' && kept.length < input.topK && raw.length >= requested && requested < cap) {
    retried = true;
    const wider = Math.min(cap, requested * ACL_RETRY_FACTOR);
    const again = (await input.search(wider)).matches;
    ({ kept, chunks, dropped } = await keepReadable(input, again));
  }

  // A post-filtered search never hands on more candidates than an unfiltered one would.
  if (kept.length > input.fetchTopK) {
    const cut = kept.slice(input.fetchTopK);
    kept = kept.slice(0, input.fetchTopK);
    for (const m of cut) chunks.delete(m.id);
  }

  return {
    matches: kept,
    chunks,
    stats: {
      mode: plan.mode,
      allowed: plan.allowed,
      total: plan.total,
      dropped,
      retried,
      ...(fellBack ? { fellBack } : {}),
    },
  };
}
