import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/services/providers/providerService', () => ({
  assertProviderEnabled: vi.fn(),
  loadProviderRuntimeData: (...args: unknown[]) => loadMock(...args),
}));
vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: (...a: unknown[]) => fetchMock(...a) }));
vi.mock('@/lib/core/resilience', () => ({ withResilience: (fn: () => unknown) => fn() }));

import { callRerankProvider } from '@/lib/services/reranker/rerankAdapter';

const ctx = { tenantDbName: 't', tenantId: 't1', model: { modelId: 'bge', providerKey: 'p' } } as never;

function provider(settings: Record<string, unknown>, credentials: Record<string, unknown>) {
  loadMock.mockResolvedValue({ record: { driver: 'openai-compatible', settings }, credentials });
}

describe('rerank adapter openai-compatible baseUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }) });
  });

  it('reads baseUrl from settings', async () => {
    provider({ baseUrl: 'https://rr.example/v1/' }, { apiKey: 'k' });
    const out = await callRerankProvider(ctx, { query: 'q', documents: ['a'] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://rr.example/v1/rerank');
    expect(out.results[0].score).toBe(0.9);
  });

  it('falls back to credentials.baseUrl for old records', async () => {
    provider({}, { apiKey: 'k', baseUrl: 'https://old.example/v1' });
    await callRerankProvider(ctx, { query: 'q', documents: ['a'] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://old.example/v1/rerank');
  });

  it('errors without claiming a credential when missing', async () => {
    provider({}, { apiKey: 'k' });
    await expect(callRerankProvider(ctx, { query: 'q', documents: ['a'] })).rejects.toThrow('requires a baseUrl.');
  });
});
