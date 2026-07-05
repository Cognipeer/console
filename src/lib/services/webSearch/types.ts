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
   * a synthesized `answer`. Errors if AI answers are not enabled on the
   * instance settings.
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
  latencyMs: number;
}
