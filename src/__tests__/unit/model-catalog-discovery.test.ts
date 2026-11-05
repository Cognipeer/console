/**
 * Model discovery per driver, with a mocked network: the URL, headers and guard options of each listing, the errors a
 * person is shown (credentials rejected, time limit, unreachable, refused endpoint) without a credential in them, the
 * fallbacks (Azure's configured deployment, built-in lists), Bedrock's signed requests, Anthropic's paging, and what
 * happens to a listing afterwards: category filter, order, cap, reference prices and limits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import type { ModelCategory } from '@/lib/database';
import type { SafeFetchOptions } from '@/lib/security/outboundFetch';
import type { ModelPriceCatalogEntry } from '@/lib/services/modelPriceCatalog/modelPriceCatalog';
import {
  discoverProviderModels,
  type DiscoveryDeps,
  type DiscoveryInput,
} from '@/lib/services/models/catalog/discovery';
import { CATALOG_MAX_MODELS } from '@/lib/services/models/catalog/types';

// Names resolve without the network.
const dns = vi.hoisted(() => ({ hosts: new Map<string, string[]>() }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const addresses = dns.hosts.get(host);
    if (!addresses) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }),
  resolveSrv: vi.fn(async (name: string) => {
    throw Object.assign(new Error(`querySrv ENODATA ${name}`), { code: 'ENODATA' });
  }),
}));

const SECRET = 'sk-live-secret-1234';
const NOW = new Date('2026-11-05T12:00:00Z');

const original = getConfigSource();
beforeEach(() => {
  dns.hosts.clear();
  setConfigSource({ get: (k: string) => ({ DEPLOYMENT_MODE: 'saas' } as Record<string, string>)[k] ?? process.env[k] } as ConfigSource);
});
afterEach(() => setConfigSource(original));

type Call = [string, RequestInit, SafeFetchOptions];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers per URL (first matching prefix wins); unknown URLs are a 599 so a test notices them. */
function fetchMap(routes: Array<[string | RegExp, Response | (() => Response) | Error]>) {
  return vi.fn<(url: string, init?: RequestInit, options?: SafeFetchOptions) => Promise<Response>>(async (url) => {
    for (const [match, answer] of routes) {
      const hit = typeof match === 'string' ? url.startsWith(match) : match.test(url);
      if (!hit) continue;
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    }
    return new Response(null, { status: 599 });
  });
}

const callsOf = (fetchImpl: ReturnType<typeof vi.fn>) => fetchImpl.mock.calls as unknown as Call[];
const headersOf = (call: Call) => call[1].headers as Record<string, string>;

const REFERENCE: ModelPriceCatalogEntry[] = [
  {
    key: 'gpt-4o',
    provider: 'openai',
    mode: 'chat',
    pricing: { currency: 'USD', inputTokenPer1M: 2.5, outputTokenPer1M: 10, cachedTokenPer1M: 1.25 },
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    supportsFunctionCalling: true,
    supportsVision: true,
    supportsResponseSchema: true,
  },
  { key: 'azure/gpt-4o', provider: 'azure', mode: 'chat', pricing: { currency: 'USD', inputTokenPer1M: 5, outputTokenPer1M: 15 }, maxInputTokens: 128000 },
  { key: 'text-embedding-3-small', provider: 'openai', mode: 'embedding', pricing: { currency: 'USD', inputTokenPer1M: 0.02, outputTokenPer1M: 0 }, maxInputTokens: 8191 },
  {
    key: 'groq/llama-3.3-70b-versatile',
    provider: 'groq',
    mode: 'chat',
    pricing: { currency: 'USD', inputTokenPer1M: 0.59, outputTokenPer1M: 0.79 },
    maxInputTokens: 128000,
    maxOutputTokens: 32768,
    supportsFunctionCalling: true,
  },
  {
    key: 'together_ai/meta-llama/Llama-3.3-70B-Instruct-Turbo',
    provider: 'together_ai',
    mode: 'chat',
    pricing: { currency: 'USD', inputTokenPer1M: 9, outputTokenPer1M: 9 },
    maxInputTokens: 131072,
    supportsFunctionCalling: true,
  },
  { key: 'gemini-2.5-pro', provider: 'vertex_ai-language-models', mode: 'chat', pricing: { currency: 'USD', inputTokenPer1M: 1.25, outputTokenPer1M: 10 }, maxInputTokens: 1048576, maxOutputTokens: 65535 },
  { key: 'vertex_ai/gemini-2.5-pro', provider: 'vertex_ai-language-models', mode: 'chat', pricing: { currency: 'USD', inputTokenPer1M: 1.25, outputTokenPer1M: 10 }, maxInputTokens: 1048576 },
  { key: 'text-embedding-005', provider: 'vertex_ai-embedding-models', mode: 'embedding', pricing: { currency: 'USD', inputTokenPer1M: 0.025, outputTokenPer1M: 0 } },
  { key: 'chat-bison', provider: 'vertex_ai-language-models', mode: 'chat', pricing: { currency: 'USD', inputTokenPer1M: 0.5, outputTokenPer1M: 0.5 } },
  { key: 'vertex_ai/gemini-2.5-flash@001', provider: 'vertex_ai-language-models', mode: 'chat', pricing: { currency: 'USD', inputTokenPer1M: 0.3, outputTokenPer1M: 2.5 } },
  { key: 'vertex_ai/claude-sonnet-4@20250514', provider: 'vertex_ai-anthropic_models', mode: 'chat', pricing: { currency: 'USD', inputTokenPer1M: 3, outputTokenPer1M: 15 } },
];

