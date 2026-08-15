/**
 * Model price catalog — market reference prices for known models.
 *
 * Imports the community-maintained LiteLLM price file
 * (`model_prices_and_context_window.json`) and exposes it as an in-memory
 * catalog in the console's `IModelPricing` shape (USD per 1M tokens). The
 * catalog feeds two surfaces:
 *   - Cost → Pricing: bulk "match from catalog" suggestions for observed but
 *     unpriced models,
 *   - Model Hub: "fill from catalog" for the pricing fields of a model form.
 *
 * Contract:
 *   - The catalog is process-global (not tenant data) and cached in memory
 *     with a 24h TTL. Reads lazily refetch when the cache is empty or stale;
 *     `refreshCatalog()` forces a refetch. There are deliberately NO timers
 *     or schedulers — refresh is manual (product decision).
 *   - When a refetch fails but a stale cache exists, the stale catalog keeps
 *     serving (market prices drift slowly; stale beats unavailable).
 *   - Only chat/completion/responses/embedding entries with at least one
 *     nonzero token cost are kept; the `sample_spec` documentation entry is
 *     skipped.
 *   - `suggestPricing()` matches observed model names against catalog keys at
 *     three confidence tiers: 'exact' (raw equality), 'normalized' (equality
 *     after `normalizeModelName`), 'fuzzy' (normalized prefix/suffix overlap
 *     with a unique best candidate). Ambiguity yields NO match — a missing
 *     suggestion is recoverable, a wrong price silently corrupts spend data.
 *
 * Network access goes through `safeFetch` (SSRF guard). Self-host deployments
 * that block public egress must allowlist `raw.githubusercontent.com` — see
 * `OUTBOUND_HTTP_ALLOWED_HOSTS`.
 */

import type { IModelPricing } from '@/lib/database';
import { safeFetch } from '@/lib/security/outboundFetch';
import { normalizeModelName } from './modelTraits';

export const MODEL_PRICE_CATALOG_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
/** Fuzzy matching ignores normalized names shorter than this — too generic. */
const MIN_FUZZY_LENGTH = 4;

const INCLUDED_MODES = new Set(['chat', 'completion', 'responses', 'embedding']);

export interface ModelPriceCatalogEntry {
  /** Raw catalog key, e.g. 'gpt-4o', 'azure/gpt-4o', 'anthropic.claude-…'. */
  key: string;
  /** `litellm_provider` of the source entry, when present. */
  provider?: string;
  mode?: string;
  /** USD per 1M tokens (converted from the source's per-token costs). */
  pricing: IModelPricing;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Capability flags from the source feed — the deterministic hard gates of
   *  the recommendation engine key off these (absent = unknown, NOT false). */
  supportsFunctionCalling?: boolean;
  supportsVision?: boolean;
  supportsResponseSchema?: boolean;
}

export interface ModelPriceCatalogStatus {
  entries: number;
  /** ISO timestamp of the last successful fetch; undefined = never loaded. */
  fetchedAt?: string;
  source: string;
}

export type SuggestionConfidence = 'exact' | 'normalized' | 'fuzzy';

export interface PricingSuggestion {
  name: string;
  match?: {
    catalogKey: string;
    provider?: string;
    pricing: IModelPricing;
    confidence: SuggestionConfidence;
  };
}

interface CatalogCache {
  entries: ModelPriceCatalogEntry[];
  /** Raw key → entry (exact matching). */
  byKey: Map<string, ModelPriceCatalogEntry>;
  /** Normalized key → entries sharing it (e.g. 'gpt-4o' + 'azure/gpt-4o'). */
  byNormalized: Map<string, ModelPriceCatalogEntry[]>;
  fetchedAt: Date;
}

let cache: CatalogCache | null = null;
let inflight: Promise<CatalogCache> | null = null;

/** Test hook — drops the module-level cache. */
export function resetModelPriceCatalogCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Per-token USD → per-1M-token USD, rounded to 6 decimals to shed the float
 * noise `0.0000025 * 1e6` style multiplications produce. Non-finite and
 * negative inputs collapse to 0.
 */
export function perTokenToPerMillion(costPerToken: unknown): number {
  const value = Number(costPerToken ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000_000 * 1_000_000) / 1_000_000;
}

// ── Deterministic name-derived traits ─────────────────────────────────────
//
// Quality tier, parameter count, open-weight family and multilingual
// expectation all live in `modelTraits` — they are pure string work over a
// model NAME and are needed by callers that never touch pricing. Re-exported
// here because this module was their original home.

