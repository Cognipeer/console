import { describe, expect, it, vi, afterEach } from 'vitest';
import { createOpenAiModerationRuntime } from '@/lib/providers/contracts/openaiModerationHelpers';
import { UpstreamRequestError } from '@/lib/providers/contracts/upstreamError';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const stubUpstream = (body: unknown, status = 200) => {
  const spy = vi.fn(async (_url: unknown, _init?: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
};

const runtime = (overrides: Partial<Parameters<typeof createOpenAiModerationRuntime>[0]> = {}) =>
  createOpenAiModerationRuntime({
    apiKey: 'sk-test',
    baseUrl: 'https://upstream/v1',
    modelId: 'omni-moderation-latest',
    ...overrides,
  });

describe('createOpenAiModerationRuntime', () => {
  it('maps OpenAI flags and scores onto the shared verdict shape', async () => {
    stubUpstream({
      model: 'omni-moderation-latest',
      results: [
        {
          flagged: true,
          categories: { hate: true, violence: false },
          category_scores: { hate: 0.91, violence: 0.002 },
        },
      ],
      usage: { input_tokens: 7, total_tokens: 7 },
    });

    const out = await runtime().classify(['some text']);

    expect(out.model).toBe('omni-moderation-latest');
    expect(out.results[0].flagged).toBe(true);
    expect(out.results[0].categories.hate).toEqual({ flagged: true, score: 0.91 });
    expect(out.results[0].categories.violence).toEqual({ flagged: false, score: 0.002 });
    expect(out.usage).toEqual({ inputTokens: 7, totalTokens: 7 });
  });

  it('still reports a verdict when the upstream omits scores', async () => {
    stubUpstream({ results: [{ flagged: true, categories: { hate: true } }] });
    const out = await runtime().classify(['x']);
    expect(out.results[0].categories.hate).toEqual({ flagged: true });
  });

  it('sends every input in one call', async () => {
    const spy = stubUpstream({ results: [{ flagged: false, categories: {} }, { flagged: false, categories: {} }] });
    await runtime().classify(['a', 'b']);

    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ model: 'omni-moderation-latest', input: ['a', 'b'] });
  });

  it('carries the upstream status out on failure, so the gateway can map it', async () => {
    stubUpstream({ error: { message: 'slow down' } }, 429);
    await expect(runtime().classify(['x'])).rejects.toMatchObject({
      name: 'UpstreamRequestError',
      status: 429,
    });
    await expect(runtime().classify(['x'])).rejects.toBeInstanceOf(UpstreamRequestError);
  });

  it('honours a deployment-scoped URL and header (Azure)', async () => {
    const spy = stubUpstream({ results: [] });
    await runtime({
      extraHeaders: { 'api-key': 'azure-key' },
      buildUrl: (path) => `https://azure/openai/deployments/mod${path}?api-version=x`,
    }).classify(['x']);

    expect(spy.mock.calls[0][0]).toBe('https://azure/openai/deployments/mod/moderations?api-version=x');
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['api-key']).toBe('azure-key');
  });
});
