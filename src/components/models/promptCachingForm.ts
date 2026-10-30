import {
  promptCachingSupport,
  type PromptCachingSettings,
} from '@/lib/services/models/promptCaching';

/** The cache prices a catalog entry carries (per 1M tokens); 0 / absent = the catalog has none. */
export interface CatalogCachePrices {
  cachedTokenPer1M: number;
  cacheWriteTokenPer1M: number;
}

/**
 * What the form keeps at `settings.promptCaching`: only what differs from the provider's default, so an untouched
 * record stays clean. `undefined` = the default (an edit sends `null` for it, which removes the key).
 * A model whose provider has no explicit caching never keeps a value.
 */
export function normalizePromptCaching(
  value: unknown,
  driver: string | undefined,
  modelId: string | undefined,
): PromptCachingSettings | undefined {
  const info = promptCachingSupport(driver, modelId);
  if (info.support !== 'explicit' || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as PromptCachingSettings;
  const next: PromptCachingSettings = {};
  if (typeof raw.enabled === 'boolean' && raw.enabled !== info.defaultEnabled) next.enabled = raw.enabled;
  if (raw.strategy === 'static') next.strategy = 'static';
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The cache prices of a catalog match, or null when it has neither (nothing to fill). */
export function cachePricesFromMatch(pricing: unknown): CatalogCachePrices | null {
  const p = (pricing && typeof pricing === 'object' ? pricing : {}) as Record<string, unknown>;
  const cachedTokenPer1M = Number(p.cachedTokenPer1M) || 0;
  const cacheWriteTokenPer1M = Number(p.cacheWriteTokenPer1M) || 0;
  return cachedTokenPer1M > 0 || cacheWriteTokenPer1M > 0 ? { cachedTokenPer1M, cacheWriteTokenPer1M } : null;
}