export {
  MODEL_TIER_STANDARD,
  normalizeModelName,
  inferModelTier,
  inferModelTierDetail,
  inferActiveParamsB,
  inferTotalParamsB,
  isOpenWeightModel,
  inferMultilingualSupport,
  type ModelTierDetail,
  type MultilingualSupport,
} from './modelTraits';

interface RawCatalogEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_response_schema?: boolean;
}

/**
 * Convert the raw LiteLLM JSON object into catalog entries. Pure — exported
 * for tests. Keeps chat/completion/responses/embedding entries with at least
 * one nonzero token cost; skips `sample_spec`.
 */
export function parseCatalogJson(raw: Record<string, unknown>): ModelPriceCatalogEntry[] {
  const entries: ModelPriceCatalogEntry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sample_spec') continue;
    if (!value || typeof value !== 'object') continue;
    const spec = value as RawCatalogEntry;
    if (!spec.mode || !INCLUDED_MODES.has(spec.mode)) continue;

    const inputTokenPer1M = perTokenToPerMillion(spec.input_cost_per_token);
    const outputTokenPer1M = perTokenToPerMillion(spec.output_cost_per_token);
    const cachedTokenPer1M = perTokenToPerMillion(spec.cache_read_input_token_cost);
    if (inputTokenPer1M <= 0 && outputTokenPer1M <= 0 && cachedTokenPer1M <= 0) continue;

    const pricing: IModelPricing = {
      currency: 'USD',
      inputTokenPer1M,
      outputTokenPer1M,
      ...(cachedTokenPer1M > 0 ? { cachedTokenPer1M } : {}),
    };
    entries.push({
      key,
      provider: typeof spec.litellm_provider === 'string' ? spec.litellm_provider : undefined,
      mode: spec.mode,
      pricing,
      ...(typeof spec.max_input_tokens === 'number' ? { maxInputTokens: spec.max_input_tokens } : {}),
      ...(typeof spec.max_output_tokens === 'number' ? { maxOutputTokens: spec.max_output_tokens } : {}),
      ...(typeof spec.supports_function_calling === 'boolean'
        ? { supportsFunctionCalling: spec.supports_function_calling }
        : {}),
      ...(typeof spec.supports_vision === 'boolean' ? { supportsVision: spec.supports_vision } : {}),
      ...(typeof spec.supports_response_schema === 'boolean'
        ? { supportsResponseSchema: spec.supports_response_schema }
        : {}),
    });
  }
  return entries;
}

function buildCache(entries: ModelPriceCatalogEntry[], fetchedAt: Date): CatalogCache {
  const byKey = new Map<string, ModelPriceCatalogEntry>();
  const byNormalized = new Map<string, ModelPriceCatalogEntry[]>();
  for (const entry of entries) {
    byKey.set(entry.key, entry);
    const normalized = normalizeModelName(entry.key);
    if (!normalized) continue;
    const bucket = byNormalized.get(normalized);
    if (bucket) bucket.push(entry);
    else byNormalized.set(normalized, [entry]);
  }
  return { entries, byKey, byNormalized, fetchedAt };
}

