import type { VectorFilterNode, VectorFilterOperator } from './vectorFilter';

export * from './vectorFilter';

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
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorQueryResult {
  matches: VectorQueryMatch[];
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
}
