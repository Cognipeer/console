/**
 * Unit tests — Web Search semantic cache (runWebSearch integration).
 *
 * The embedding model is a fixed lookup table of unit vectors, and the vector
 * store is an in-memory fake that scores by dot product, so similarities are
 * exact and threshold boundaries are deterministic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createWebSearchRunLog } = vi.hoisted(() => ({ createWebSearchRunLog: vi.fn() }));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue({
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    createWebSearchRunLog,
    listWebSearchRunLogs: vi.fn(),
  }),
}));

vi.mock('@/lib/core/asyncTask', () => ({
  fireAndForget: vi.fn((_name: string, fn: () => Promise<void>) => fn()),
}));

vi.mock('@/lib/services/providers/providerService', () => ({
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
}));

vi.mock('@/lib/services/webSearch/webSearchAdapter', () => ({
  callWebSearchProvider: vi.fn(),
}));

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: vi.fn(),
}));

vi.mock('@/lib/services/vector/vectorService', () => ({
  queryVectorIndex: vi.fn(),
  upsertVectors: vi.fn(),
}));

import { runWebSearch } from '@/lib/services/webSearch/webSearchService';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import { callWebSearchProvider } from '@/lib/services/webSearch/webSearchAdapter';
import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { queryVectorIndex, upsertVectors } from '@/lib/services/vector/vectorService';

const mockProvider = vi.mocked(callWebSearchProvider);
const mockEmbed = vi.mocked(handleEmbeddingRequest);
const mockQuery = vi.mocked(queryVectorIndex);
const mockUpsert = vi.mocked(upsertVectors);
const mockLoad = vi.mocked(loadProviderRuntimeData);

const VECTORS: Record<string, number[]> = {
  'hello world': [1, 0, 0],
  'hello there': [0.8, 0.6, 0],
  'something else': [0, 1, 0],
};

const RESULTS = Array.from({ length: 3 }, (_, i) => ({
  title: `Result ${i + 1}`,
  url: `https://example.com/${i + 1}`,
  snippet: `Snippet ${i + 1}`,
  position: i + 1,
  score: 0.5,
}));

const CACHE = {
  enabled: true,
  vectorProviderKey: 'vec',
  vectorIndexKey: 'cache-idx',
  embeddingModelKey: 'embed',
  similarityThreshold: 0.8,
};

function record(settings: Record<string, unknown> = { cache: CACHE }, key = 'brave-main') {
  return {
    tenantId: 'tenant-1',
    key,
    type: 'websearch',
    driver: 'brave-search',
    label: 'Brave',
    status: 'active',
    settings,
  };
}

interface StoredVector {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

type Filter = Record<string, unknown> | undefined;

/**
 * In-memory vector store. `scopeBy` decides how physical indexes are separated
 * (default: per tenant + project + provider + index, like the real service);
 * `honorFilter: false` simulates a driver that silently ignores metadata filters.
 */