async function fetchCatalog(): Promise<CatalogCache> {
  const response = await safeFetch(
    MODEL_PRICE_CATALOG_URL,
    { headers: { accept: 'application/json' } },
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (!response.ok) {
    throw new Error(`Model price catalog fetch failed: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Model price catalog fetch failed: unexpected payload');
  }
  return buildCache(parseCatalogJson(raw), new Date());
}

/**
 * The catalog, refetched lazily when empty or older than the 24h TTL. A
 * failing refetch falls back to the stale cache when one exists.
 */
async function ensureCatalog(): Promise<CatalogCache> {
  if (cache && Date.now() - cache.fetchedAt.getTime() < CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchCatalog().finally(() => {
      inflight = null;
    });
  }
  try {
    cache = await inflight;
  } catch (error) {
    if (cache) return cache; // serve stale on refresh failure
    throw error;
  }
  return cache;
}

/** Force a refetch regardless of TTL (the manual "Refresh" action). */
export async function refreshCatalog(): Promise<ModelPriceCatalogStatus> {
  if (!inflight) {
    inflight = fetchCatalog().finally(() => {
      inflight = null;
    });
  }
  cache = await inflight;
  return getCatalogStatus();
}

export function getCatalogStatus(): ModelPriceCatalogStatus {
  return {
    entries: cache?.entries.length ?? 0,
    fetchedAt: cache?.fetchedAt.toISOString(),
    source: MODEL_PRICE_CATALOG_URL,
  };
}

/**
 * The whole loaded catalog, unpaged. `listCatalogEntries` caps a page at 500
 * because it backs a UI table; callers that need to REASON over the catalog
 * (the recommendation engine ranks every chat-capable model against a
 * baseline) need all of it. The entries come from the module's 24h in-memory
 * cache, so this is a array reference, not a fetch.
 */
export async function getCatalogEntries(): Promise<ModelPriceCatalogEntry[]> {
  return (await ensureCatalog()).entries;
}

/** Paged, key-sorted slice of the catalog; `search` filters by substring. */
export async function listCatalogEntries(options: {
  offset?: number;
  limit?: number;
  search?: string;
} = {}): Promise<{ total: number; entries: ModelPriceCatalogEntry[] }> {
  const loaded = await ensureCatalog();
  const search = options.search?.trim().toLowerCase();
  const filtered = search
    ? loaded.entries.filter(
        (entry) =>
          entry.key.toLowerCase().includes(search)
          || entry.provider?.toLowerCase().includes(search),
      )
    : loaded.entries;
  const sorted = [...filtered].sort((a, b) => a.key.localeCompare(b.key));
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
  return { total: sorted.length, entries: sorted.slice(offset, offset + limit) };
}

/**
 * When several raw keys share a normalized name (e.g. 'gpt-4o' and
 * 'azure/gpt-4o'), prefer the bare, unprefixed one — it is the vendor's own
 * listing; provider-prefixed copies usually mirror its prices.
 */
function pickCanonical(entries: ModelPriceCatalogEntry[], normalized: string): ModelPriceCatalogEntry {
  return (
    entries.find((entry) => entry.key.toLowerCase() === normalized)
    ?? [...entries].sort(
      (a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key),
    )[0]
  );
}

function toMatch(
  entry: ModelPriceCatalogEntry,
  confidence: SuggestionConfidence,
): NonNullable<PricingSuggestion['match']> {
  return {
    catalogKey: entry.key,
    provider: entry.provider,
    pricing: entry.pricing,
    confidence,
  };
}

/**
 * Suggest catalog pricing for each observed model name. Tiers, best first:
 *   1. 'exact' — the name is a raw catalog key,
 *   2. 'normalized' — the names are equal after `normalizeModelName`,
 *   3. 'fuzzy' — the normalized name is a prefix/suffix of a normalized
 *      catalog key (or vice versa) and exactly one candidate scores best.
 * Names that resolve ambiguously get NO match rather than a guess.
 */
export async function suggestPricing(names: string[]): Promise<PricingSuggestion[]> {
  const loaded = await ensureCatalog();

  return names.map((name): PricingSuggestion => {
    const exact = loaded.byKey.get(name);
    if (exact) return { name, match: toMatch(exact, 'exact') };

    const normalized = normalizeModelName(name);
    if (!normalized) return { name };

    const normalizedHits = loaded.byNormalized.get(normalized);
    if (normalizedHits && normalizedHits.length > 0) {
      return { name, match: toMatch(pickCanonical(normalizedHits, normalized), 'normalized') };
    }

    if (normalized.length < MIN_FUZZY_LENGTH) return { name };

    let bestScore = 0;
    let bestKeys: string[] = [];
    for (const candidate of loaded.byNormalized.keys()) {
      if (candidate.length < MIN_FUZZY_LENGTH) continue;
      const overlaps =
        candidate.startsWith(normalized)
        || candidate.endsWith(normalized)
        || normalized.startsWith(candidate)
        || normalized.endsWith(candidate);
      if (!overlaps) continue;
      const score = Math.min(candidate.length, normalized.length);
      if (score > bestScore) {
        bestScore = score;
        bestKeys = [candidate];
      } else if (score === bestScore) {
        bestKeys.push(candidate);
      }
    }

    if (bestKeys.length !== 1) return { name }; // none, or ambiguous tie
    const fuzzyHits = loaded.byNormalized.get(bestKeys[0]);
    if (!fuzzyHits || fuzzyHits.length === 0) return { name };
    return { name, match: toMatch(pickCanonical(fuzzyHits, bestKeys[0]), 'fuzzy') };
  });
}
