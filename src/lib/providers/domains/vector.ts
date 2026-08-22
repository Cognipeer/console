import type { VectorFilterNode, VectorFilterOperator } from './vectorFilter';
import type { VectorHybridOptions } from './vectorHybrid';

export * from './vectorFilter';
export * from './vectorHybrid';

export interface VectorIndexHandle {
  externalId: string;
  name: string;
  dimension: number;
  metric: 'cosine' | 'dot' | 'euclidean';
  metadata?: Record<string, unknown>;
}

export interface CreateVectorIndexInput {
  name: string;
  dimension: number;
  metric?: 'cosine' | 'dot' | 'euclidean';
  metadata?: Record<string, unknown>;
}

export interface VectorDeleteIndexInput {
  externalId: string;
}

export type VectorListIndexesItem = VectorIndexHandle;

export interface VectorUpsertItem {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorQueryInput {
  topK: number;
  vector: number[];
  /**
   * Parsed, validated metadata filter. Providers must push this down to the
   * store; the service layer never applies it afterwards, so a provider that
   * cannot honour an operator declares that in `vector.filterOperators` and
   * the request is rejected before it reaches the runtime.
   */
  filter?: VectorFilterNode;
  /**
   * Raw query text for the keyword channel of a hybrid search. Optional and
   * off by default: a driver that does not declare `vector.supportsHybrid`
   * never receives it, because the service strips it rather than let an
   * adapter ignore a field the caller believes is in force.
   */
  text?: string;
  /** Fusion settings for the keyword channel. Ignored without `text`. */
  hybrid?: VectorHybridOptions;
}

/**
 * Filter operators a vector driver can push down, declared as the
 * `vector.filterOperators` capability. An empty list means the driver cannot
 * filter at all. `vector.filterRaw` marks drivers that also accept a
 * provider-native `$raw` filter.
 */
export type VectorFilterCapability = VectorFilterOperator[];

export interface VectorQueryMatch {
  id: string;
  /**
   * Relevance in 0..1, higher is better, for every driver and every mode.
   * A fused score is rescaled onto this range before it leaves the adapter —
   * see the score-scale contract in `vectorHybrid.ts`, which is the reason
   * `minScore` thresholds keep working when hybrid is switched on.
   */
  score: number;
  /** Similarity from the vector channel alone, when the fusion knows it. */
  denseScore?: number;
  /** Raw keyword-channel score (BM25 or the store's equivalent), unscaled. */
  lexicalScore?: number;
  metadata?: Record<string, unknown>;
}

export interface VectorQueryResult {
  matches: VectorQueryMatch[];
  /**
   * Free-form per-query notes. A driver given `query.text` must report what it
   * actually ran under the keys `describeHybrid` produces — `hybrid`,
   * `hybridMode`, `hybridUnavailable` — so a dense-only fallback is never
   * mistaken for a fused search.
   */
  usage?: Record<string, unknown>;
}

export interface VectorListItem {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorListInput {
  /** Page cursor returned from a previous call; omit for first page. */
  cursor?: string;
  /** Maximum items to return per page. Default: 100. */
  limit?: number;
}

export interface VectorListResult {
  items: VectorListItem[];
  /** Present when more pages exist; pass as `cursor` on the next call. */
  nextCursor?: string;
  total?: number;
}

export interface VectorProviderRuntime {
  createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle>;
  deleteIndex(input: VectorDeleteIndexInput): Promise<void>;
  listIndexes(): Promise<VectorListIndexesItem[]>;
  upsertVectors(
    handle: VectorIndexHandle,
    items: VectorUpsertItem[],
  ): Promise<void>;
  /**
   * Search the index. `query.text` only ever arrives on a driver that declares
   * `'vector.supportsHybrid': true`; such a driver runs the keyword channel and
   * reports the outcome in `usage`, degrading to dense-only when the index
   * itself cannot serve one.
   */
  queryVectors(
    handle: VectorIndexHandle,
    query: VectorQueryInput,
  ): Promise<VectorQueryResult>;
  deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void>;
  /**
   * Paginate through all vectors stored in an index.
   * Providers that cannot support this operation should throw an Error with
   * message containing "not supported".
   */
  listVectors(
    handle: VectorIndexHandle,
    input?: VectorListInput,
  ): Promise<VectorListResult>;
  /**
   * Release any connections this runtime owns.
   *
   * Called by the runtime pool once an evicted runtime's grace period has
   * elapsed. Implement it on any driver that holds a pool or a keep-alive
   * client; stateless drivers can leave it out.
   */
  close?(): Promise<void> | void;
}
