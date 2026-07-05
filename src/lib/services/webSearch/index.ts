export {
  listWebSearchProviders,
  listWebSearchRunLogs,
  runWebSearch,
  type RunWebSearchOptions,
} from './webSearchService';
export { callWebSearchProvider, parseDuckDuckGoHtml } from './webSearchAdapter';
export type {
  WebSearchInput,
  WebSearchResult,
  WebSearchResultItem,
} from './types';