function input(overrides: Partial<DiscoveryInput>): DiscoveryInput {
  return {
    driver: 'openai',
    type: 'model',
    credentials: { apiKey: SECRET },
    settings: {},
    tenantId: 't1',
    allowedCategories: ['llm', 'embedding', 'stt', 'tts', 'ocr', 'image', 'moderation', 'decision'],
    ...overrides,
  };
}

function deps(fetchImpl: ReturnType<typeof vi.fn>, extra: DiscoveryDeps = {}): DiscoveryDeps {
  return { fetchImpl: fetchImpl as never, referenceEntries: async () => REFERENCE, now: () => NOW, ...extra };
}

describe('OpenAI', () => {
  it('lists with the key through the guarded fetch, filters and orders, enriches from the reference catalog', async () => {
    const fetchImpl = fetchMap([
      [
        'https://api.openai.com/v1/models',
        json(200, {
          object: 'list',
          data: [
            { id: 'gpt-4o-realtime-preview', created: 1727659998, owned_by: 'system' },
            { id: 'whisper-1', created: 1677532384, owned_by: 'openai-internal' },
            { id: 'text-embedding-3-small', created: 1705948997, owned_by: 'system' },
            { id: 'gpt-4o', created: 1715367049, owned_by: 'system' },
            { id: 'gpt-4o-2024-08-06', created: 1722814719, owned_by: 'system' },
            { id: 'gpt-4o-experimental', created: 1700000000, owned_by: 'system' },
            { id: 'sora-2', created: 1759000000, owned_by: 'system' },
          ],
        }),
      ],
    ]);
    const result = await discoverProviderModels(input({ settings: { organization: 'org-abc' } }), deps(fetchImpl));

    const [url, init, options] = callsOf(fetchImpl)[0];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.method).toBe('GET');
    expect(headersOf(callsOf(fetchImpl)[0])).toMatchObject({
      Accept: 'application/json',
      Authorization: `Bearer ${SECRET}`,
      'OpenAI-Organization': 'org-abc',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // SaaS: the guard is forced, redirects are not followed, the limit is passed down.
    expect(options).toMatchObject({ forceBlock: true, followRedirects: false, timeoutMs: 15_000 });

    expect(result).toMatchObject({ source: 'live', supported: true, fetchedAt: NOW.toISOString() });
    expect(result.error).toBeUndefined();
    // Newest first within a category, the realtime and video models left out.
    expect(result.models.map((m) => [m.id, m.category])).toEqual([
      ['gpt-4o-2024-08-06', 'llm'],
      ['gpt-4o', 'llm'],
      ['gpt-4o-experimental', 'llm'],
      ['text-embedding-3-small', 'embedding'],
      ['whisper-1', 'stt'],
    ]);
    expect(result.notices).toEqual([{ code: 'excluded_unsupported', count: 2 }]);
    expect(result.models.every((m) => m.source === 'live')).toBe(true);

    const byId = Object.fromEntries(result.models.map((m) => [m.id, m]));
    // Exact: price, limits and capability flags.
    expect(byId['gpt-4o']).toMatchObject({
      contextWindow: 128000,
      maxOutputTokens: 16384,
      supportsToolCalls: true,
      supportsStructuredOutputs: true,
      inputModalities: ['text', 'image'],
      pricing: { currency: 'USD', inputTokenPer1M: 2.5, outputTokenPer1M: 10, cachedTokenPer1M: 1.25, source: 'reference', confidence: 'exact', catalogKey: 'gpt-4o' },
    });
    // Normalized (dated id): the bare key's entry.
    expect(byId['gpt-4o-2024-08-06'].pricing).toMatchObject({ confidence: 'normalized', catalogKey: 'gpt-4o' });
    expect(byId['gpt-4o-2024-08-06'].contextWindow).toBe(128000);
    // Fuzzy: a price to show, nothing else taken from a sibling model.
    expect(byId['gpt-4o-experimental'].pricing).toMatchObject({ confidence: 'fuzzy', catalogKey: 'gpt-4o', source: 'reference' });
    expect(byId['gpt-4o-experimental'].contextWindow).toBeUndefined();
    expect(byId['gpt-4o-experimental'].supportsToolCalls).toBeUndefined();
    expect(byId['text-embedding-3-small']).toMatchObject({ contextWindow: 8191, pricing: { confidence: 'exact', inputTokenPer1M: 0.02 } });
    // Not enriched: no price for a speech model from a token price list.
    expect(byId['whisper-1'].pricing).toBeUndefined();
  });

  it('reports rejected credentials without reading the failure body or echoing the key', async () => {
    const cancel = vi.fn(async () => undefined);
    const failure = {
      status: 401,
      ok: false,
      body: { cancel, getReader: vi.fn(() => { throw new Error('read'); }) },
      json: vi.fn(async () => ({ error: `bad key ${SECRET}` })),
      text: vi.fn(async () => `bad key ${SECRET}`),
    } as unknown as Response;
    const fetchImpl = fetchMap([['https://api.openai.com/', () => failure]]);
    const result = await discoverProviderModels(input({}), deps(fetchImpl));
    expect(result.error).toEqual({ code: 'auth_failed', message: 'The provider rejected the credentials (HTTP 401).', status: 401 });
    expect(result.models).toEqual([]);
    expect(cancel).toHaveBeenCalled();
    expect((failure.json as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((failure.text as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('answers timeout when the provider does not answer within the limit', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    }));
    const started = Date.now();
    const result = await discoverProviderModels(input({}), deps(fetchImpl, { timeoutMs: 50 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.error).toMatchObject({ code: 'timeout' });
    expect((fetchImpl.mock.calls[0] as unknown as Call)[2]).toMatchObject({ timeoutMs: 50 });
  });

  it('scrubs credentials from a network error', async () => {
    const fetchImpl = fetchMap([['https://api.openai.com/', new TypeError(`fetch failed for ${SECRET}`)]]);
    const result = await discoverProviderModels(input({}), deps(fetchImpl));
    expect(result.error?.code).toBe('unreachable');
    expect(result.error?.message).toContain('***');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('upstream errors: a redirect is not followed, a server error carries its status, a non-JSON body is no list', async () => {
    const redirected = await discoverProviderModels(input({}), deps(fetchMap([['https://api.openai.com/', new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })]])));
    expect(redirected.error).toMatchObject({ code: 'upstream_error', status: 302 });
    const failed = await discoverProviderModels(input({}), deps(fetchMap([['https://api.openai.com/', json(503, {})]])));
    expect(failed.error).toEqual({ code: 'upstream_error', message: 'The provider answered HTTP 503.', status: 503 });
    const html = await discoverProviderModels(input({}), deps(fetchMap([['https://api.openai.com/', new Response('<html>hi</html>', { status: 200 })]])));
    expect(html.error).toMatchObject({ code: 'upstream_error', status: 200 });
  });

  it('a missing key is reported without a request', async () => {
    const fetchImpl = fetchMap([]);
    const result = await discoverProviderModels(input({ credentials: {} }), deps(fetchImpl));
    expect(result.error?.code).toBe('credentials_unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('reference enrichment', () => {
  const listing = () => fetchMap([['https://api.openai.com/', json(200, { data: [{ id: 'gpt-4o' }] })]]);

  it('waits for the reference catalog only so long, then answers without it', async () => {
    const started = Date.now();
    const result = await discoverProviderModels(input({}), deps(listing(), {
      referenceEntries: () => new Promise<ModelPriceCatalogEntry[]>(() => undefined),
      referenceWaitMs: 30,
    }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.models[0].pricing).toBeUndefined();
    expect(result.notices).toEqual([{ code: 'pricing_reference_unavailable' }]);
  });

  it('a failed reference load is "unavailable", not an error', async () => {
    const result = await discoverProviderModels(input({}), deps(listing(), { referenceEntries: async () => { throw new Error('offline'); } }));
    expect(result.error).toBeUndefined();
    expect(result.notices).toEqual([{ code: 'pricing_reference_unavailable' }]);
  });

  it('starts loading the reference catalog alongside the provider call', async () => {
    let resolveReference: (entries: ModelPriceCatalogEntry[]) => void = () => undefined;
    const referenceEntries = vi.fn(() => new Promise<ModelPriceCatalogEntry[]>((resolve) => {
      resolveReference = resolve;
    }));
    const fetchImpl = vi.fn(async () => {
      // The reference load is under way before the provider answers.
      expect(referenceEntries).toHaveBeenCalled();
      resolveReference(REFERENCE);
      return json(200, { data: [{ id: 'gpt-4o' }] });
    });
    const result = await discoverProviderModels(input({}), deps(fetchImpl, { referenceEntries }));
    expect(result.models[0].pricing?.source).toBe('reference');
  });
});

describe('OpenAI-compatible', () => {
  it('appends /models to the base URL, sends the key both ways, prefers the vendor\'s reference price', async () => {
    dns.hosts.set('api.groq.com', ['104.18.2.205']);
    const fetchImpl = fetchMap([
      [
        'https://api.groq.com/openai/v1/models',
        json(200, {
          object: 'list',
          data: [
            { id: 'llama-3.3-70b-versatile', object: 'model', created: 1733447754, owned_by: 'Meta', active: true, context_window: 131072, max_completion_tokens: 32768 },
            { id: 'whisper-large-v3', object: 'model', owned_by: 'OpenAI', active: true, context_window: 448 },
          ],
        }),
      ],
    ]);
    const result = await discoverProviderModels(
      input({ driver: 'openai-compatible', settings: { baseUrl: 'https://api.groq.com/openai/v1/' } }),
      deps(fetchImpl),
    );
    const call = callsOf(fetchImpl)[0];
    expect(call[0]).toBe('https://api.groq.com/openai/v1/models');
    expect(headersOf(call)).toMatchObject({ Authorization: `Bearer ${SECRET}`, 'api-key': SECRET });
    const llama = result.models.find((m) => m.id === 'llama-3.3-70b-versatile');
    // The provider's limits stay; the vendor-prefixed key gives the price.
    expect(llama).toMatchObject({
      contextWindow: 131072,
      maxOutputTokens: 32768,
      supportsToolCalls: true,
      pricing: { catalogKey: 'groq/llama-3.3-70b-versatile', confidence: 'exact', inputTokenPer1M: 0.59 },
    });
    expect(result.models.find((m) => m.id === 'whisper-large-v3')?.category).toBe('stt');
  });

  it('a server without a list route (404/405/501) is "unsupported": custom entry, not an error', async () => {
    for (const status of [404, 405, 501]) {
      const result = await discoverProviderModels(
        input({ driver: 'openai-compatible', settings: { baseUrl: 'https://93.184.216.34/v1' } }),
        deps(fetchMap([['https://93.184.216.34/v1/models', json(status, {})]])),
      );
      expect(result).toMatchObject({ supported: false, source: 'none', models: [] });
      expect(result.error).toBeUndefined();
    }
  });

  it('a local server without a key is asked without one', async () => {
    const fetchImpl = fetchMap([['https://93.184.216.34/v1/models', json(200, { data: [{ id: 'llama3.2:latest', object: 'model', owned_by: 'library' }] })]]);
    const result = await discoverProviderModels(
      input({ driver: 'openai-compatible', credentials: {}, settings: { baseUrl: 'https://93.184.216.34/v1' } }),
      deps(fetchImpl),
    );
    expect(headersOf(callsOf(fetchImpl)[0]).Authorization).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual(['llama3.2:latest']);
  });

  it('refuses a private endpoint before dialling it', async () => {
    const fetchImpl = fetchMap([]);
    const result = await discoverProviderModels(
      input({ driver: 'openai-compatible', settings: { baseUrl: 'http://127.0.0.1:8000/v1' } }),
      deps(fetchImpl),
    );
    expect(result.error?.code).toBe('endpoint_not_allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('without a base URL the settings are invalid', async () => {
    const result = await discoverProviderModels(input({ driver: 'openai-compatible', settings: {} }), deps(fetchMap([])));
    expect(result.error?.code).toBe('invalid_settings');
  });

  it('caps a long list and says so', async () => {
    const data = Array.from({ length: CATALOG_MAX_MODELS + 25 }, (_, i) => ({ id: `model-${String(i).padStart(5, '0')}` }));
    const result = await discoverProviderModels(
      input({ driver: 'openai-compatible', settings: { baseUrl: 'https://93.184.216.34/v1' } }),
      deps(fetchMap([['https://93.184.216.34/v1/models', json(200, { data })]]), { referenceEntries: async () => [] }),
    );
    expect(result.models).toHaveLength(CATALOG_MAX_MODELS);
    expect(result.models[0].id).toBe('model-00000');
    expect(result.notices).toContainEqual({ code: 'truncated', count: CATALOG_MAX_MODELS });
  });

  it('orders current models before deprecated ones, then by category', async () => {
    const result = await discoverProviderModels(
      input({ driver: 'openai-compatible', settings: { baseUrl: 'https://93.184.216.34/v1' } }),
      deps(fetchMap([[
        'https://93.184.216.34/v1/models',
        json(200, {
          data: [
            { id: 'b-old', deprecation: '2026-01-01' },
            { id: 'nomic-embed-text' },
            { id: 'zeta' },
            { id: 'alpha' },
            { id: 'tts-1' },
          ],
        }),
      ]]), { referenceEntries: async () => [] }),
    );
    expect(result.models.map((m) => m.id)).toEqual(['alpha', 'zeta', 'nomic-embed-text', 'tts-1', 'b-old']);
  });
});

describe('Together', () => {
  it('reads the bare array; the provider\'s price wins over the reference; categories outside the driver are left out', async () => {
    const fetchImpl = fetchMap([[
      'https://api.together.xyz/v1/models',
      json(200, [
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', display_name: 'Meta Llama 3.3 70B Instruct Turbo', context_length: 131072, pricing: { input: 0.88, output: 0.88 } },
        { id: 'BAAI/bge-large-en-v1.5', type: 'embedding', pricing: { input: 0.02, output: 0 } },
        { id: 'Salesforce/Llama-Rank-V1', type: 'rerank' },
        { id: 'black-forest-labs/FLUX.1-schnell', type: 'image' },
      ]),
    ]]);
    const result = await discoverProviderModels(
      input({ driver: 'together', allowedCategories: ['llm', 'embedding'] as ModelCategory[] }),
      deps(fetchImpl),
    );
    expect(result.models.map((m) => m.id)).toEqual(['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'BAAI/bge-large-en-v1.5']);
    expect(result.notices).toEqual([{ code: 'excluded_unsupported', count: 2 }]);
    expect(result.models[0].pricing).toEqual({ currency: 'USD', inputTokenPer1M: 0.88, outputTokenPer1M: 0.88, source: 'provider' });
    expect(headersOf(callsOf(fetchImpl)[0]).Authorization).toBe(`Bearer ${SECRET}`);
  });
});

describe('Anthropic', () => {
  it('follows has_more / last_id with after_id', async () => {
    const fetchImpl = fetchMap([
      [/after_id=claude-b/, json(200, { data: [{ type: 'model', id: 'claude-c', display_name: 'C', created_at: '2024-01-01T00:00:00Z' }], has_more: false, last_id: 'claude-c' })],
      ['https://api.anthropic.com/v1/models?limit=1000', json(200, {
        data: [
          { type: 'model', id: 'claude-a', display_name: 'A', created_at: '2025-01-01T00:00:00Z' },
          { type: 'model', id: 'claude-b', display_name: 'B', created_at: '2024-06-01T00:00:00Z' },
        ],
        has_more: true,
        first_id: 'claude-a',
        last_id: 'claude-b',
      })],
    ]);
    const result = await discoverProviderModels(input({ driver: 'anthropic', allowedCategories: ['llm', 'ocr'] }), deps(fetchImpl));
    const calls = callsOf(fetchImpl);
    expect(calls.map((c) => c[0])).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-b',
    ]);
    expect(headersOf(calls[0])).toMatchObject({ 'x-api-key': SECRET, 'anthropic-version': '2023-06-01' });
    expect(result.models.map((m) => [m.id, m.name])).toEqual([['claude-a', 'A'], ['claude-b', 'B'], ['claude-c', 'C']]);
  });

  it('stops after five pages', async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => {
      page += 1;
      return json(200, { data: [{ id: `claude-${page}` }], has_more: true, last_id: `claude-${page}` });
    });
    const result = await discoverProviderModels(input({ driver: 'anthropic', allowedCategories: ['llm'] }), deps(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(result.models).toHaveLength(5);
  });

  it('a gateway without the models route (404) is "unsupported"; the base URL is normalized', async () => {
    dns.hosts.set('my-res.services.ai.azure.com', ['20.50.2.1']);
    const fetchImpl = fetchMap([['https://my-res.services.ai.azure.com/anthropic/v1/models', json(404, {})]]);
    const result = await discoverProviderModels(
      input({ driver: 'anthropic', settings: { baseUrl: 'https://my-res.services.ai.azure.com/anthropic/v1/messages' }, allowedCategories: ['llm'] }),
      deps(fetchImpl),
    );
    expect(callsOf(fetchImpl)[0][0]).toBe('https://my-res.services.ai.azure.com/anthropic/v1/models?limit=1000');
    expect(result).toMatchObject({ supported: false, source: 'none', models: [] });
  });
});

describe('Azure OpenAI', () => {
  const settings = { instanceName: 'my-res', deploymentName: 'chat-prod', apiVersion: '2024-10-21' };

  it('lists deployments with the api-key header; the azure/ reference key gives the price', async () => {
    const fetchImpl = fetchMap([[
      'https://my-res.openai.azure.com/openai/deployments?api-version=2023-03-15-preview',
      json(200, { data: [{ id: 'chat-prod', model: 'gpt-4o', status: 'succeeded', object: 'deployment' }, { id: 'embed', model: 'text-embedding-3-small', status: 'succeeded' }] }),
    ]]);
    const result = await discoverProviderModels(input({ driver: 'azure', settings }), deps(fetchImpl));
    expect(headersOf(callsOf(fetchImpl)[0])).toMatchObject({ 'api-key': SECRET });
    expect(result.models.map((m) => [m.id, m.category, m.upstreamModel])).toEqual([
      ['chat-prod', 'llm', 'gpt-4o'],
      ['embed', 'embedding', 'text-embedding-3-small'],
    ]);
    expect(result.models[0].pricing).toMatchObject({ catalogKey: 'azure/gpt-4o', inputTokenPer1M: 5, confidence: 'exact' });
    expect(result.models[1].pricing).toMatchObject({ catalogKey: 'text-embedding-3-small' });
  });

  it('a resource that does not list deployments falls back to the configured one', async () => {
    for (const status of [404, 400]) {
      const result = await discoverProviderModels(
        input({ driver: 'azure', settings }),
        deps(fetchMap([['https://my-res.openai.azure.com/', json(status, {})]])),
      );
      expect(result.error).toBeUndefined();
      expect(result.models.map((m) => [m.id, m.category, m.source])).toEqual([['chat-prod', 'llm', 'static']]);
      expect(result.notices).toContainEqual({ code: 'azure_deployments_unlisted' });
    }
  });

  it('an instance name that is not a plain resource name is a settings problem, not a request', async () => {
    const fetchImpl = fetchMap([]);
    const result = await discoverProviderModels(input({ driver: 'azure', settings: { ...settings, instanceName: 'evil.example.com/x' } }), deps(fetchImpl));
    expect(result.error?.code).toBe('invalid_settings');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Bedrock', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'session-token-value' };
  const foundation = {
    modelSummaries: [
      { modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0', modelName: 'Claude 3.5 Sonnet', providerName: 'Anthropic', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'], modelLifecycle: { status: 'ACTIVE' } },
      { modelId: 'anthropic.claude-sonnet-4-20250514-v1:0', modelName: 'Claude Sonnet 4', providerName: 'Anthropic', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], inferenceTypesSupported: ['INFERENCE_PROFILE'], modelLifecycle: { status: 'ACTIVE' } },
      { modelId: 'amazon.titan-embed-text-v2:0', modelName: 'Titan Text Embeddings V2', providerName: 'Amazon', inputModalities: ['TEXT'], outputModalities: ['EMBEDDING'], inferenceTypesSupported: ['ON_DEMAND'], modelLifecycle: { status: 'ACTIVE' } },
      { modelId: 'amazon.titan-image-generator-v2:0', modelName: 'Titan Image Generator G1 v2', providerName: 'Amazon', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['IMAGE'], inferenceTypesSupported: ['ON_DEMAND'], modelLifecycle: { status: 'ACTIVE' } },
    ],
  };
  const profile = (id: string, foundationId: string) => ({
    inferenceProfileId: id,
    inferenceProfileName: id,
    status: 'ACTIVE',
    type: 'SYSTEM_DEFINED',
    models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${foundationId}` }],
  });

  it('signs both lists, keeps on-demand models, adds the inference profiles (paged)', async () => {
    const fetchImpl = fetchMap([
      ['https://bedrock.us-east-1.amazonaws.com/foundation-models', json(200, foundation)],
      [/inference-profiles\?.*nextToken=page%2B2%3D/, json(200, { inferenceProfileSummaries: [profile('eu.anthropic.claude-sonnet-4-20250514-v1:0', 'anthropic.claude-sonnet-4-20250514-v1:0')] })],
      ['https://bedrock.us-east-1.amazonaws.com/inference-profiles?', json(200, {
        inferenceProfileSummaries: [profile('us.anthropic.claude-sonnet-4-20250514-v1:0', 'anthropic.claude-sonnet-4-20250514-v1:0')],
        nextToken: 'page+2=',
      })],
    ]);
    const result = await discoverProviderModels(
      input({ driver: 'bedrock', credentials, settings: { region: 'us-east-1' }, allowedCategories: ['llm', 'embedding', 'ocr'] }),
      deps(fetchImpl, { referenceEntries: async () => [] }),
    );
    const calls = callsOf(fetchImpl);
    expect(calls.map((c) => c[0]).sort()).toEqual([
      'https://bedrock.us-east-1.amazonaws.com/foundation-models',
      'https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000&typeEquals=SYSTEM_DEFINED',
      'https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000&typeEquals=SYSTEM_DEFINED&nextToken=page%2B2%3D',
    ]);
    for (const call of calls) {
      const headers = headersOf(call);
      expect(headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261105\/us-east-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
      );
      expect(headers['x-amz-date']).toBe('20261105T120000Z');
      expect(headers['x-amz-security-token']).toBe('session-token-value');
      // Set by the HTTP client from the URL, not by hand.
      expect(headers.host).toBeUndefined();
    }
    expect(result.models.map((m) => [m.id, m.category])).toEqual([
      ['anthropic.claude-3-5-sonnet-20240620-v1:0', 'llm'],
      ['eu.anthropic.claude-sonnet-4-20250514-v1:0', 'llm'],
      ['us.anthropic.claude-sonnet-4-20250514-v1:0', 'llm'],
      ['amazon.titan-embed-text-v2:0', 'embedding'],
    ]);
    expect(result.models.find((m) => m.id.startsWith('us.'))).toMatchObject({ upstreamModel: 'anthropic.claude-sonnet-4-20250514-v1:0', inputModalities: ['text', 'image'] });
    expect(result.notices).toEqual([{ code: 'excluded_unsupported', count: 1 }]);
    expect(JSON.stringify(result)).not.toContain(credentials.secretAccessKey);
  });

  it('a failure of the inference profiles alone still lists the foundation models', async () => {
    const fetchImpl = fetchMap([
      ['https://bedrock.us-east-1.amazonaws.com/foundation-models', json(200, foundation)],
      ['https://bedrock.us-east-1.amazonaws.com/inference-profiles', json(403, {})],
    ]);
    const result = await discoverProviderModels(
      input({ driver: 'bedrock', credentials, settings: { region: 'us-east-1' }, allowedCategories: ['llm', 'embedding'] }),
      deps(fetchImpl, { referenceEntries: async () => [] }),
    );
    expect(result.error).toBeUndefined();
    expect(result.models.map((m) => m.id)).toEqual(['anthropic.claude-3-5-sonnet-20240620-v1:0', 'amazon.titan-embed-text-v2:0']);
  });

  it('a failure of the foundation models is the listing\'s error', async () => {
    const fetchImpl = fetchMap([
      ['https://bedrock.us-east-1.amazonaws.com/foundation-models', json(403, {})],
      ['https://bedrock.us-east-1.amazonaws.com/inference-profiles', json(200, { inferenceProfileSummaries: [] })],
    ]);
    const result = await discoverProviderModels(
      input({ driver: 'bedrock', credentials, settings: { region: 'us-east-1' } }),
      deps(fetchImpl, { referenceEntries: async () => [] }),
    );
    expect(result.error).toMatchObject({ code: 'auth_failed', status: 403 });
  });

  it('a region that is not an AWS region id is a settings problem', async () => {
    const fetchImpl = fetchMap([]);
    const result = await discoverProviderModels(input({ driver: 'bedrock', credentials, settings: { region: 'evil.example.com#' } }), deps(fetchImpl));
    expect(result.error?.code).toBe('invalid_settings');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Cohere, Mistral OCR, Azure Document Intelligence', () => {
  it('Cohere: lists rerank models; a failed listing falls back to the built-in list with the error', async () => {
    const ok = fetchMap([['https://api.cohere.com/v1/models?endpoint=rerank&page_size=1000', json(200, { models: [{ name: 'rerank-v3.5', endpoints: ['rerank'] }, { name: 'command-r', endpoints: ['chat'] }] })]]);
    const listed = await discoverProviderModels(input({ driver: 'cohere', allowedCategories: ['rerank'] }), deps(ok));
    expect(listed).toMatchObject({ source: 'live', models: [{ id: 'rerank-v3.5', category: 'rerank', source: 'live' }] });

    const failed = await discoverProviderModels(input({ driver: 'cohere', allowedCategories: ['rerank'] }), deps(fetchMap([['https://api.cohere.com/', json(500, {})]])));
    expect(failed.source).toBe('static');
    expect(failed.error).toMatchObject({ code: 'upstream_error', status: 500 });
    expect(failed.notices).toEqual([{ code: 'listing_fallback' }]);
    expect(failed.models.map((m) => m.id)).toEqual(['rerank-english-v3.0', 'rerank-multilingual-v3.0', 'rerank-v3.5']);
    expect(failed.models.every((m) => m.source === 'static')).toBe(true);
  });

  it('Mistral OCR: keeps the OCR models of the account; none listed falls back to the built-in one', async () => {
    const fetchImpl = fetchMap([['https://api.mistral.ai/v1/models', json(200, {
      data: [
        { id: 'mistral-ocr-2505', capabilities: { completion_chat: false } },
        { id: 'mistral-ocr-latest', capabilities: { completion_chat: false } },
        { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
      ],
    })]]);
    const listed = await discoverProviderModels(input({ driver: 'mistral-ocr', type: 'ocr', allowedCategories: ['ocr'] }), deps(fetchImpl));
    expect(listed.models.map((m) => [m.id, m.category])).toEqual([['mistral-ocr-2505', 'ocr'], ['mistral-ocr-latest', 'ocr']]);

    const empty = await discoverProviderModels(
      input({ driver: 'mistral-ocr', type: 'ocr', allowedCategories: ['ocr'] }),
      deps(fetchMap([['https://api.mistral.ai/v1/models', json(200, { data: [{ id: 'mistral-large-latest' }] })]])),
    );
    expect(empty).toMatchObject({ source: 'static', notices: [{ code: 'listing_fallback' }], models: [{ id: 'mistral-ocr-latest' }] });
    expect(empty.error).toBeUndefined();
  });

  it('Azure Document Intelligence: the subscription key header, next pages on the same origin only', async () => {
    dns.hosts.set('my-di.cognitiveservices.azure.com', ['20.50.2.2']);
    const fetchImpl = fetchMap([
      [/skip=1/, json(200, {
        value: [{ modelId: 'my-custom' }],
        nextLink: 'https://elsewhere.example/documentintelligence/documentModels?skip=2',
      })],
      ['https://my-di.cognitiveservices.azure.com/documentintelligence/documentModels?api-version=2024-11-30', json(200, {
        value: [{ modelId: 'prebuilt-read', description: 'Extract text.' }],
        nextLink: 'https://my-di.cognitiveservices.azure.com/documentintelligence/documentModels?api-version=2024-11-30&skip=1',
      })],
    ]);
    const result = await discoverProviderModels(
      input({ driver: 'azure-document-intelligence', type: 'ocr', settings: { endpoint: 'https://my-di.cognitiveservices.azure.com/' }, allowedCategories: ['ocr'] }),
      deps(fetchImpl),
    );
    const calls = callsOf(fetchImpl);
    expect(calls).toHaveLength(2);
    expect(headersOf(calls[0])).toMatchObject({ 'Ocp-Apim-Subscription-Key': SECRET });
    expect(result.models.map((m) => m.id)).toEqual(['my-custom', 'prebuilt-read']);
  });

  it('Azure Document Intelligence: a rejected key shows the built-in list with the error', async () => {
    dns.hosts.set('my-di.cognitiveservices.azure.com', ['20.50.2.2']);
    const result = await discoverProviderModels(
      input({ driver: 'azure-document-intelligence', type: 'ocr', settings: { endpoint: 'https://my-di.cognitiveservices.azure.com' }, allowedCategories: ['ocr'] }),
      deps(fetchMap([['https://my-di.cognitiveservices.azure.com/', json(401, {})]])),
    );
    expect(result.error?.code).toBe('auth_failed');
    expect(result.notices).toEqual([{ code: 'listing_fallback' }]);
    expect(result.models.map((m) => m.id)).toContain('prebuilt-read');
  });
});

describe('drivers without a list API', () => {
  it('Vertex: the reference catalog\'s Vertex models, with their reference prices', async () => {
    const fetchImpl = fetchMap([]);
    const result = await discoverProviderModels(
      input({ driver: 'vertex', credentials: { serviceAccountKey: '{"private_key":"x"}' }, settings: { projectId: 'p', location: 'us-central1' }, allowedCategories: ['llm', 'embedding', 'ocr'] }),
      deps(fetchImpl),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'reference', supported: true, notices: [{ code: 'reference_listing' }] });
    expect(result.models.map((m) => [m.id, m.category, m.deprecated ?? false])).toEqual([
      ['gemini-2.5-pro', 'llm', false],
      ['text-embedding-005', 'embedding', false],
      ['chat-bison', 'llm', true],
    ]);
    expect(result.models[0]).toMatchObject({ source: 'reference', contextWindow: 1048576, pricing: { catalogKey: 'vertex_ai/gemini-2.5-pro', confidence: 'exact' } });
  });

  it('Vertex: without the reference catalog, the built-in list', async () => {
    const result = await discoverProviderModels(
      input({ driver: 'vertex', allowedCategories: ['llm', 'embedding', 'ocr'] }),
      deps(fetchMap([]), { referenceEntries: async () => { throw new Error('offline'); } }),
    );
    expect(result.source).toBe('static');
    expect(result.notices).toEqual([{ code: 'static_listing' }, { code: 'pricing_reference_unavailable' }]);
    expect(result.models.map((m) => m.id)).toContain('gemini-2.5-flash');
  });

  it.each([
    ['jina-ai', ['rerank'], 'jina-reranker-v2-base-multilingual'],
    ['voyage-ai', ['rerank'], 'rerank-2.5'],
    ['alibaba-modelstudio', ['decision'], 'decision-model-preview'],
    ['typesafe', ['decision'], 'jev-latest'],
    ['aws-textract', ['ocr'], 'detect-document-text'],
  ] as Array<[string, ModelCategory[], string]>)('%s: the built-in list, nothing dialled', async (driver, allowedCategories, expected) => {
    const fetchImpl = fetchMap([]);
    const referenceEntries = vi.fn(async () => REFERENCE);
    const result = await discoverProviderModels(input({ driver, allowedCategories }), deps(fetchImpl, { referenceEntries }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(referenceEntries).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'static', supported: true, notices: [{ code: 'static_listing' }] });
    expect(result.models.map((m) => m.id)).toContain(expected);
    expect(result.models.every((m) => allowedCategories.includes(m.category))).toBe(true);
  });

  it('Google Document AI: the configured processor', async () => {
    const result = await discoverProviderModels(
      input({ driver: 'google-document-ai', type: 'ocr', settings: { processorId: 'abc123' }, allowedCategories: ['ocr'] }),
      deps(fetchMap([])),
    );
    expect(result).toMatchObject({ source: 'static', models: [{ id: 'abc123', category: 'ocr', source: 'static' }] });
    const none = await discoverProviderModels(input({ driver: 'google-document-ai', type: 'ocr', allowedCategories: ['ocr'] }), deps(fetchMap([])));
    expect(none).toMatchObject({ supported: false, source: 'none', models: [] });
  });

  it.each(['something-else', 'constructor', '__proto__'])('an unknown driver (%s) has nothing to list', async (driver) => {
    const fetchImpl = fetchMap([]);
    const result = await discoverProviderModels(input({ driver }), deps(fetchImpl));
    expect(result).toMatchObject({ supported: false, source: 'none', models: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
