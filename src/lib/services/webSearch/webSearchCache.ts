/**
 * Web Search semantic cache.
 *
 * Entries live in the vector index the instance selects. The index may be
 * shared with other data (other instances, other projects' cache entries, RAG
 * documents), so every entry carries a scope fingerprint that binds it to
 * tenant + project + Web Search instance + the request options that change what
 * the provider returns. Lookups filter on that fingerprint in the vector store
 * and re-check it locally, so a driver that mishandles the filter still cannot
 * produce a cross-scope hit.
 *
 * Failures are reported as a stage and a fixed message — never the underlying
 * error text, which can carry credentials or provider payloads.
 */

import crypto from 'crypto';
import { createLogger } from '@/lib/core/logger';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { queryVectorIndex, upsertVectors } from '@/lib/services/vector/vectorService';
import { resolveEffectiveSearchOptions } from './searchOptions';
import type { WebSearchCacheSettings, WebSearchInput, WebSearchResultItem } from './types';

const logger = createLogger('websearch-cache');

export const WEBSEARCH_CACHE_TYPE = 'websearch_cache';

/** Instance settings that never influence what the provider returns. */
const NON_RESULT_SETTINGS = new Set(['cache', 'aiAnswer']);

export type WebSearchCacheStage = 'config' | 'embedding' | 'lookup' | 'store';

const STAGE_MESSAGES: Record<WebSearchCacheStage, string> = {
  config: 'the cache configuration is invalid or unavailable',
  embedding: 'the query could not be embedded',
  lookup: 'the vector index could not be searched',
  store: 'the results could not be written to the vector index',
};

export function describeCacheFailure(stage: WebSearchCacheStage): string {
  return `Semantic cache unavailable (${STAGE_MESSAGES[stage]}); `
    + (stage === 'store' ? 'results were returned but not cached.' : 'the search ran without the cache.');
}

export interface WebSearchCacheScope {
  tenantId: string;
  projectId: string;
  searchKey: string;
  driver: string;
  /** Instance settings (never credentials). */
  instanceSettings: Record<string, unknown>;
  input: Pick<WebSearchInput, 'count' | 'offset' | 'language' | 'country' | 'safeSearch'>;
}

interface CacheTarget {
  tenantDbName: string;
  scope: WebSearchCacheScope;
  settings: Required<WebSearchCacheSettings>;
}

interface CachedPayload {
  results: WebSearchResultItem[];
  answer?: string;
}

export type WebSearchCacheLookup =
  | { status: 'hit'; similarity: number; results: WebSearchResultItem[]; answer?: string }
  | { status: 'miss'; embedding: number[] }
  | { status: 'error'; stage: WebSearchCacheStage };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint of everything that scopes a cache entry. Request options are
 * resolved the way the provider sees them (count clamped, settings fallbacks
 * applied), so `count: 10` and an omitted count share entries while `count: 5`
 * never reuses a `count: 10` result set.
 */
export function buildCacheScopeKey(scope: WebSearchCacheScope): string {
  const resultSettings = Object.fromEntries(
    Object.entries(scope.instanceSettings).filter(([name]) => !NON_RESULT_SETTINGS.has(name)),
  );
  const options = resolveEffectiveSearchOptions(scope.input, scope.instanceSettings);

  return `ws:${sha256(stableStringify({
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    searchKey: scope.searchKey,
    driver: scope.driver,
    settings: resultSettings,
    options,
  }))}`;
}

function buildEntryId(scopeKey: string, query: string): string {
  return sha256(`${scopeKey}\n${query}`).slice(0, 32);
}

function logFailure(stage: WebSearchCacheStage, target: CacheTarget, error: unknown): void {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (error as { statusCode?: unknown } | null)?.statusCode;
  logger.warn('Web search cache failure', {
    stage,
    tenantId: target.scope.tenantId,
    projectId: target.scope.projectId,
    searchKey: target.scope.searchKey,
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof status === 'number' ? { status } : {}),
  });
}

