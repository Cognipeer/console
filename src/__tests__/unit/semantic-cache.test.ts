/**
 * Unit tests — SemanticCacheService
 *
 * isSemanticCacheEnabled  — pure function, no DB
 * lookupCache / storeInCache — mocked inferenceService + vectorService
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IModel, ISemanticCacheConfig } from '@/lib/database';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: vi.fn(),
}));

vi.mock('@/lib/services/vector/vectorService', () => ({
  queryVectorIndex: vi.fn(),
  upsertVectors: vi.fn(),
}));

import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { queryVectorIndex, upsertVectors } from '@/lib/services/vector/vectorService';
import {
  isSemanticCacheEnabled,
  lookupCache,
  storeInCache,
} from '@/lib/services/models/semanticCacheService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CACHE_CONFIG: ISemanticCacheConfig = {
  enabled: true,
  vectorProviderKey: 'my-vector',
  vectorIndexKey: 'cache-index',
  embeddingModelKey: 'text-embedding-3-small',
  similarityThreshold: 0.9,
  ttlSeconds: 3600,
};

const PARAMS = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  config: CACHE_CONFIG,
};

const MOCK_EMBEDDING = Array.from({ length: 1536 }, (_, i) => i * 0.001);

function mockEmbeddingResponse() {
  (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
    response: { data: [{ embedding: MOCK_EMBEDDING }] },
    requestId: 'emb-1',
  });
}

// ── isSemanticCacheEnabled ────────────────────────────────────────────────────

describe('isSemanticCacheEnabled', () => {
  it('returns true when all required fields are present and enabled=true', () => {
    const model = {
      semanticCache: {
        enabled: true,
        vectorProviderKey: 'vec',
        vectorIndexKey: 'idx',
        embeddingModelKey: 'emb',
      },
    } as unknown as IModel;
    expect(isSemanticCacheEnabled(model)).toBe(true);
  });

  it('returns false when enabled=false', () => {
    const model = {
      semanticCache: {
        enabled: false,
        vectorProviderKey: 'vec',
        vectorIndexKey: 'idx',
        embeddingModelKey: 'emb',
      },
    } as unknown as IModel;
    expect(isSemanticCacheEnabled(model)).toBe(false);
  });

  it('returns false when vectorProviderKey is missing', () => {
    const model = {
      semanticCache: { enabled: true, vectorIndexKey: 'idx', embeddingModelKey: 'emb' },
    } as unknown as IModel;
    expect(isSemanticCacheEnabled(model)).toBe(false);
  });

  it('returns false when semanticCache is undefined', () => {
    const model = {} as unknown as IModel;
    expect(isSemanticCacheEnabled(model)).toBe(false);
  });

  it('returns false when any required sub-key is an empty string', () => {
    const model = {
      semanticCache: {
        enabled: true,
        vectorProviderKey: '',
        vectorIndexKey: 'idx',
        embeddingModelKey: 'emb',
      },
    } as unknown as IModel;
    expect(isSemanticCacheEnabled(model)).toBe(false);
  });
});

// ── lookupCache ───────────────────────────────────────────────────────────────

describe('lookupCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns hit=false when messages have no user content', async () => {
    const result = await lookupCache({
      ...PARAMS,
      messages: [{ role: 'system', content: 'You are a bot.' }],
    });
    expect(result.hit).toBe(false);
    expect(handleEmbeddingRequest).not.toHaveBeenCalled();
  });

  it('returns hit=false when vector query returns no matches', async () => {
    mockEmbeddingResponse();
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ matches: [] });

    const result = await lookupCache({
      ...PARAMS,
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    });
    expect(result.hit).toBe(false);
  });

  it('returns hit=false when similarity score is below threshold', async () => {
    mockEmbeddingResponse();
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [{ id: 'c1', score: 0.5, metadata: { _cachedResponse: '{"text":"4"}' } }],
    });

    const result = await lookupCache({
      ...PARAMS,
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    });
    expect(result.hit).toBe(false);
  });

  it('returns hit=true with response when score ≥ threshold', async () => {
    mockEmbeddingResponse();
    const cachedResponse = { id: 'res-1', choices: [{ message: { content: '4' } }] };
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [
        {
          id: 'c1',
          score: 0.97,
          metadata: {
            _cachedResponse: JSON.stringify(cachedResponse),
            _cachedAt: Date.now(),
          },
        },
      ],
    });

    const result = await lookupCache({
      ...PARAMS,
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    });
    expect(result.hit).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.9);
    expect(result.response).toMatchObject({ id: 'res-1' });
  });

  it('returns hit=false when TTL has expired', async () => {
    mockEmbeddingResponse();
    const expiredAt = Date.now() - 7200 * 1000; // 2 hours ago, TTL is 1h
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [
        {
          id: 'c1',
          score: 0.98,
          metadata: {
            _cachedResponse: '{"text":"stale"}',
            _cachedAt: expiredAt,
          },
        },
      ],
    });

    const result = await lookupCache({
      ...PARAMS,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.hit).toBe(false);
  });

  it('returns hit=false gracefully when embedding call throws', async () => {
    (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Embedding service unavailable'),
    );

    const result = await lookupCache({
      ...PARAMS,
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(result.hit).toBe(false);
  });

  it('uses only the last user message for cache key', async () => {
    mockEmbeddingResponse();
    (queryVectorIndex as ReturnType<typeof vi.fn>).mockResolvedValue({ matches: [] });

    await lookupCache({
      ...PARAMS,
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' }, // this should be used
      ],
    });

    // handleEmbeddingRequest should have been called with the last user message
    expect(handleEmbeddingRequest).toHaveBeenCalledTimes(1);
    const callArg = (handleEmbeddingRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.body.input).toBe('second question');
  });
});

// ── storeInCache ──────────────────────────────────────────────────────────────

describe('storeInCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips when messages have no user content', async () => {
    await storeInCache({
      ...PARAMS,
      messages: [{ role: 'system', content: 'sys' }],
      response: { text: 'ok' },
    });
    expect(handleEmbeddingRequest).not.toHaveBeenCalled();
    expect(upsertVectors).not.toHaveBeenCalled();
  });

  it('calls upsertVectors with correct metadata structure', async () => {
    mockEmbeddingResponse();
    (upsertVectors as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await storeInCache({
      ...PARAMS,
      messages: [{ role: 'user', content: 'What is the capital of France?' }],
      response: { answer: 'Paris' },
    });

    expect(upsertVectors).toHaveBeenCalledTimes(1);
    const callArgs = (upsertVectors as ReturnType<typeof vi.fn>).mock.calls[0];
    const [dbName, tenantId, projectId, upsertReq] = callArgs;

    expect(dbName).toBe(PARAMS.tenantDbName);
    expect(tenantId).toBe(PARAMS.tenantId);
    expect(projectId).toBe(PARAMS.projectId);
    expect(upsertReq.providerKey).toBe(CACHE_CONFIG.vectorProviderKey);
    expect(upsertReq.indexKey).toBe(CACHE_CONFIG.vectorIndexKey);
    expect(upsertReq.vectors).toHaveLength(1);

    const vector = upsertReq.vectors[0];
    expect(typeof vector.id).toBe('string');
    expect(vector.id.length).toBeGreaterThan(0);
    expect(Array.isArray(vector.values)).toBe(true);
    expect(vector.metadata._cacheType).toBe('semantic_cache');
    expect(typeof vector.metadata._cachedAt).toBe('number');
    expect(vector.metadata._cachedResponse).toContain('Paris');
  });

  it('does not throw when upsertVectors fails', async () => {
    mockEmbeddingResponse();
    (upsertVectors as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Vector DB unavailable'),
    );

    await expect(
      storeInCache({
        ...PARAMS,
        messages: [{ role: 'user', content: 'test' }],
        response: { text: 'ok' },
      }),
    ).resolves.toBeUndefined();
  });

  it('two different queries produce different cache vector ids', async () => {
    mockEmbeddingResponse();
    const ids: string[] = [];
    (upsertVectors as ReturnType<typeof vi.fn>).mockImplementation(
      (_db, _t, _p, req: { vectors: Array<{ id: string }> }) => {
        ids.push(req.vectors[0].id);
        return Promise.resolve();
      },
    );

    await storeInCache({ ...PARAMS, messages: [{ role: 'user', content: 'A' }], response: {} });
    await storeInCache({ ...PARAMS, messages: [{ role: 'user', content: 'B' }], response: {} });

    expect(ids[0]).not.toBe(ids[1]);
  });
});
