/**
 * Shared Elasticsearch vector plumbing.
 *
 * Elasticsearch reaches the registry through three near-identical contracts
 * (generic, Cloud, self-hosted) that differ only in how they build a client.
 * Everything below the client — the mapping, the document shape and the query
 * itself — lives here so a fix cannot land on one of them and silently leave
 * the other two behind.
 */

import type { VectorQueryInput, VectorQueryResult, VectorUpsertItem } from '../domains/vector';
import {
  describeHybrid,
  extractVectorText,
  fuseHybridMatches,
  hybridCandidateCount,
  resolveHybridOptions,
  type VectorHybridChannelHit,
} from '../domains/vectorHybrid';
import { toElasticsearchFilter } from './vectorFilterTranslators';

export interface EsSearchHit {
  _id: string;
  _score?: number;
  _source?: Record<string, unknown>;
  sort?: unknown[];
}

export interface EsSearchResponse {
  hits: { hits: EsSearchHit[] };
}

export type EsSearchFn = (params: Record<string, unknown>) => Promise<EsSearchResponse>;

/** Field holding the searchable text of a chunk, for the keyword channel. */
const CONTENT_FIELD = 'content';

/**
 * Only `metadata` is ever read back. Without this the response also carries the
 * full embedding and the chunk text of every hit, which on a 1536-dimension
 * index is orders of magnitude more bytes than the answer itself.
 */
const SOURCE_FIELDS = ['metadata'];

export function esVectorMapping(dimension: number, metric: string): Record<string, unknown> {
  const similarity = metric === 'dot' ? 'dot_product' : metric === 'euclidean' ? 'l2_norm' : 'cosine';
  return {
    properties: {
      vector: { type: 'dense_vector', dims: dimension, index: true, similarity },
      metadata: { type: 'object', dynamic: true },
      [CONTENT_FIELD]: { type: 'text' },
    },
  };
}

export function esVectorDocument(item: VectorUpsertItem): Record<string, unknown> {
  return {
    vector: item.values,
    metadata: item.metadata ?? {},
    [CONTENT_FIELD]: extractVectorText(item.metadata) ?? '',
  };
}

function toChannelHit(hit: EsSearchHit): VectorHybridChannelHit {
  return {
    id: hit._id,
    score: hit._score ?? 0,
    metadata: hit._source?.metadata as Record<string, unknown> | undefined,
  };
}

/**
 * Run one vector query, fusing in a keyword channel when the caller supplied
 * text.
 *
 * The two channels are two searches fused here rather than one `retriever.rrf`
 * call: RRF retrievers need a recent Elasticsearch, and running the channels
 * separately is what makes the true similarity available as `denseScore` and
 * keeps every driver fusing through the same tested implementation.
 *
 * A `match` against a field an older index never mapped simply returns nothing,
 * so an index created before hybrid existed degrades to its dense ranking
 * instead of failing — and self-heals on the next upsert, since the default
 * dynamic mapping maps `content` as text the first time one is written.
 */
export async function esQueryVectors(
  search: EsSearchFn,
  index: string,
  query: VectorQueryInput,
): Promise<VectorQueryResult> {
  const text = query.text?.trim();
  const size = text ? hybridCandidateCount(query.topK) : query.topK;
  const filter = query.filter ? toElasticsearchFilter(query.filter) : undefined;

  const dense = await search({
    index,
    knn: {
      field: 'vector',
      query_vector: query.vector,
      k: size,
      num_candidates: size * 2,
      filter,
    },
    size,
    _source: SOURCE_FIELDS,
  });

  if (!text) {
    return { matches: dense.hits.hits.map(toChannelHit) };
  }

  const lexical = await search({
    index,
    query: {
      bool: {
        must: [{ match: { [CONTENT_FIELD]: text } }],
        ...(filter ? { filter: [filter] } : {}),
      },
    },
    size,
    _source: SOURCE_FIELDS,
  });

  return {
    matches: fuseHybridMatches({
      dense: dense.hits.hits.map(toChannelHit),
      lexical: lexical.hits.hits.map(toChannelHit),
      topK: query.topK,
      options: query.hybrid,
    }),
    usage: describeHybrid({ ran: true, mode: resolveHybridOptions(query.hybrid).mode }),
  };
}
