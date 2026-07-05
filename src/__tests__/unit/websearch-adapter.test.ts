/**
 * Unit tests — web search adapter.
 *
 * Driver dispatch, credential validation, response normalization, and the
 * DuckDuckGo HTML parser. External HTTP is stubbed at the fetch level.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/core/resilience', () => ({
  withResilience: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch: vi.fn(),
}));

import { callWebSearchProvider, parseDuckDuckGoHtml } from '@/lib/services/webSearch/webSearchAdapter';
import { safeFetch } from '@/lib/security/outboundFetch';
import type { IProviderRecord } from '@/lib/database';

function providerRecord(driver: string, settings: Record<string, unknown> = {}): IProviderRecord {
  return {
    tenantId: 'tenant-1',
    key: `${driver}-test`,
    type: 'websearch',
    driver,
    label: driver,
    status: 'active',
    credentialsEnc: 'enc',
    settings,
    createdBy: 'user-1',
  } as IProviderRecord;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const realFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('driver dispatch and credential validation', () => {
  it('rejects unknown drivers', async () => {
    await expect(
      callWebSearchProvider(providerRecord('openai'), {}, { query: 'x' }),
    ).rejects.toThrow(/does not support web search/i);
  });

  it.each([['bing'], ['brave-search'], ['serper'], ['tavily']])(
    '%s requires an apiKey credential',
    async (driver) => {
      await expect(
        callWebSearchProvider(providerRecord(driver), {}, { query: 'x' }),
      ).rejects.toThrow(/apiKey credential/i);
    },
  );

  it('searxng requires a baseUrl setting', async () => {
    await expect(
      callWebSearchProvider(providerRecord('searxng'), {}, { query: 'x' }),
    ).rejects.toThrow(/baseUrl/i);
  });
});

describe('Bing normalization', () => {
  it('maps webPages.value to normalized results and applies params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        webPages: {
          value: [
            { name: 'Result A', url: 'https://a.example', snippet: 'AA', datePublished: '2026-01-01' },
            { name: 'Result B', url: 'https://b.example', snippet: 'BB' },
          ],
        },
      }),
    );
    global.fetch = fetchMock as typeof fetch;

    const record = providerRecord('bing', { country: 'en-US', safeSearch: 'strict' });
    const out = await callWebSearchProvider(record, { apiKey: 'k' }, { query: 'hello', count: 5 });

    expect(out.results).toEqual([
      { title: 'Result A', url: 'https://a.example', snippet: 'AA', position: 1, publishedAt: '2026-01-01' },
      { title: 'Result B', url: 'https://b.example', snippet: 'BB', position: 2, publishedAt: undefined },
    ]);

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://api.bing.microsoft.com/v7.0/search');
    expect(calledUrl.searchParams.get('q')).toBe('hello');
    expect(calledUrl.searchParams.get('count')).toBe('5');
    expect(calledUrl.searchParams.get('mkt')).toBe('en-US');
    expect(calledUrl.searchParams.get('safeSearch')).toBe('Strict');
    expect(fetchMock.mock.calls[0][1].headers['Ocp-Apim-Subscription-Key']).toBe('k');
  });

  it('surfaces provider HTTP errors with status and body excerpt', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('quota exceeded', { status: 429 })) as typeof fetch;
    await expect(
      callWebSearchProvider(providerRecord('bing'), { apiKey: 'k' }, { query: 'x' }),
    ).rejects.toThrow(/Bing search failed \(429\): quota exceeded/);
  });
});

describe('Tavily normalization', () => {
  it('returns answer and scored results', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        answer: 'The answer.',
        results: [{ title: 'T', url: 'https://t.example', content: 'C', score: 0.9 }],
      }),
    ) as typeof fetch;

    const out = await callWebSearchProvider(
      providerRecord('tavily', { includeAnswer: true }),
      { apiKey: 'k' },
      { query: 'q' },
    );
    expect(out.answer).toBe('The answer.');
    expect(out.results[0]).toMatchObject({ title: 'T', url: 'https://t.example', snippet: 'C', score: 0.9 });
  });
});

describe('SearxNG', () => {
  it('goes through safeFetch (tenant-provided URL → SSRF guard) and truncates to count', async () => {
    (safeFetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({
        results: [
          { title: 'R1', url: 'https://r1.example', content: 'c1', engine: 'google' },
          { title: 'R2', url: 'https://r2.example', content: 'c2', engine: 'bing' },
          { title: 'R3', url: 'https://r3.example', content: 'c3', engine: 'brave' },
        ],
      }),
    );

    const record = providerRecord('searxng', { baseUrl: 'https://searx.internal.example/' });
    const out = await callWebSearchProvider(record, {}, { query: 'q', count: 2 });

    expect(safeFetch).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(String((safeFetch as ReturnType<typeof vi.fn>).mock.calls[0][0]));
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://searx.internal.example/search');
    expect(calledUrl.searchParams.get('format')).toBe('json');
    expect(out.results).toHaveLength(2);
    expect(out.results[0].source).toBe('google');
  });

  it('sends basic auth when credentials are configured', async () => {
    (safeFetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ results: [] }));
    await callWebSearchProvider(
      providerRecord('searxng', { baseUrl: 'https://searx.example' }),
      { authUsername: 'user', authPassword: 'pass' },
      { query: 'q' },
    );
    const init = (safeFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );
  });
});

describe('parseDuckDuckGoHtml', () => {
  const SAMPLE = `
    <div class="result results_links">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example <b>Title</b></a>
      <a class="result__snippet" href="#">This is the <b>snippet</b> text.</a>
    </div>
    <div class="result results_links">
      <a rel="nofollow" class="result__a" href="https://direct.example/doc">Direct Link</a>
      <a class="result__snippet" href="#">Second snippet.</a>
    </div>
  `;

  it('extracts titles, decoded URLs and snippets', () => {
    const results = parseDuckDuckGoHtml(SAMPLE, 10);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Example Title');
    expect(results[0].url).toBe('https://example.com/page');
    expect(results[0].snippet).toContain('snippet');
    expect(results[1].url).toBe('https://direct.example/doc');
    expect(results[1].position).toBe(2);
  });

  it('honors the limit', () => {
    expect(parseDuckDuckGoHtml(SAMPLE, 1)).toHaveLength(1);
  });

  it('returns empty on markup without results', () => {
    expect(parseDuckDuckGoHtml('<html><body>No results.</body></html>', 5)).toEqual([]);
  });
});
