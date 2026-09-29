/** Shared web-search service types. */

export interface WebSearchInput {
  query: string;
  /** Max results to return (provider-side cap applies). Default 10, max 50. */
  count?: number;
  /** Result offset / paging hint where the provider supports it. */
  offset?: number;
  /** ISO language override (falls back to provider settings). */
  language?: string;
  /** Country/market override (falls back to provider settings). */
  country?: string;
  /** Safe-search override (falls back to provider settings). */
  safeSearch?: 'off' | 'moderate' | 'strict';
  /**
   * Interpret the results with the instance's configured AI model and return
   * a synthesized `answer`. Best-effort: when AI answers are not enabled on the
   * instance (or the model call fails) the search still returns its results
   * and `warnings` explains why there is no AI answer.
   */
  includeAnswer?: boolean;
}

/** Per-instance AI answer settings (stored under provider settings.aiAnswer). */
export interface WebSearchAiAnswerSettings {
  enabled?: boolean;
  /** Model key (LLM) used to interpret the search results. */
  modelKey?: string;
  /** Optional extra instructions prepended to the interpretation prompt. */
  instructions?: string;
}

/** Per-instance semantic cache settings (stored under provider settings.cache). */
export interface WebSearchCacheSettings {
  enabled: boolean;
  /** Vector provider key holding the cache index. */
  vectorProviderKey?: string;
  /** Vector index key (within the provider) that stores cache entries. */
  vectorIndexKey?: string;
  /** Embedding model key used to embed queries. */
  embeddingModelKey?: string;
  /** Minimum similarity (0..1, inclusive) for a cached query to be reused. Default 0.8. */
  similarityThreshold?: number;
}

/** How the semantic cache took part in one search (present only when the cache is enabled). */
export interface WebSearchCacheInfo {
  /** `error` = the cache could not be consulted; the search ran uncached. */
  status: 'hit' | 'miss' | 'error';
  /** Similarity of the cached query that was reused (hits only). */
  similarity?: number;
  /** Whether a miss was written back to the cache. */
  stored?: boolean;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** 1-based rank within this response. */
  position: number;
  /** ISO date string when the provider exposes one. */
  publishedAt?: string;
  /** Origin engine/source when the provider is a metasearch (SearxNG). */
  source?: string;
  /** Provider-native relevance score when available. */
  score?: number;
}

export interface WebSearchResult {
  providerKey: string;
  driver: string;
  query: string;
  results: WebSearchResultItem[];
  /** Synthesized answer (AI interpretation or provider-native, e.g. Tavily). */
  answer?: string;
  /** Model key when the answer was produced by the instance's AI model. */
  answerModel?: string;
  /** True when the results were served from the semantic cache instead of the provider. */
  cached: boolean;
  /** Semantic cache outcome; omitted when caching is disabled on the instance. */
  cache?: WebSearchCacheInfo;
  /** Non-fatal notes, e.g. an `includeAnswer` request the instance could not serve. */
  warnings?: string[];
  latencyMs: number;
}
