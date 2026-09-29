/**
 * Semantic-cache settings for a Web Search instance (provider settings.cache).
 *
 * Pure shape validation — no I/O — so it can run on every persist path and at
 * search time. Reference checks (does the index / model exist in this project?)
 * live in `cacheValidation.ts`.
 */

import type { WebSearchCacheSettings } from './types';

export const DEFAULT_CACHE_SIMILARITY_THRESHOLD = 0.8;

export class WebSearchCacheConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSearchCacheConfigError';
  }
}

function requiredKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WebSearchCacheConfigError(`Cache requires ${label}.`);
  }
  return value.trim();
}

function optionalKey(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new WebSearchCacheConfigError(`Cache ${label} must be a string.`);
  }
  return value.trim() || undefined;
}

function parseThreshold(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CACHE_SIMILARITY_THRESHOLD;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new WebSearchCacheConfigError('Cache similarity threshold must be a number between 0 and 1.');
  }
  return value;
}

/**
 * Validate and normalise `settings.cache`. Returns undefined when the instance
 * has no cache settings at all. A disabled cache keeps its selections (so the
 * user does not lose them when toggling) but they are still shape-checked.
 * Enabling requires provider, index and embedding model.
 */
export function normalizeWebSearchCacheSettings(raw: unknown): WebSearchCacheSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebSearchCacheConfigError('Cache settings must be an object.');
  }

  const input = raw as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new WebSearchCacheConfigError('Cache "enabled" must be a boolean.');
  }
  const enabled = input.enabled === true;
  const similarityThreshold = parseThreshold(input.similarityThreshold);

  if (enabled) {
    return {
      enabled,
      vectorProviderKey: requiredKey(input.vectorProviderKey, 'a vector provider'),
      vectorIndexKey: requiredKey(input.vectorIndexKey, 'a vector index'),
      embeddingModelKey: requiredKey(input.embeddingModelKey, 'an embedding model'),
      similarityThreshold,
    };
  }

  return {
    enabled,
    vectorProviderKey: optionalKey(input.vectorProviderKey, 'vector provider'),
    vectorIndexKey: optionalKey(input.vectorIndexKey, 'vector index'),
    embeddingModelKey: optionalKey(input.embeddingModelKey, 'embedding model'),
    similarityThreshold,
  };
}

/** Same as {@link normalizeWebSearchCacheSettings} but for the whole provider settings object. */
export function normalizeWebSearchProviderSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!settings || settings.cache === undefined) return settings;
  const cache = normalizeWebSearchCacheSettings(settings.cache);
  const { cache: _omit, ...rest } = settings;
  void _omit;
  return cache ? { ...rest, cache } : rest;
}

/**
 * Settings the search actually runs with. Returns null when caching is off.
 * Throws {@link WebSearchCacheConfigError} for an enabled-but-invalid config
 * (e.g. edited directly in the database).
 */
export function resolveWebSearchCacheSettings(
  settings: Record<string, unknown> | undefined,
): Required<WebSearchCacheSettings> | null {
  const cache = normalizeWebSearchCacheSettings(settings?.cache);
  if (!cache?.enabled) return null;
  return cache as Required<WebSearchCacheSettings>;
}