function installVectorStore(options: { sharedIndex?: boolean; honorFilter?: boolean } = {}) {
  const store = new Map<string, StoredVector[]>();
  const bucket = (tenantId: string, projectId: string, req: { providerKey: string; indexKey?: string }) =>
    options.sharedIndex ? 'shared' : `${tenantId}|${projectId}|${req.providerKey}|${req.indexKey}`;

  mockUpsert.mockImplementation(async (_db, tenantId, projectId, req) => {
    const key = bucket(tenantId, projectId, req);
    const list = store.get(key) ?? [];
    for (const item of req.vectors) {
      const existing = list.findIndex((v) => v.id === item.id);
      const entry = { id: item.id, values: item.values, metadata: item.metadata ?? {} };
      if (existing >= 0) list[existing] = entry;
      else list.push(entry);
    }
    store.set(key, list);
  });

  mockQuery.mockImplementation(async (_db, tenantId, projectId, req) => {
    const list = store.get(bucket(tenantId, projectId, req)) ?? [];
    const filter = req.query.filter as Filter;
    const matches = list
      .filter((v) => options.honorFilter === false
        || !filter
        || Object.entries(filter).every(([k, val]) => v.metadata[k] === val))
      .map((v) => ({
        id: v.id,
        score: v.values.reduce((sum, x, i) => sum + x * (req.query.vector[i] ?? 0), 0),
        metadata: v.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, req.query.topK);
    return { matches };
  });

  return store;
}

/** Run a search, then let the fire-and-forget run log finish writing. */
async function search(query: string, extra: Record<string, unknown> = {}, ctx: { tenantId?: string; projectId?: string } = {}) {
  try {
    return await runWebSearch('tenant_acme', ctx.tenantId ?? 'tenant-1', 'projectId' in ctx ? ctx.projectId : 'proj-1', {
      query,
      providerKey: 'brave-main',
      source: 'api',
      ...extra,
    });
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoad.mockResolvedValue({ record: record(), credentials: { apiKey: 'sk-super-secret' } } as never);
  mockProvider.mockResolvedValue({ results: RESULTS });
  mockEmbed.mockImplementation((async ({ body }: { body: { input: string } }) => ({
    response: { data: [{ embedding: VECTORS[body.input] ?? [0, 0, 1] }] },
  })) as never);
  installVectorStore();
});

const lastLog = () => createWebSearchRunLog.mock.calls.at(-1)?.[0];

describe('cache disabled', () => {
  it.each([
    ['no cache settings', {}],
    ['cache.enabled false', { cache: { ...CACHE, enabled: false } }],
  ])('keeps the current behaviour with %s', async (_label, settings) => {
    mockLoad.mockResolvedValue({ record: record(settings), credentials: {} } as never);

    const result = await search('hello world');

    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(result.cached).toBe(false);
    expect(result.cache).toBeUndefined();
    expect(result.results).toEqual(RESULTS);
    expect(lastLog().metadata).toBeUndefined();
  });
});

describe('miss and storage', () => {
  it('embeds, searches the index first, calls the provider and stores the full result set', async () => {
    const result = await search('hello world');

    expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({
      modelKey: 'embed',
      projectId: 'proj-1',
      body: { input: 'hello world' },
    }));
    expect(mockQuery.mock.invocationCallOrder[0]).toBeLessThan(mockProvider.mock.invocationCallOrder[0]);
    expect(mockQuery).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', expect.objectContaining({
      providerKey: 'vec',
      indexKey: 'cache-idx',
      query: expect.objectContaining({ topK: 1, vector: VECTORS['hello world'] }),
    }));
    expect(mockProvider).toHaveBeenCalledTimes(1);

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const [, tenantId, projectId, request] = mockUpsert.mock.calls[0];
    expect([tenantId, projectId]).toEqual(['tenant-1', 'proj-1']);
    expect(request).toMatchObject({ providerKey: 'vec', indexKey: 'cache-idx' });
    const [entry] = request.vectors;
    expect(entry.values).toEqual(VECTORS['hello world']);
    expect(entry.metadata).toMatchObject({
      keyword: 'hello world',
      _searchKey: 'brave-main',
      _tenantId: 'tenant-1',
      _projectId: 'proj-1',
    });
    expect(JSON.parse(entry.metadata?._cachedResponse as string).results).toEqual(RESULTS);

    expect(result.cached).toBe(false);
    expect(result.cache).toEqual({ status: 'miss', stored: true });
    expect(result.results).toEqual(RESULTS);
    expect(lastLog().metadata.cache).toEqual({ status: 'miss', stored: true });
  });

  it('embeds the query once per search (the lookup embedding is reused for the write)', async () => {
    await search('hello world');
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('stores the trimmed query as the keyword', async () => {
    await search('  hello world  ');
    expect(mockUpsert.mock.calls[0][3].vectors[0].metadata?.keyword).toBe('hello world');
  });
});

