/**
 * Unit tests — model price catalog (LiteLLM feed import + name matching).
 *
 * `safeFetch` is mocked with a synchronous factory (async factories silently
 * fail to intercept — see reference-vitest-mock-importactual-trap).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch: vi.fn(),
  OutboundNetworkError: class OutboundNetworkError extends Error {},
}));

import { safeFetch } from '@/lib/security/outboundFetch';
import {
  getCatalogStatus,
  listCatalogEntries,
  MODEL_PRICE_CATALOG_URL,
  normalizeModelName,
  parseCatalogJson,
  perTokenToPerMillion,
  refreshCatalog,
  resetModelPriceCatalogCache,
  suggestPricing,
} from '@/lib/services/modelPriceCatalog/modelPriceCatalog';

const PAYLOAD: Record<string, unknown> = {
  sample_spec: {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    litellm_provider: 'one of https://docs.litellm.ai/docs/providers',
    mode: 'chat',
  },
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125,
    max_input_tokens: 128000,
    max_output_tokens: 16384,
    litellm_provider: 'openai',
    mode: 'chat',
  },
  'azure/gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    litellm_provider: 'azure',
    mode: 'chat',
  },
  'claude-sonnet-4-5-20250929': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    litellm_provider: 'anthropic',
    mode: 'chat',
  },
  'gpt-5-mini': {
    input_cost_per_token: 0.00000025,
    output_cost_per_token: 0.000002,
    litellm_provider: 'openai',
    mode: 'responses',
  },
  'gpt-5-mini-high': {
    input_cost_per_token: 0.0000005,
    output_cost_per_token: 0.000004,
    litellm_provider: 'openai',
    mode: 'responses',
  },
  'text-embedding-3-small': {
    input_cost_per_token: 0.00000002,
    output_cost_per_token: 0,
    litellm_provider: 'openai',
    mode: 'embedding',
  },
  'dall-e-3': {
    input_cost_per_token: 0.00004,
    litellm_provider: 'openai',
    mode: 'image_generation',
  },
  'free-local-model': {
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    litellm_provider: 'ollama',
    mode: 'chat',
  },
};

function mockFetchWith(payload: unknown, ok = true, status = 200) {
  (safeFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  } as unknown as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetModelPriceCatalogCache();
});

describe('perTokenToPerMillion', () => {
  it('converts per-token USD to per-1M without float noise', () => {
    expect(perTokenToPerMillion(0.0000025)).toBe(2.5);
    expect(perTokenToPerMillion(0.00001)).toBe(10);
    expect(perTokenToPerMillion(0.00000125)).toBe(1.25);
    expect(perTokenToPerMillion(0.00000002)).toBe(0.02);
  });

  it('collapses missing / invalid / negative values to 0', () => {
    expect(perTokenToPerMillion(undefined)).toBe(0);
    expect(perTokenToPerMillion(null)).toBe(0);
    expect(perTokenToPerMillion('nope')).toBe(0);
    expect(perTokenToPerMillion(-1)).toBe(0);
  });
});

describe('normalizeModelName', () => {
  it('lowercases and strips provider path prefixes', () => {
    expect(normalizeModelName('azure/gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelName('vertex_ai/gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(normalizeModelName('GPT-4o')).toBe('gpt-4o');
  });

  it('strips dotted bedrock vendor/region prefixes but keeps version dots', () => {
    expect(normalizeModelName('anthropic.claude-3-haiku')).toBe('claude-3-haiku');
    expect(normalizeModelName('us.anthropic.claude-3-haiku')).toBe('claude-3-haiku');
    expect(normalizeModelName('gpt-4.1')).toBe('gpt-4.1');
  });

  it('strips trailing date suffixes and -latest', () => {
    expect(normalizeModelName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(normalizeModelName('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(normalizeModelName('gpt-4o-20240806')).toBe('gpt-4o');
    expect(normalizeModelName('claude-3-5-sonnet-latest')).toBe('claude-3-5-sonnet');
  });

  it('collapses duplicate separators and trims stray ones', () => {
    expect(normalizeModelName('gpt--4o')).toBe('gpt-4o');
    expect(normalizeModelName('gpt-4o-')).toBe('gpt-4o');
  });
});

describe('parseCatalogJson', () => {
  it('keeps chat/completion/responses/embedding entries with a nonzero cost', () => {
    const entries = parseCatalogJson(PAYLOAD as Record<string, unknown>);
    const keys = entries.map((entry) => entry.key);
    expect(keys).toContain('gpt-4o');
    expect(keys).toContain('text-embedding-3-small');
    expect(keys).not.toContain('sample_spec');
    expect(keys).not.toContain('dall-e-3'); // image_generation mode
    expect(keys).not.toContain('free-local-model'); // all costs zero
  });

  it('converts per-token costs to per-1M pricing including cache reads', () => {
    const entries = parseCatalogJson(PAYLOAD as Record<string, unknown>);
    const gpt4o = entries.find((entry) => entry.key === 'gpt-4o');
    expect(gpt4o?.pricing).toEqual({
      currency: 'USD',
      inputTokenPer1M: 2.5,
      outputTokenPer1M: 10,
      cachedTokenPer1M: 1.25,
    });
    expect(gpt4o?.provider).toBe('openai');
    expect(gpt4o?.maxInputTokens).toBe(128000);
    const embedding = entries.find((entry) => entry.key === 'text-embedding-3-small');
    expect(embedding?.pricing.cachedTokenPer1M).toBeUndefined();
  });
});

describe('catalog cache + refresh', () => {
  it('reports an empty status before the first load', () => {
    const status = getCatalogStatus();
    expect(status.entries).toBe(0);
    expect(status.fetchedAt).toBeUndefined();
    expect(status.source).toBe(MODEL_PRICE_CATALOG_URL);
  });

  it('fetches once, serves from cache, and refetches on refreshCatalog()', async () => {
    mockFetchWith(PAYLOAD);
    await suggestPricing(['gpt-4o']);
    await suggestPricing(['gpt-4o']);
    await listCatalogEntries({});
    expect(safeFetch).toHaveBeenCalledTimes(1);

    const status = await refreshCatalog();
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(status.entries).toBeGreaterThan(0);
    expect(status.fetchedAt).toBeDefined();
  });

  it('throws when the fetch fails and no cache exists', async () => {
    mockFetchWith({ error: 'nope' }, false, 503);
    await expect(refreshCatalog()).rejects.toThrow(/HTTP 503/);
  });
});

describe('suggestPricing', () => {
  beforeEach(() => {
    mockFetchWith(PAYLOAD);
  });

  it('matches raw catalog keys as exact', async () => {
    const [suggestion] = await suggestPricing(['gpt-4o']);
    expect(suggestion.match?.confidence).toBe('exact');
    expect(suggestion.match?.catalogKey).toBe('gpt-4o');
    expect(suggestion.match?.pricing.inputTokenPer1M).toBe(2.5);
  });

  it('matches provider-prefixed names as normalized, preferring the bare key', async () => {
    const [suggestion] = await suggestPricing(['openai/gpt-4o']);
    expect(suggestion.match?.confidence).toBe('normalized');
    expect(suggestion.match?.catalogKey).toBe('gpt-4o'); // not azure/gpt-4o
  });

  it('matches date-suffixed and bedrock-prefixed variants as normalized', async () => {
    const [dated, bedrock] = await suggestPricing([
      'claude-sonnet-4-5',
      'anthropic.claude-sonnet-4-5-20250929',
    ]);
    expect(dated.match?.confidence).toBe('normalized');
    expect(dated.match?.catalogKey).toBe('claude-sonnet-4-5-20250929');
    expect(bedrock.match?.confidence).toBe('normalized');
    expect(bedrock.match?.catalogKey).toBe('claude-sonnet-4-5-20250929');
  });

  it('matches a unique prefix/suffix overlap as fuzzy', async () => {
    const [suggestion] = await suggestPricing(['proxy/gpt-4o-preview']);
    // normalized 'gpt-4o-preview' has catalog prefix 'gpt-4o' as its only
    // best-scoring candidate.
    expect(suggestion.match?.confidence).toBe('fuzzy');
    expect(suggestion.match?.catalogKey).toBe('gpt-4o');
  });

  it('returns no match when fuzzy candidates are ambiguous', async () => {
    // 'gpt-5' is a prefix of both 'gpt-5-mini' and 'gpt-5-mini-high' with the
    // same overlap score — ambiguous, so no guess.
    const [suggestion] = await suggestPricing(['gpt-5']);
    expect(suggestion.match).toBeUndefined();
  });

  it('returns no match for unknown names', async () => {
    const [suggestion] = await suggestPricing(['totally-unknown-model-xyz']);
    expect(suggestion.match).toBeUndefined();
  });
});

describe('capability flags', () => {
  it('carries supports_function_calling / vision / response_schema through parsing', async () => {
    const { parseCatalogJson } = await import('@/lib/services/modelPriceCatalog/modelPriceCatalog');
    const entries = parseCatalogJson({
      'gpt-cap': {
        mode: 'chat',
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
        litellm_provider: 'openai',
        supports_function_calling: true,
        supports_vision: false,
        supports_response_schema: true,
      },
      'gpt-nocap': {
        mode: 'chat',
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    });
    const cap = entries.find((e) => e.key === 'gpt-cap');
    expect(cap).toMatchObject({
      supportsFunctionCalling: true,
      supportsVision: false,
      supportsResponseSchema: true,
    });
    // Absent flags stay absent (unknown ≠ false) — gates must treat undefined leniently.
    const nocap = entries.find((e) => e.key === 'gpt-nocap');
    expect(nocap?.supportsFunctionCalling).toBeUndefined();
    expect(nocap?.supportsVision).toBeUndefined();
  });
});

describe('inferModelTier', () => {
  it('maps size markers to tiers across provider families', async () => {
    const { inferModelTier, MODEL_TIER_STANDARD } = await import('@/lib/services/modelPriceCatalog/modelPriceCatalog');
    expect(inferModelTier('gpt-5.4-nano')).toBe(1);
    expect(inferModelTier('gpt-4o-mini')).toBe(2);
    expect(inferModelTier('claude-haiku-4-5')).toBe(2);
    expect(inferModelTier('gemini-2.5-flash')).toBe(2);
    expect(inferModelTier('claude-sonnet-4-5')).toBe(3);
    expect(inferModelTier('claude-opus-4-1')).toBe(4);
    expect(inferModelTier('gemini-2.5-pro')).toBe(4);
    // No marker ⇒ standard tier; provider prefixes and date suffixes ignored.
    expect(inferModelTier('azure/gpt-5.6-terra-2026-05-01')).toBe(MODEL_TIER_STANDARD);
  });

  it('smallest marker wins on mixed names', async () => {
    const { inferModelTier } = await import('@/lib/services/modelPriceCatalog/modelPriceCatalog');
    expect(inferModelTier('grok-pro-mini')).toBe(2);
  });
});