async function embedQuery(target: CacheTarget, query: string): Promise<number[]> {
  const result = await handleEmbeddingRequest({
    tenantDbName: target.tenantDbName,
    modelKey: target.settings.embeddingModelKey,
    projectId: target.scope.projectId,
    body: { input: query },
  });
  const data = result.response?.data as Array<{ embedding?: number[] }> | undefined;
  const embedding = data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding response contained no vector');
  }
  return embedding;
}

function parsePayload(raw: unknown): CachedPayload | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const { results, answer } = value as { results?: unknown; answer?: unknown };
  if (!Array.isArray(results)) return null;
  const valid = results.every((r) => (
    r && typeof r === 'object'
    && typeof (r as WebSearchResultItem).title === 'string'
    && typeof (r as WebSearchResultItem).url === 'string'
    && typeof (r as WebSearchResultItem).snippet === 'string'
    && typeof (r as WebSearchResultItem).position === 'number'
  ));
  if (!valid) return null;
  return {
    results: results as WebSearchResultItem[],
    ...(typeof answer === 'string' && answer !== '' ? { answer } : {}),
  };
}

export async function lookupWebSearchCache(
  params: CacheTarget & { query: string },
): Promise<WebSearchCacheLookup> {
  const { scope, settings, query } = params;
  const scopeKey = buildCacheScopeKey(scope);

  let embedding: number[];
  try {
    embedding = await embedQuery(params, query);
  } catch (error) {
    logFailure('embedding', params, error);
    return { status: 'error', stage: 'embedding' };
  }

  try {
    const response = await queryVectorIndex(params.tenantDbName, scope.tenantId, scope.projectId, {
      providerKey: settings.vectorProviderKey,
      indexKey: settings.vectorIndexKey,
      query: {
        vector: embedding,
        topK: 1,
        filter: { _cacheScope: scopeKey },
      },
    });

    const top = response.matches[0];
    if (!top || typeof top.score !== 'number' || top.score < settings.similarityThreshold) {
      return { status: 'miss', embedding };
    }

    const metadata = top.metadata ?? {};
    if (metadata._cacheType !== WEBSEARCH_CACHE_TYPE || metadata._cacheScope !== scopeKey) {
      return { status: 'miss', embedding };
    }

    const payload = parsePayload(metadata._cachedResponse);
    if (!payload) {
      logger.warn('Web search cache entry is unreadable; treating as a miss', {
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        searchKey: scope.searchKey,
      });
      return { status: 'miss', embedding };
    }

    return { status: 'hit', similarity: top.score, ...payload };
  } catch (error) {
    logFailure('lookup', params, error);
    return { status: 'error', stage: 'lookup' };
  }
}

/** Write a provider result set to the cache. Returns false (and logs) on failure. */
export async function storeWebSearchCache(
  params: CacheTarget & {
    query: string;
    embedding: number[];
    results: WebSearchResultItem[];
    answer?: string;
  },
): Promise<boolean> {
  const { scope, settings, query } = params;
  const scopeKey = buildCacheScopeKey(scope);

  try {
    await upsertVectors(params.tenantDbName, scope.tenantId, scope.projectId, {
      providerKey: settings.vectorProviderKey,
      indexKey: settings.vectorIndexKey,
      vectors: [
        {
          id: buildEntryId(scopeKey, query),
          values: params.embedding,
          metadata: {
            _cacheType: WEBSEARCH_CACHE_TYPE,
            _cacheScope: scopeKey,
            _tenantId: scope.tenantId,
            _projectId: scope.projectId,
            _searchKey: scope.searchKey,
            _cachedAt: Date.now(),
            keyword: query,
            _cachedResponse: JSON.stringify({
              results: params.results,
              ...(params.answer ? { answer: params.answer } : {}),
            }),
          },
        },
      ],
    });
    return true;
  } catch (error) {
    logFailure('store', params, error);
    return false;
  }
}