describe('hit', () => {
  it('returns saved results without calling the provider', async () => {
    await search('hello world');
    mockProvider.mockClear();
    mockUpsert.mockClear();

    const result = await search('hello world');

    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
    expect(result.cache).toEqual({ status: 'hit', similarity: 1 });
    expect(result.results).toEqual(RESULTS);
    expect(result.query).toBe('hello world');
    expect(lastLog()).toMatchObject({
      status: 'success',
      resultCount: 3,
      metadata: { cache: { status: 'hit', similarity: 1 } },
    });
  });

  it('serves a semantically similar query and reports the current query text', async () => {
    await search('hello world');
    mockProvider.mockClear();

    const result = await search('hello there');

    expect(mockProvider).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
    expect(result.query).toBe('hello there');
  });

  it('keeps a provider-native answer stored with the entry', async () => {
    mockProvider.mockResolvedValue({ results: RESULTS, answer: 'native answer' });
    await search('hello world');
    const result = await search('hello world');
    expect(result.cached).toBe(true);
    expect(result.answer).toBe('native answer');
  });

  it('still interprets cached results with the AI model when an answer is requested', async () => {
    const settings = { cache: CACHE, aiAnswer: { enabled: true, modelKey: 'chat' } };
    mockLoad.mockResolvedValue({ record: record(settings), credentials: {} } as never);
    vi.mocked(handleChatCompletion).mockResolvedValue({
      response: { choices: [{ message: { content: 'AI says hi' } }] },
    } as never);

    await search('hello world', { includeAnswer: true });
    vi.mocked(handleChatCompletion).mockClear();
    mockProvider.mockClear();

    const result = await search('hello world', { includeAnswer: true });

    expect(mockProvider).not.toHaveBeenCalled();
    expect(handleChatCompletion).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(handleChatCompletion).mock.calls[0][0].body)).toContain('Result 1');
    expect(result).toMatchObject({ cached: true, answer: 'AI says hi', answerModel: 'chat' });
  });

  it('treats an unreadable cached entry as a miss and overwrites it', async () => {
    const store = installVectorStore();
    await search('hello world');
    const [entry] = [...store.values()][0];
    entry.metadata._cachedResponse = '{not json';
    mockProvider.mockClear();

    const result = await search('hello world');

    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(result.cache).toMatchObject({ status: 'miss', stored: true });
    expect(JSON.parse([...store.values()][0][0].metadata._cachedResponse as string).results).toEqual(RESULTS);
  });
});

