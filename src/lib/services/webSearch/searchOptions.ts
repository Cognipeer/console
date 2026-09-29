/**
 * Request-option normalisation shared by the provider adapter and the semantic
 * cache, so both agree on what a request actually asks the provider for.
 */

import type { WebSearchInput } from './types';

export const MAX_RESULTS = 50;
export const DEFAULT_RESULTS = 10;

export type SafeSearchLevel = 'off' | 'moderate' | 'strict';

export function clampCount(count?: number): number {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return DEFAULT_RESULTS;
  }
  return Math.min(Math.floor(count), MAX_RESULTS);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function asSafeSearch(value: unknown): SafeSearchLevel | undefined {
  return value === 'off' || value === 'moderate' || value === 'strict' ? value : undefined;
}

/** Request options after falling back to the instance settings, as the provider sees them. */
export interface EffectiveSearchOptions {
  count: number;
  offset: number;
  language?: string;
  country?: string;
  safeSearch?: SafeSearchLevel;
}

export function resolveEffectiveSearchOptions(
  input: Pick<WebSearchInput, 'count' | 'offset' | 'language' | 'country' | 'safeSearch'>,
  settings: Record<string, unknown>,
): EffectiveSearchOptions {
  return {
    count: clampCount(input.count),
    offset: typeof input.offset === 'number' && Number.isFinite(input.offset) ? input.offset : 0,
    language: input.language ?? asString(settings.language),
    country: input.country ?? asString(settings.country),
    safeSearch: input.safeSearch ?? asSafeSearch(settings.safeSearch),
  };
}