describe('similarity threshold', () => {
  // 'hello there' scores exactly 0.8 against 'hello world'.
  async function warmThenAsk(threshold: number) {
    mockLoad.mockResolvedValue({
      record: record({ cache: { ...CACHE, similarityThreshold: threshold } }),
      credentials: {},
    } as never);
    await search('hello world');
    mockProvider.mockClear();
    return search('hello there');
  }

  it('hits when similarity equals the threshold', async () => {
    const result = await warmThenAsk(0.8);
    expect(result.cached).toBe(true);
    expect(result.cache?.similarity).toBeCloseTo(0.8, 10);
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('misses when similarity is just below the threshold', async () => {
    const result = await warmThenAsk(0.81);
    expect(result.cached).toBe(false);
    expect(result.cache?.status).toBe('miss');
    expect(mockProvider).toHaveBeenCalledTimes(1);
  });

  it('threshold 0 accepts any cached match', async () => {
    mockLoad.mockResolvedValue({
      record: record({ cache: { ...CACHE, similarityThreshold: 0 } }),
      credentials: {},
    } as never);
    await search('hello world');
    mockProvider.mockClear();
    const result = await search('something else');
    expect(result.cached).toBe(true);
  });

  it('threshold 1 only accepts an identical query', async () => {
    const miss = await warmThenAsk(1);
    expect(miss.cached).toBe(false);
    mockProvider.mockClear();
    const hit = await search('hello world');
    expect(hit.cached).toBe(true);
    expect(mockProvider).not.toHaveBeenCalled();
  });

  it('defaults to 0.8 when the threshold is not stored', async () => {
    const { similarityThreshold: _omit, ...withoutThreshold } = CACHE;
    void _omit;
    mockLoad.mockResolvedValue({ record: record({ cache: withoutThreshold }), credentials: {} } as never);
    await search('hello world');
    mockProvider.mockClear();
    expect((await search('hello there')).cached).toBe(true);
    expect((await search('something else')).cached).toBe(false);
  });
});

describe('request options', () => {
  async function warm(extra: Record<string, unknown> = {}, settings?: Record<string, unknown>) {
    if (settings) mockLoad.mockResolvedValue({ record: record(settings), credentials: {} } as never);
    await search('hello world', extra);
    mockProvider.mockClear();
  }

  it.each([
    ['count', { count: 10 }, { count: 5 }],
    ['count vs default', {}, { count: 5 }],
    ['offset', { offset: 0 }, { offset: 10 }],
    ['language', { language: 'en' }, { language: 'tr' }],
    ['country', { country: 'US' }, { country: 'TR' }],
    ['safeSearch', { safeSearch: 'off' }, { safeSearch: 'strict' }],
  ] as const)('does not reuse an entry cached with a different %s', async (_name, first, second) => {
    await warm(first);
    const result = await search('hello world', second);
    expect(result.cached).toBe(false);
    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(mockProvider).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining(second));
  });

  it('shares entries between an omitted count and the equivalent explicit/clamped count', async () => {
    await warm({});
    expect((await search('hello world', { count: 10 })).cached).toBe(true);
    expect((await search('hello world', { count: 10.7 })).cached).toBe(true);
    expect((await search('hello world', { count: 0 })).cached).toBe(true);
  });

  it('treats options that resolve to the same effective value as equal (settings fallback)', async () => {
    await warm({}, { cache: CACHE, country: 'US' });
    expect((await search('hello world', { country: 'US' })).cached).toBe(true);
    expect((await search('hello world', { country: 'TR' })).cached).toBe(false);
  });

  it('does not reuse entries after result-affecting instance settings change', async () => {
    await warm({}, { cache: CACHE, safeSearch: 'off' });
    mockLoad.mockResolvedValue({ record: record({ cache: CACHE, safeSearch: 'strict' }), credentials: {} } as never);
    expect((await search('hello world')).cached).toBe(false);
  });

  it('ignores includeAnswer and cache tuning when matching entries', async () => {
    await warm({ includeAnswer: false });
    mockLoad.mockResolvedValue({
      record: record({ cache: { ...CACHE, similarityThreshold: 0.5 }, aiAnswer: { enabled: false } }),
      credentials: {},
    } as never);
    expect((await search('hello world', { includeAnswer: true })).cached).toBe(true);
  });
});

describe('tenant, project and instance isolation', () => {
  it.each<[string, { tenantId?: string; projectId?: string }, string]>([
    ['tenant', { tenantId: 'tenant-2' }, 'brave-main'],
    ['project', { projectId: 'proj-2' }, 'brave-main'],
    ['instance', {}, 'brave-other'],
  ])('never serves an entry cached for another %s from a shared index', async (_name, ctx, key) => {
    installVectorStore({ sharedIndex: true });
    await search('hello world');
    mockProvider.mockClear();

    mockLoad.mockResolvedValue({ record: record({ cache: CACHE }, key), credentials: {} } as never);
    const result = await runWebSearch('tenant_acme', ctx.tenantId ?? 'tenant-1', ctx.projectId ?? 'proj-1', {
      query: 'hello world',
      providerKey: key,
    });

    expect(result.cached).toBe(false);
    expect(mockProvider).toHaveBeenCalledTimes(1);
  });

  it('still hits for the same tenant, project and instance on a shared index', async () => {
    installVectorStore({ sharedIndex: true });
    await search('hello world');
    mockProvider.mockClear();
    expect((await search('hello world')).cached).toBe(true);
  });

  it('cannot be tricked by a driver that ignores the metadata filter', async () => {
    installVectorStore({ sharedIndex: true, honorFilter: false });
    await search('hello world', {}, { projectId: 'proj-2' });
    mockProvider.mockClear();

    const result = await search('hello world');

    expect(result.cached).toBe(false);
    expect(mockProvider).toHaveBeenCalledTimes(1);
  });

  it('filters the vector search on the scope fingerprint', async () => {
    await search('hello world');
    const filter = mockQuery.mock.calls[0][3].query.filter as Record<string, string>;
    expect(Object.keys(filter)).toEqual(['_cacheScope']);
    expect(filter._cacheScope).toMatch(/^ws:[0-9a-f]{64}$/);
  });

  it('gives different scope fingerprints per tenant, project, instance', async () => {
    await search('hello world');
    await search('hello world', {}, { tenantId: 'tenant-2' });
    await search('hello world', {}, { projectId: 'proj-2' });
    const scopes = mockQuery.mock.calls.map((c) => (c[3].query.filter as Record<string, string>)._cacheScope);
    expect(new Set(scopes).size).toBe(3);
  });
});

describe('explicit failure handling', () => {
  const SECRET = 'sk-live-LEAKME https://user:pw@internal-host/payload';

  function expectNoLeak(result: { warnings?: string[] }) {
    const serialized = JSON.stringify([result, createWebSearchRunLog.mock.calls]);
    expect(serialized).not.toContain('LEAKME');
    expect(serialized).not.toContain('internal-host');
    expect(serialized).not.toContain('sk-super-secret');
  }

  it('falls back to the provider with a warning when embedding fails', async () => {
    mockEmbed.mockRejectedValue(new Error(SECRET));

    const result = await search('hello world');

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual(RESULTS);
    expect(result.cached).toBe(false);
    expect(result.cache).toEqual({ status: 'error' });
    expect(result.warnings?.[0]).toMatch(/Semantic cache unavailable \(the query could not be embedded\)/);
    expect(lastLog().metadata.cache).toEqual({ status: 'error' });
    expectNoLeak(result);
  });

  it('falls back with a warning when the vector search fails', async () => {
    mockQuery.mockRejectedValue(new Error(SECRET));

    const result = await search('hello world');

    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result.cache).toEqual({ status: 'error' });
    expect(result.warnings?.[0]).toMatch(/vector index could not be searched/);
    expectNoLeak(result);
  });

  it('returns the results and warns when writing the entry fails', async () => {
    mockUpsert.mockRejectedValue(new Error(SECRET));

    const result = await search('hello world');

    expect(result.results).toEqual(RESULTS);
    expect(result.cache).toEqual({ status: 'miss', stored: false });
    expect(result.warnings?.[0]).toMatch(/results were returned but not cached/);
    expectNoLeak(result);
  });

  it('reports a missing embedding vector as an embedding failure', async () => {
    mockEmbed.mockResolvedValue({ response: { data: [] } } as never);
    const result = await search('hello world');
    expect(result.cache).toEqual({ status: 'error' });
    expect(mockProvider).toHaveBeenCalledTimes(1);
  });

  it('still fails the search when the provider itself fails, and does not cache', async () => {
    mockProvider.mockRejectedValue(new Error('provider down'));

    await expect(search('hello world')).rejects.toThrow('provider down');

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(lastLog()).toMatchObject({ status: 'error' });
  });

  it.each([
    ['enabled without an index', { cache: { ...CACHE, vectorIndexKey: '' } }],
    ['a similarity threshold outside 0..1', { cache: { ...CACHE, similarityThreshold: 1.5 } }],
    ['a non-object cache value', { cache: 'yes' }],
  ])('reports %s as a cache config error and searches uncached', async (_label, settings) => {
    mockLoad.mockResolvedValue({ record: record(settings), credentials: {} } as never);

    const result = await search('hello world');

    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockProvider).toHaveBeenCalledTimes(1);
    expect(result.cache).toEqual({ status: 'error' });
    expect(result.warnings?.[0]).toMatch(/configuration is invalid/);
  });

  it('reports a config error when there is no project context', async () => {
    const result = await search('hello world', {}, { projectId: undefined });
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(result.cache).toEqual({ status: 'error' });
    expect(mockProvider).toHaveBeenCalledTimes(1);
  });
});
