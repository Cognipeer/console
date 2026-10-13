import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  handleChatCompletion,
  handleEmbeddingRequest,
  OutputTokenLimitError,
} from '@/lib/services/models/inferenceService';
import { handleDecisionRequest } from '@/lib/services/models/decisionService';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import {
  chunk,
  completion,
  controlledStream,
  flush,
  json,
  openAiRuntime,
  readSse,
  sse,
  stubUpstream,
} from '../helpers/nativeGateway';

// ---- mocks ----
// The network is the only thing scripted: the REAL provider contract, the REAL
// agent-sdk provider and the REAL adapter run, so what is asserted below is the
// wire request the upstream received and what the gateway handed back.
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/decisionService', () => ({
  handleDecisionRequest: vi.fn(),
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: vi.fn(),
}));

vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return {
    ...original,
    // calculateCost stays REAL (pure, deterministic) so the budget-settlement
    // tests below exercise the same arithmetic production traffic gets, not a
    // stand-in that always returns some fixed number.
    logModelUsage: vi.fn().mockResolvedValue(undefined),
  };
});

// Routing history / counters are I/O (shared cache + usage_daily); the
// decisions built on them are what is under test here.
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockImplementation(async (_db: string, _p: string, keys: string[]) =>
    new Map(keys.map((k) => [k, null]))),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({ action: 'allow', findings: [] }),
  // The gate's own behaviour (hold-back windows, overlap scanning, mutation
  // rebasing) is covered by guardrail-stream-gate.test.ts against the real
  // implementation. What is under test HERE is the wiring: which frames the
  // inference service writes, in what order, and what it logs - so the gate is
  // a stub whose emissions the test dictates. The real one resolves guardrail
  // records from the database, which this unit test has no business reaching.
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { isSemanticCacheEnabled, lookupCache, storeInCache } from '@/lib/services/models/semanticCacheService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { getConversationState, getRouterSpendUsd } from '@/lib/services/models/dynamicRoutingState';
import { createStreamGate, evaluateGuardrail } from '@/lib/services/guardrail';

// ---- helpers ----
const makeLlmModel = (overrides = {}) => ({
  _id: 'model-id-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'GPT-4o',
  key: 'gpt-4o',
  providerKey: 'openai-main',
  providerDriver: 'openai',
  category: 'llm' as const,
  modelId: 'gpt-4o',
  settings: {},
  pricing: { inputPer1k: 0.01, outputPer1k: 0.03 },
  ...overrides,
});

const makeEmbeddingModel = (overrides = {}) => ({
  _id: 'model-id-2',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'text-embedding-3-small',
  key: 'embedding-model',
  providerKey: 'openai-main',
  providerDriver: 'openai',
  category: 'embedding' as const,
  modelId: 'text-embedding-3-small',
  settings: {},
  pricing: { inputPer1k: 0.0001, outputPer1k: 0 },
  ...overrides,
});

const makeEmbeddingRuntime = (embedResult?: number[][]) => ({
  createEmbeddingModel: vi.fn().mockResolvedValue({
    embedDocuments: vi.fn().mockResolvedValue(embedResult ?? [[0.1, 0.2, 0.3]]),
  }),
});

/**
 * A scripted stand-in for the real stream gate.
 *
 * `push` consumes one entry of `pushes` per call; 'passthrough' re-emits the
 * chunk untouched, which is what a gate with no streaming enforcement
 * configured does and therefore the right default for every other test in this
 * file.
 */
type StubEmission = { emit: unknown[]; blocked: boolean; verdict?: unknown };

const makeGateStub = (script: {
  pushes?: Array<StubEmission | 'passthrough'>;
  end?: StubEmission;
} = {}) => {
  const pushes = [...(script.pushes ?? [])];
  return {
    push: vi.fn(async (frame: unknown) => {
      const next = pushes.shift() ?? 'passthrough';
      return next === 'passthrough' ? { emit: [frame], blocked: false } : next;
    }),
    flush: vi.fn(async () => ({ emit: [], blocked: false })),
    end: vi.fn(async () => script.end ?? { emit: [], blocked: false }),
    abandon: vi.fn(),
    pendingChars: 0,
    bufferedText: '',
    heldText: '',
    isBlocked: false,
    isDegraded: false,
  };
};

const BASE_PARAMS = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  modelKey: 'gpt-4o',
  projectId: 'proj-1',
};

let runtime: ModelProviderRuntime;
beforeAll(async () => {
  runtime = await openAiRuntime();
});

/** The provider runtime of every model in a test: the real OpenAI contract. */
const useRuntime = () => {
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime });
};

const useModel = (model: object) => {
  (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
};

/** Parsed `data:` payloads of an SSE body, minus the sentinel. */
const dataFrames = (body: string) =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));

// ---- tests ----
describe('handleChatCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
    (storeInCache as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (logModelUsage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => makeGateStub());
    useRuntime();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when messages is missing', async () => {
    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: {} }),
    ).rejects.toThrow('`messages` array is required');
  });

  it('throws when messages is not an array', async () => {
    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: 'hello' } }),
    ).rejects.toThrow('`messages` array is required');
  });

  it('throws when model is not found', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: [] } }),
    ).rejects.toThrow('Model with key gpt-4o not found');
  });

  it('throws when model category is not llm', async () => {
    useModel(makeEmbeddingModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(),
    });

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: [] } }),
    ).rejects.toThrow('Model is not configured for chat completions');
  });

  it('throws when runtime has no native chat client', async () => {
    useModel(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {},
    });

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: [] } }),
    ).rejects.toThrow('Model provider does not support chat completions');
  });

  it('propagates a failure to build the provider client', async () => {
    useModel(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createNativeChatClient: vi.fn().mockRejectedValue(new Error('provider misconfigured')),
      },
    });

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: [] } }),
    ).rejects.toThrow('provider misconfigured');
  });

  it('returns response on successful non-streaming completion', async () => {
    const model = makeLlmModel();
    useModel(model);
    const upstream = stubUpstream(() => json(completion({
      content: 'Hi!',
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    })));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(result).toMatchObject({
      cacheHit: false,
      requestId: expect.any(String),
      latencyMs: expect.any(Number),
    });
    expect(result.response).toMatchObject({
      id: expect.stringMatching(/^chatcmpl-[0-9a-f]{32}$/),
      object: 'chat.completion',
      // The MODEL's id, never what the upstream called itself.
      model: 'gpt-4o',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi!' } }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].body).toMatchObject({ model: 'gpt-4o', stream: false, messages: [{ role: 'user', content: 'Hello' }] });
    await flush();
    expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme',
      model,
      expect.objectContaining({
        route: 'chat.completions',
        status: 'success',
        cacheHit: false,
      }),
    );
  });

  it('settles the budget with the realized cost for a non-streaming completion too (F-05)', async () => {
    useModel(makeLlmModel({ pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 } }));
    stubUpstream(() => json(completion({
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    })));

    const onUsageSettled = vi.fn();
    await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Hello' }] },
      onUsageSettled,
    });

    expect(onUsageSettled).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD', totalCost: 0.007 }),
    );
  });

  it('forwards finishReason and reasoningTokens to logModelUsage without perturbing totalTokens', async () => {
    // reasoningTokens is a SUBSET of outputTokens - it must reach logModelUsage
    // as its own field, and totalTokens must stay exactly what the upstream
    // reported (inputTokens + outputTokens), never inflated by reasoningTokens.
    const model = makeLlmModel();
    useModel(model);
    stubUpstream(() => json(completion({
      content: 'Hi!',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 8 },
      },
    })));

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Hello' }] },
    });
    await flush();

    expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme',
      model,
      expect.objectContaining({
        finishReason: 'stop',
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          reasoningTokens: 8,
        }),
      }),
    );
  });

  it('shows the reasoning as a subset of completion tokens on the wire', async () => {
    useModel(makeLlmModel());
    stubUpstream(() => json(completion({
      content: 'Hi!',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 8 },
      },
    })));

    const { response } = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(response?.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      cached_tokens: 4,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 8 },
    });
  });

  it('passes canonical OpenAI vision content to the provider', async () => {
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => json(completion({ content: 'A small image' })));
    const imageUrl = 'data:image/png;base64,iVBORw0KGgo=';

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: imageUrl },
          ],
        }],
      },
    });

    expect(upstream.calls[0].body.messages[0].content).toEqual([
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ]);
  });

  it('rejects an image part without a URL before any provider is called', async () => {
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => json(completion()));

    await expect(handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: ' ' } }] }] },
    })).rejects.toThrow('`messages[0].content[0].image_url` must be a non-empty string');
    expect(upstream.calls).toHaveLength(0);
  });

  it('uses provided request_id in response', async () => {
    useModel(makeLlmModel());
    stubUpstream(() => json(completion()));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], request_id: 'my-custom-id' },
    });

    expect(result.requestId).toBe('my-custom-id');
  });

  it('generates a UUID when request_id is not provided', async () => {
    useModel(makeLlmModel());
    stubUpstream(() => json(completion()));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
    });

    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('returns cached response when semantic cache hits', async () => {
    const model = makeLlmModel({
      semanticCache: { indexKey: 'cache-idx', threshold: 0.9 },
    });
    const cachedResponse = { id: 'cached-1', choices: [] };
    useModel(model);
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({
      hit: true,
      response: cachedResponse,
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Cached query' }] },
      stream: false,
    });

    expect(result).toMatchObject({
      cacheHit: true,
      response: cachedResponse,
    });
    expect(buildModelRuntime).not.toHaveBeenCalled();
    await flush();
    expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme',
      model,
      expect.objectContaining({ cacheHit: true }),
    );
  });

  it('calls runtime when semantic cache misses', async () => {
    const model = makeLlmModel({
      semanticCache: { indexKey: 'cache-idx', threshold: 0.9 },
    });
    useModel(model);
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
    stubUpstream(() => json(completion()));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Cache miss query' }] },
    });

    expect(result.cacheHit).toBe(false);
    expect(buildModelRuntime).toHaveBeenCalled();
    // storeInCache should be called after successful non-streaming completion
    expect(storeInCache).toHaveBeenCalled();
  });

  it('proceeds with model call when semantic cache lookup throws', async () => {
    const model = makeLlmModel({
      semanticCache: { indexKey: 'cache-idx', threshold: 0.9 },
    });
    useModel(model);
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (lookupCache as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cache timeout'));
    stubUpstream(() => json(completion()));

    // Should not throw - cache error is swallowed with a warning
    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
    });

    expect(result.cacheHit).toBe(false);
    expect(buildModelRuntime).toHaveBeenCalled();
  });

  it('returns a ReadableStream for streaming requests', async () => {
    useModel(makeLlmModel());
    stubUpstream(() => sse([chunk.text('Hello'), chunk.text(' World')]));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
      stream: true,
    });

    expect(result).toHaveProperty('stream');
    expect(result).toHaveProperty('requestId');
    expect(result.stream).toBeInstanceOf(ReadableStream);
    await readSse(result.stream!);
  });

  it('settles the budget with the realized cost once a stream completes (F-05)', async () => {
    // Regression for the 2026-09-05 assessment's F-05: streaming usage was
    // logged via logModelUsage, but nothing fed it back into the budget
    // counter. A caller that wants the real cost has to be told through
    // `onUsageSettled`, since it isn't known until the stream this function
    // already returned finishes.
    useModel(makeLlmModel({ pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 } }));
    stubUpstream(() => sse([
      chunk.text('Hello'),
      chunk.finish('stop'),
      chunk.usage({ prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 }),
    ]));

    const onUsageSettled = vi.fn();
    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], stream_options: { include_usage: true } },
      stream: true,
      onUsageSettled,
    });
    await readSse(result.stream!);
    await flush();

    // 100 input tokens @ $10/1M + 200 output tokens @ $30/1M = $0.001 + $0.006
    expect(onUsageSettled).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD', totalCost: 0.007 }),
    );
  });

  it('asks the upstream for stream usage and emits it as a final usage-only chunk when requested', async () => {
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => sse([
      chunk.text('Hello'),
      chunk.finish('stop'),
      chunk.usage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
    ]));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], stream_options: { include_usage: true } },
      stream: true,
    });
    const chunks = dataFrames((await readSse(result.stream!)).raw);

    expect(upstream.calls[0].body.stream_options).toEqual({ include_usage: true });
    expect(chunks[0].usage).toBeUndefined();
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });

  it('logs the terminal finish_reason and reasoningTokens from the final stream usage frame, without perturbing totalTokens', async () => {
    // reasoningTokens is a SUBSET of completion_tokens (outputTokens) - it must
    // reach logModelUsage as its own field, and totalTokens must stay exactly
    // what the final usage frame reported, never inflated by reasoningTokens.
    useModel(makeLlmModel());
    stubUpstream(() => sse([
      chunk.text('Hello'),
      chunk.finish('length'),
      chunk.usage({
        prompt_tokens: 5,
        completion_tokens: 12,
        total_tokens: 17,
        completion_tokens_details: { reasoning_tokens: 9 },
      }),
    ]));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], stream_options: { include_usage: true } },
      stream: true,
    });
    await readSse(result.stream!);
    await flush();

    expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme',
      expect.anything(),
      expect.objectContaining({
        route: 'chat.completions',
        status: 'success',
        finishReason: 'length',
        usage: expect.objectContaining({
          inputTokens: 5,
          outputTokens: 12,
          totalTokens: 17,
          reasoningTokens: 9,
        }),
      }),
    );
  });

  it('never puts usage on a delta when include_usage was not requested', async () => {
    // OpenAI only emits `usage` when the caller asks for it, and then only on a
    // trailing choices-less frame. The upstream is still asked for it (the
    // usage row needs the real counts), but it never reaches the caller.
    useModel(makeLlmModel());
    stubUpstream(() => sse([
      chunk.text('Hello'),
      chunk.finish('stop'),
      chunk.usage({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
    ]));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
      stream: true,
    });
    const { raw, frames } = await readSse(result.stream!);
    const chunks = frames.filter((frame) => frame !== '[DONE]');

    expect(chunks.every((frame) => frame.usage === undefined)).toBe(true);
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // The opening role frame carries the id the whole completion reuses.
    expect(chunks[0].id).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
    expect(new Set(chunks.map((frame) => frame.id)).size).toBe(1);
  });

  it('streams a tool-carrying request frame by frame rather than in one shot', async () => {
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => sse([chunk.text('one'), chunk.text('two'), chunk.text('three')]));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        tools: [{
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        }],
      },
      stream: true,
    });
    const contents = dataFrames((await readSse(result.stream!)).raw)
      .map((frame) => frame.choices?.[0]?.delta?.content)
      .filter((content) => typeof content === 'string' && content.length > 0);

    expect(contents).toEqual(['one', 'two', 'three']);
    // One streamed upstream call - not an eager completion replayed as a stream.
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].body.stream).toBe(true);
  });

  describe('JSON mode - repairing a malformed provider response', () => {
    const setup = (content: string) => {
      useModel(makeLlmModel());
      stubUpstream(() => json(completion({ content })));
    };

    const run = (responseFormat?: unknown) =>
      handleChatCompletion({
        ...BASE_PARAMS,
        body: {
          messages: [{ role: 'user', content: 'json please' }],
          ...(responseFormat ? { response_format: responseFormat } : {}),
        },
      });

    const contentOf = (out: Awaited<ReturnType<typeof handleChatCompletion>>) =>
      (out as unknown as { response: { choices: Array<{ message: { content: unknown } }> } })
        .response.choices[0].message.content;

    // Verbatim from bedrock-runtime eu-central-1, `openai.gpt-oss-120b-1:0`
    // with response_format json_object: the decoder stranded a bare `{`.
    const BROKEN = '{\n{"city":"Istanbul","ok":true}';

    it('recovers the payload when the caller asked for json_object', async () => {
      setup(BROKEN);
      expect(contentOf(await run({ type: 'json_object' }))).toBe('{"city":"Istanbul","ok":true}');
    });

    it('recovers the payload when the caller asked for json_schema', async () => {
      setup('Sounds{   "city":"Istanbul",   "tempC":22 }');
      expect(contentOf(await run({ type: 'json_schema', json_schema: { name: 'w', schema: {} } })))
        .toBe('{   "city":"Istanbul",   "tempC":22 }');
    });

    it('leaves the answer alone when no JSON was requested', async () => {
      setup(BROKEN);
      expect(contentOf(await run())).toBe(BROKEN);
    });

    it('does not reformat a response that already parses', async () => {
      const clean = '{\n  "city": "Istanbul"\n}';
      setup(clean);
      expect(contentOf(await run({ type: 'json_object' }))).toBe(clean);
    });

    it('passes through text with nothing recoverable in it', async () => {
      setup('the provider gave up');
      expect(contentOf(await run({ type: 'json_object' }))).toBe('the provider gave up');
    });

    it('sends the caller response_format to the upstream verbatim, strict flag included', async () => {
      useModel(makeLlmModel());
      const upstream = stubUpstream(() => json(completion({ content: '{"a":1}' })));
      const responseFormat = {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: false, schema: { type: 'object', properties: { a: { type: 'number' } } } },
      };

      await run(responseFormat);

      expect(upstream.calls[0].body.response_format).toEqual(responseFormat);
    });
  });

  describe('client disconnects mid-stream', () => {
    const startCancellableStream = async (
      modelOverrides = {},
      onUsageSettled?: (cost: { currency: string; totalCost: number }) => void,
    ) => {
      useModel(makeLlmModel(modelOverrides));
      let live: ReturnType<typeof controlledStream> | undefined;
      const upstream = stubUpstream((call) => {
        live = controlledStream(call.signal);
        live.send(chunk.text('partial answer'));
        // Stays open so the consumer's cancel lands mid-stream; the abort then
        // surfaces the way a socket error does.
        return live.response;
      });

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
        onUsageSettled,
      });

      const reader = result.stream!.getReader();
      await reader.read();
      await reader.read();
      await reader.cancel('client gone');
      // Let the aborted iterator unwind and the fire-and-forget log settle.
      await new Promise((resolve) => { setTimeout(resolve, 80); });
      return { call: (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1), upstream };
    };

    it('records the call as cancelled, not as a provider error', async () => {
      // Pressing stop is not an outage. Logging it as one drove the error rate
      // and its alerting off user behaviour rather than provider health.
      const { call, upstream } = await startCancellableStream();

      expect(call?.[2]).toMatchObject({ status: 'cancelled', route: 'chat.completions' });
      expect(call?.[2].errorMessage).toBeUndefined();
      // The upstream request itself was cut loose.
      expect(upstream.calls[0].signal?.aborted).toBe(true);
    });

    it('still bills the output the provider generated before the client left', async () => {
      // The provider charges for what it produced; recording zero wrote it off.
      const { call } = await startCancellableStream();

      expect(call?.[2].usage.outputTokens).toBeGreaterThan(0);
      expect(call?.[2].providerResponse).toMatchObject({
        cancelled: 'client_disconnected',
        output_tokens_estimated: true,
      });
    });

    it('settles the budget for the partial usage too - the provider still billed for it (F-05)', async () => {
      const onUsageSettled = vi.fn();
      await startCancellableStream(
        { pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 } },
        onUsageSettled,
      );

      expect(onUsageSettled).toHaveBeenCalledTimes(1);
      const [cost] = onUsageSettled.mock.calls[0];
      expect(cost.currency).toBe('USD');
      expect(cost.totalCost).toBeGreaterThan(0);
    });

    it('still audits the output guardrail over the text that was delivered', async () => {
      // Text the caller already received has to be audited whether or not they
      // stayed for the rest, otherwise hanging up is a way to skip the audit.
      await startCancellableStream({ outputGuardrailKey: 'no-pii' });

      expect(evaluateGuardrail).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailKey: 'no-pii',
          phase: 'output',
          text: expect.stringContaining('partial answer'),
          source: 'chat.completions:stream:cancelled',
        }),
      );
    });

    it('honours an AbortSignal handed in by an in-process caller the same way', async () => {
      useModel(makeLlmModel());
      stubUpstream((call) => {
        const live = controlledStream(call.signal);
        live.send(chunk.text('partial'));
        return live.response;
      });
      const controller = new AbortController();

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
        signal: controller.signal,
      });
      const reader = result.stream!.getReader();
      await reader.read();
      await reader.read();
      controller.abort();
      await new Promise((resolve) => { setTimeout(resolve, 60); });

      expect((logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2]).toMatchObject({ status: 'cancelled' });
    });
  });

  describe('real-time streaming guardrail enforcement', () => {
    const BLOCK_VERDICT = {
      guardrailKey: 'no-pii',
      codes: ['pii.email'],
      riskScore: 90,
      message: {
        reasonClass: 'pii',
        body: 'Response withheld: it contained personal data.',
        mode: 'error',
        status: 400,
        traceId: 'trace-1',
      },
    };

    /** Streams `chunks` and reports whether the upstream call was aborted. */
    const startGatedStream = async (chunks: string[], modelOverrides = {}) => {
      useModel(makeLlmModel({ outputGuardrailKey: 'no-pii', ...modelOverrides }));
      const upstream = stubUpstream(() => sse(chunks.map((content) => chunk.text(content))));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
      });
      const body = (await readSse(result.stream!)).raw;
      // Let the fire-and-forget usage log and guardrail audit settle.
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return { body, result, upstream };
    };

    const frames = (body: string) =>
      body
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));

    it('is not constructed for a model with no output guardrail', () => {
      // Building a gate for an empty key list buys a pass-through wrapper and
      // an allocation per chunk, and nothing else.
      return startGatedStream(['hello'], { outputGuardrailKey: undefined }).then(() => {
        expect(createStreamGate).not.toHaveBeenCalled();
      });
    });

    it('scopes the gate to this model, this project and the gateway surface', async () => {
      await startGatedStream(['hello']);

      expect(createStreamGate).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailKeys: ['no-pii'],
          // The terminal output.pre pass stays with auditStreamedOutput, so the
          // gate must not schedule a second one for the same answer.
          audit: false,
          scope: expect.objectContaining({
            tenantId: 'tenant-1',
            tenantDbName: 'tenant_acme',
            projectId: 'proj-1',
            surface: 'gateway',
            source: 'chat.completions:stream',
          }),
        }),
      );
    });

    it('hands the gate OpenAI frames and writes back what it releases', async () => {
      (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => makeGateStub());
      await startGatedStream(['safe part']);

      const gate = (createStreamGate as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(gate.push).toHaveBeenCalledWith(
        expect.objectContaining({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'safe part' }, finish_reason: null }],
        }),
      );
      expect(gate.end).toHaveBeenCalledTimes(1);
    });

    it('closes the stream on a block before it aborts the upstream, so the block is not filed as a hang-up', async () => {
      // THE regression this whole path exists to avoid: aborting first makes
      // the provider iterator throw into the catch, which sees an aborted
      // signal, logs `status: 'cancelled'` and returns - leaving the client
      // with a truncated stream and the usage row blaming the user.
      (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeGateStub({
          pushes: ['passthrough', { emit: [], blocked: true, verdict: BLOCK_VERDICT }],
        }),
      );

      const { body, result, upstream } = await startGatedStream(['safe part', 'leaked@example.com']);
      const payloads = frames(body);

      // The full terminal sequence reached the socket...
      expect(payloads.at(-1)).toBe('[DONE]');
      expect(JSON.parse(payloads[0]).choices[0].delta).toMatchObject({ role: 'assistant' });
      expect(JSON.parse(payloads[1]).choices[0].delta.content).toBe('safe part');
      expect(JSON.parse(payloads[2]).choices[0].finish_reason).toBe('content_filter');
      expect(JSON.parse(payloads[3])).toEqual({
        guardrail: { blocked: true, discardPrior: true },
      });
      expect(JSON.parse(payloads[4])).toMatchObject({
        error: {
          type: 'guardrail_block',
          code: 'pii',
          message: BLOCK_VERDICT.message.body,
          guardrail_key: 'no-pii',
        },
      });
      // ...and only then was the provider cut loose.
      expect(upstream.calls[0].signal?.aborted).toBe(true);
      // Half an answer is already on screen; the caller has to be told.
      expect(result.streamHeaders).toEqual({ 'x-guardrail-partial': 'true' });

      const log = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(log?.[2]).toMatchObject({
        status: 'error',
        finishReason: 'content_filter',
        errorMessage: BLOCK_VERDICT.message.body,
      });
      expect(log?.[2].status).not.toBe('cancelled');
      // The provider generated these tokens whether or not we delivered them.
      expect(log?.[2].usage.outputTokens).toBeGreaterThan(0);
    });

    it('omits the partial markers when nothing had been released yet', async () => {
      // A block that lands before the first character is a clean refusal, not a
      // half-rendered answer - telling the client to discard a prefix it never
      // received would be noise.
      (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeGateStub({ pushes: [{ emit: [], blocked: true, verdict: BLOCK_VERDICT }] }),
      );

      const { body, result } = await startGatedStream(['leaked@example.com']);

      expect(body).not.toContain('discardPrior');
      expect(result.streamHeaders).toEqual({});
      expect(body).toContain('"finish_reason":"content_filter"');
      expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    it('still records exactly one post-hoc audit for a blocked answer', async () => {
      // The gate is built with `audit: false`, so this call is the answer's
      // only evaluation row - and it covers the withheld text too, because it
      // audits what the PROVIDER produced.
      (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeGateStub({
          pushes: ['passthrough', { emit: [], blocked: true, verdict: BLOCK_VERDICT }],
        }),
      );

      await startGatedStream(['safe part', 'leaked@example.com']);

      expect(evaluateGuardrail).toHaveBeenCalledTimes(1);
      expect(evaluateGuardrail).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailKey: 'no-pii',
          phase: 'output',
          source: 'chat.completions:stream',
          text: expect.stringContaining('leaked@example.com'),
        }),
      );
    });

    it('releases the tail the gate is still holding when the provider sends no finish_reason', async () => {
      // Without the terminal `end()` the hold-back window would simply never be
      // released: the last sentence of every answer would go missing.
      const heldFrame = {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: ' the held tail' }, finish_reason: null }],
      };
      (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeGateStub({
          pushes: [{ emit: [], blocked: false }],
          end: { emit: [heldFrame], blocked: false },
        }),
      );

      const { body } = await startGatedStream(['the held tail']);
      const payloads = frames(body);

      expect(JSON.parse(payloads[1]).choices[0].delta.content).toBe(' the held tail');
      // The synthesised stop frame still comes after it, and last of all [DONE].
      expect(JSON.parse(payloads[2]).choices[0].finish_reason).toBe('stop');
      expect(payloads.at(-1)).toBe('[DONE]');
    });

    it('blocks on the final window too', async () => {
      // `end()` adjudicates the tail with no hold-back left, so it is the last
      // chance for a violation to be caught - and it has to take the same exit.
      (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeGateStub({
          pushes: [{ emit: [], blocked: false }],
          end: { emit: [], blocked: true, verdict: BLOCK_VERDICT },
        }),
      );

      const { body, upstream } = await startGatedStream(['leaked@example.com']);

      expect(body).toContain('"finish_reason":"content_filter"');
      expect(body).toContain('"type":"guardrail_block"');
      expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
      expect(upstream.calls[0].signal?.aborted).toBe(true);
      expect(
        (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2],
      ).toMatchObject({ status: 'error', finishReason: 'content_filter' });
    });

    it('lets a consumer that stops reading right after the block still get the abort and the row', async () => {
      // The generator's own `finally` is the backstop for a consumer that quits
      // after the terminal event: the upstream must be cut loose and the block
      // must still be logged exactly once.
      (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() =>
        makeGateStub({ pushes: [{ emit: [], blocked: true, verdict: BLOCK_VERDICT }] }),
      );
      useModel(makeLlmModel({ outputGuardrailKey: 'no-pii' }));
      const upstream = stubUpstream(() => sse([chunk.text('leaked@example.com'), chunk.text(' more')]));
      const { executeModelCall } = await import('@/lib/services/models/inferenceService');

      const outcome = await executeModelCall({
        ...BASE_PARAMS,
        request: { messages: [{ role: 'user', content: 'hi' }] },
        stream: true,
      });
      const seen: string[] = [];
      for await (const event of outcome.stream!) {
        seen.push(event.type);
        if (event.type === 'blocked') break;
      }
      await flush();

      expect(seen).toEqual(['start', 'blocked']);
      expect(upstream.calls[0].signal?.aborted).toBe(true);
      const rows = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);
      expect(rows.filter((row) => row.finishReason === 'content_filter')).toHaveLength(1);
    });
  });

  it('forwards each frame as the provider produces it, without collecting the answer first', async () => {
    // The distinction that matters to a caller: do we relay the provider's
    // chunks as they land, or wait for the completion and replay it? Assert the
    // first content frame is readable *before* the provider has finished
    // producing - a buffered implementation cannot satisfy that.
    useModel(makeLlmModel());
    const GAP_MS = 40;
    const CHUNKS = 5;
    let producerFinishedAt = Number.POSITIVE_INFINITY;
    stubUpstream((call) => {
      const live = controlledStream(call.signal);
      void (async () => {
        for (let i = 0; i < CHUNKS; i += 1) {
          await new Promise((resolve) => { setTimeout(resolve, GAP_MS); });
          live.send(chunk.text(`tok${i}`));
        }
        producerFinishedAt = Date.now();
        live.end();
      })();
      return live.response;
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
      stream: true,
    });

    const reader = result.stream!.getReader();
    const decoder = new TextDecoder();
    let firstContentAt = Number.POSITIVE_INFINITY;
    let lastContentAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (!text.includes('tok')) continue;
      firstContentAt = Math.min(firstContentAt, Date.now());
      lastContentAt = Date.now();
    }

    expect(firstContentAt).toBeLessThan(producerFinishedAt);
    expect(lastContentAt - firstContentAt).toBeGreaterThanOrEqual(GAP_MS);
  });

  it('emits an explanatory SSE error when output budget ends without an answer', async () => {
    useModel(makeLlmModel({ settings: { maxTokens: 512 } }));
    stubUpstream(() => sse([
      chunk.finish('length'),
      chunk.usage({ prompt_tokens: 100, completion_tokens: 512, total_tokens: 612 }),
    ]));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], stream_options: { include_usage: true } },
      stream: true,
    });
    const { raw, frames } = await readSse(result.stream!);
    const payload = frames.find((frame) => frame !== '[DONE]' && frame.error);

    expect(payload.error).toMatchObject({
      type: 'output_token_limit_exceeded',
      code: 'output_token_limit_exceeded',
      param: 'max_completion_tokens',
    });
    expect(payload.error.message).toContain('512 tokens');
    expect(raw).not.toContain('"finish_reason":"length"');
    // No usage frame for a call that ended in an error frame.
    expect(frames.some((frame) => frame !== '[DONE]' && frame.usage)).toBe(false);
    // The error frame is still terminated: a client reading until the sentinel
    // must be released, not left waiting on the socket.
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await flush();
    expect((logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2]).toMatchObject({ status: 'error' });
  });

  it('emits a normalized SSE error when a provider stream fails', async () => {
    useModel(makeLlmModel());
    stubUpstream((call) => {
      const live = controlledStream(call.signal);
      live.send(chunk.text('Partial'));
      setTimeout(() => {
        live.fail(Object.assign(new Error('Provider rate limit reached'), {
          status: 429,
          code: 'rate_limit_exceeded',
        }));
      }, 10);
      return live.response;
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
      stream: true,
    });
    const { raw, frames } = await readSse(result.stream!);
    const payload = frames.find((frame) => frame !== '[DONE]' && frame.error);

    expect(payload.error).toMatchObject({
      message: 'Provider rate limit reached',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    });
    expect(payload.request_id).toBe(result.requestId);
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await flush();
    expect((logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2]).toMatchObject({ status: 'error' });
  });

  it('throws an output token limit error for an empty non-streaming length result', async () => {
    useModel(makeLlmModel({ settings: { maxTokens: 512 } }));
    stubUpstream(() => json(completion({ content: '', finish: 'length' })));

    await expect(handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
    })).rejects.toMatchObject({
      name: 'OutputTokenLimitError',
      limit: 512,
      message: expect.stringContaining('Reasoning models'),
    } satisfies Partial<OutputTokenLimitError>);
  });

  it('applies body overrides to the request the provider receives', async () => {
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => json(completion({ content: 'Hi' })));

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        temperature: 0.7,
        max_tokens: 256,
        stop: ['DONE'],
      },
    });

    expect(upstream.calls[0].body).toMatchObject({
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: 256,
      stop: ['DONE'],
    });
  });

  it('forwards parallel tool options and normalizes strict nested schemas', async () => {
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => json(completion({ content: '' })));

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        strict: true,
        parallel_tool_calls: true,
        tools: [{
          type: 'function',
          function: {
            name: 'lookup',
            parameters: {
              type: 'object',
              properties: {
                filters: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { key: { type: 'string' } },
                  },
                },
              },
            },
          },
        }],
      },
    });

    expect(upstream.calls[0].body.parallel_tool_calls).toBe(true);
    expect(upstream.calls[0].body.tools).toEqual([expect.objectContaining({
      type: 'function',
      function: expect.objectContaining({
        name: 'lookup',
        strict: true,
        parameters: expect.objectContaining({
          additionalProperties: false,
          properties: {
            filters: expect.objectContaining({
              items: expect.objectContaining({ additionalProperties: false }),
            }),
          },
        }),
      }),
    })]);
  });

  it('passes a non-function tool and the tool choice to an OpenAI-schema upstream verbatim', async () => {
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => json(completion({ content: 'ok' })));
    const hosted = { type: 'web_search_preview' };

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
        tools: [
          { type: 'function', function: { name: 'lookup', description: 'find', parameters: { type: 'object' } } },
          hosted,
        ],
      },
    });

    expect(upstream.calls[0].body.tools).toEqual([
      { type: 'function', function: { name: 'lookup', description: 'find', parameters: { type: 'object' } } },
      hosted,
    ]);
    expect(upstream.calls[0].body.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
  });

  it('keeps provider streaming on when a request carries tools', async () => {
    // Open WebUI (native function calling by default) and Onyx send `tools` on
    // essentially every chat request. Turning provider streaming off for them
    // collapsed the whole answer into one SSE frame - "streaming is broken".
    useModel(makeLlmModel());
    const upstream = stubUpstream(() => sse([chunk.text('hi')]));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        tools: [{
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        }],
      },
      stream: true,
    });
    await readSse(result.stream!);

    expect(upstream.calls[0].body.stream).toBe(true);
  });

  it('disables provider streaming for tool calls only when the model opts in', async () => {
    useModel(makeLlmModel({ settings: { disableStreamingWithTools: true } }));
    const upstream = stubUpstream(() => json(completion({
      content: '',
      toolCalls: [{ id: 'call_lookup', name: 'lookup', arguments: '{}' }],
    })));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        tools: [{
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        }],
      },
      stream: true,
    });
    const { frames } = await readSse(result.stream!);

    // One eager (non-streamed) upstream call, replayed to the caller as a stream.
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].body.stream).toBe(false);
    const toolDelta = frames.find((frame) => frame !== '[DONE]' && frame.choices?.[0]?.delta?.tool_calls);
    expect(toolDelta.choices[0].delta.tool_calls).toEqual([
      { index: 0, id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ]);
    expect(frames.some((frame) => frame !== '[DONE]' && frame.choices?.[0]?.finish_reason === 'tool_calls')).toBe(true);
  });

  it('emits an explanatory SSE error for an empty eager tool result', async () => {
    useModel(makeLlmModel({ settings: { maxTokens: 512, disableStreamingWithTools: true } }));
    const upstream = stubUpstream(() => json(completion({ content: '', finish: 'length' })));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        tools: [{
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        }],
      },
      stream: true,
    });
    const streamBody = (await readSse(result.stream!)).raw;

    expect(streamBody).toContain('"code":"output_token_limit_exceeded"');
    expect(streamBody).toContain('512 tokens');
    expect(streamBody).not.toContain('"finish_reason":"length"');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].body.stream).toBe(false);
  });


  // ── Multi-guardrail bindings ────────────────────────────────────────────
  //
  // A model may carry the ordered `guardrails` list or only the two legacy
  // slots. `resolveBindings` (the real module — it is pure, so it is NOT part
  // of the `@/lib/services/guardrail` mock above) decides which keys each hook
  // gets; what is under test here is what this service does with more than one.
  describe('multi-guardrail bindings', () => {
    /**
     * Answers per guardrail key, so a test can say "gr-a warns, gr-b blocks"
     * without knowing anything about the engine. The defaults reproduce a clean
     * pass, which is what the module-level mock gives every other test.
     */
    const scriptGuardrails = (
      byKey: Record<string, Record<string, unknown>> = {},
    ) => {
      (evaluateGuardrail as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ guardrailKey }: { guardrailKey: string }) => ({
          passed: true,
          // `blocked` is what `inferenceService` actually throws on — the
          // Mode-neutralised decision, not the `passed` counterfactual. Every
          // override below that sets `passed: false` sets this too, because
          // these fixtures model ENFORCING guardrails.
          blocked: false,
          action: 'allow',
          findings: [],
          guardrailKey,
          guardrailName: guardrailKey,
          ...(byKey[guardrailKey] ?? {}),
        }),
      );
    };

    const finding = (overrides: Record<string, unknown> = {}) => ({
      type: 'pii',
      category: 'email',
      message: 'email address',
      block: false,
      ...overrides,
    });

    const runCompletion = (
      modelOverrides: object,
      userText = 'my email is a@b.com',
    ) => {
      useModel(makeLlmModel(modelOverrides));
      stubUpstream(() => json(completion({ content: 'the answer' })));
      return handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [{ role: 'user', content: userText }] },
      });
    };

    const runStream = async (modelOverrides: object) => {
      useModel(makeLlmModel(modelOverrides));
      stubUpstream(() => sse([chunk.text('the answer')]));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
      });
      await readSse(result.stream!);
      // Let the fire-and-forget audit settle.
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    };

    // `vi.clearAllMocks()` clears CALLS, not implementations - so a scripted
    // guardrail left behind here would silently rewrite the tests that run
    // after this block.
    afterEach(() => {
      (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
        action: 'allow',
        findings: [],
      });
    });

    it('leaves a legacy single-slot model exactly as it was', async () => {
      // The production majority. One key per direction, one evaluation, and an
      // annotation with NO `results` array — a consumer reading
      // `guardrails.input.findings` must see what it saw before the hook plane.
      scriptGuardrails({ 'gr-legacy': { findings: [finding()] } });

      const result = await runCompletion({ inputGuardrailKey: 'gr-legacy' });

      expect(evaluateGuardrail).toHaveBeenCalledTimes(1);
      expect(evaluateGuardrail).toHaveBeenCalledWith(
        expect.objectContaining({ guardrailKey: 'gr-legacy', phase: 'input' }),
      );
      expect((result.response as { guardrails?: unknown }).guardrails).toEqual({
        input: { guardrail_key: 'gr-legacy', findings: [finding()] },
      });
    });

    it('projects a legacy output slot onto the non-streaming output check', async () => {
      scriptGuardrails({ 'gr-legacy': { findings: [finding()] } });

      const result = await runCompletion({ outputGuardrailKey: 'gr-legacy' });

      expect(evaluateGuardrail).toHaveBeenCalledTimes(1);
      expect(evaluateGuardrail).toHaveBeenCalledWith(
        expect.objectContaining({ guardrailKey: 'gr-legacy', phase: 'output' }),
      );
      expect((result.response as { guardrails?: unknown }).guardrails).toEqual({
        output: { guardrail_key: 'gr-legacy', findings: [finding()] },
      });
    });

    it('runs every guardrail bound to input.pre, in binding order', async () => {
      scriptGuardrails({
        'gr-a': { findings: [finding({ category: 'email' })] },
        'gr-b': { findings: [finding({ category: 'phone' })] },
      });

      const result = await runCompletion({
        guardrails: [
          { key: 'gr-a', hooks: ['input.pre'] },
          { key: 'gr-b', hooks: ['input.pre'] },
        ],
      });

      const keys = (evaluateGuardrail as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0].guardrailKey);
      expect(keys).toEqual(['gr-a', 'gr-b']);

      // Neither guardrail is collapsed: `findings` is the union (so the old
      // reader still sees everything) and `results` says who found what.
      expect((result.response as { guardrails?: unknown }).guardrails).toEqual({
        input: {
          guardrail_key: 'gr-a',
          findings: [finding({ category: 'email' }), finding({ category: 'phone' })],
          results: [
            { guardrail_key: 'gr-a', findings: [finding({ category: 'email' })] },
            { guardrail_key: 'gr-b', findings: [finding({ category: 'phone' })] },
          ],
        },
      });
    });

    it('blocks on the first blocking guardrail and never runs the ones behind it', async () => {
      scriptGuardrails({
        'gr-strict': {
          passed: false,
          blocked: true,
          action: 'block',
          guardrailName: 'Strict',
          findings: [finding({ block: true, message: 'email address' })],
        },
        'gr-lenient': { findings: [finding()] },
      });

      await expect(
        runCompletion({
          guardrails: [
            { key: 'gr-strict', hooks: ['input.pre'] },
            { key: 'gr-lenient', hooks: ['input.pre'] },
          ],
        }),
      ).rejects.toThrow('Input blocked by guardrail "Strict": email address');

      expect(evaluateGuardrail).toHaveBeenCalledTimes(1);
    });

    it('reports the EARLIER blocker when two guardrails both block', async () => {
      // The message the end user reads is the first blocker's, deterministically
      // — an operator who put the friendlier refusal first meant it, and
      // evaluating the chain concurrently would make it a race.
      scriptGuardrails({
        'gr-first': {
          passed: false,
          blocked: true,
          action: 'block',
          guardrailName: 'First',
          findings: [finding({ block: true, message: 'first reason' })],
        },
        'gr-second': {
          passed: false,
          blocked: true,
          action: 'block',
          guardrailName: 'Second',
          findings: [finding({ block: true, message: 'second reason' })],
        },
      });

      await expect(
        runCompletion({
          guardrails: [
            { key: 'gr-first', hooks: ['input.pre'] },
            { key: 'gr-second', hooks: ['input.pre'] },
          ],
        }),
      ).rejects.toThrow('Input blocked by guardrail "First": first reason');
    });

    it('chains redactions so a later guardrail sees what the earlier one rewrote', async () => {
      // Feeding every guardrail the ORIGINAL text and keeping the last
      // `redactedText` would discard every earlier redaction, so composing two
      // guardrails would mask LESS than either does alone.
      (evaluateGuardrail as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ guardrailKey, text }: { guardrailKey: string; text: string }) => ({
          passed: true,
          action: 'redact',
          guardrailKey,
          guardrailName: guardrailKey,
          findings: [finding()],
          redactedText:
            guardrailKey === 'gr-email'
              ? text.replace('a@b.com', '[EMAIL]')
              : text.replace('555-1234', '[PHONE]'),
        }),
      );

      await runCompletion(
        {
          guardrails: [
            { key: 'gr-email', hooks: ['input.pre'] },
            { key: 'gr-phone', hooks: ['input.pre'] },
          ],
        },
        'mail a@b.com or call 555-1234',
      );

      const calls = (evaluateGuardrail as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toMatchObject({
        guardrailKey: 'gr-email',
        text: 'mail a@b.com or call 555-1234',
      });
      expect(calls[1][0]).toMatchObject({
        guardrailKey: 'gr-phone',
        text: 'mail [EMAIL] or call 555-1234',
      });

      // Both masks reach the provider, which is the point of chaining.
      const logged = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(logged?.[2].providerRequest.messages[0].content)
        .toBe('mail [EMAIL] or call [PHONE]');
    });

    it('ignores the legacy slots once the model carries a binding list', async () => {
      // The compatibility promise runs one way only: a row that has migrated is
      // not ALSO enforced through the deprecated column it still writes, which
      // would double-log and double-bill the same guardrail.
      scriptGuardrails();

      await runCompletion({
        inputGuardrailKey: 'gr-old',
        guardrails: [{ key: 'gr-new', hooks: ['input.pre'] }],
      });

      expect(evaluateGuardrail).toHaveBeenCalledTimes(1);
      expect(evaluateGuardrail).toHaveBeenCalledWith(
        expect.objectContaining({ guardrailKey: 'gr-new' }),
      );
    });

    it('does not run a stream-only binding on the non-streaming output check', async () => {
      // The legacy slot could not express this; the binding list can, and
      // honouring it is what makes narrowing a guardrail to the stream real.
      scriptGuardrails();

      await runCompletion({
        guardrails: [{ key: 'gr-stream', hooks: ['output.stream.delta'] }],
      });

      expect(evaluateGuardrail).not.toHaveBeenCalled();
    });

    it('hands the stream gate every guardrail bound to output.stream.delta', async () => {
      scriptGuardrails();

      await runStream({
        guardrails: [
          { key: 'gr-a', hooks: ['output.stream.delta'] },
          { key: 'gr-b', hooks: ['output.stream.delta'] },
        ],
      });

      expect(createStreamGate).toHaveBeenCalledWith(
        expect.objectContaining({ guardrailKeys: ['gr-a', 'gr-b'] }),
      );
    });

    it('writes one post-hoc audit row per output.pre guardrail', async () => {
      // The evaluation log is per-guardrail, so two bound guardrails are two
      // rows. Collapsing them would leave one of the two with no audit trail.
      scriptGuardrails();

      await runStream({
        guardrails: [
          { key: 'gr-a', hooks: ['output.pre'] },
          { key: 'gr-b', hooks: ['output.pre'] },
        ],
      });

      const audited = (evaluateGuardrail as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => call[0].guardrailKey);
      expect(audited.sort()).toEqual(['gr-a', 'gr-b']);
      expect(evaluateGuardrail).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'output',
          source: 'chat.completions:stream',
          text: expect.stringContaining('the answer'),
        }),
      );
    });

    it('builds no gate when nothing is bound to the stream hook', async () => {
      scriptGuardrails();

      await runStream({ guardrails: [{ key: 'gr-a', hooks: ['output.pre'] }] });

      expect(createStreamGate).not.toHaveBeenCalled();
    });
  });
});
// ---- Dynamic LLM routing (router resolution + decision logging) ----
describe('handleChatCompletion · Dynamic LLM', () => {
  const makeRouter = (dynamic: object) =>
    makeLlmModel({
      _id: 'router-id',
      key: 'router',
      name: 'Smart router',
      providerKey: 'dynamic',
      providerDriver: 'dynamic',
      modelId: 'dynamic-router',
      settings: { dynamic },
    });

  const big = makeLlmModel({ _id: 'big-id', key: 'big', providerKey: 'p-big' });
  const small = makeLlmModel({ _id: 'small-id', key: 'small', providerKey: 'p-small' });

  // getModelByKey resolves whichever model the (recursive) call asks for.
  const wireModels = (router: object) => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockImplementation(
      async (_db: string, key: string) =>
        key === 'router' ? router : key === 'big' ? big : key === 'small' ? small : null,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
    (logModelUsage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    vi.unstubAllGlobals();
    useRuntime();
    stubUpstream(() => json(completion({ content: 'child answer' })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rule-based: routes to the matching rule target and logs the decision', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'small',
      rules: [
        {
          label: 'complex',
          targetModelKey: 'big',
          matchType: 'all',
          conditions: [{ signal: 'inputTokensEst', operator: 'gt', value: 5 }],
        },
      ],
    });
    wireModels(router);

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'x'.repeat(400) }] },
    });

    // Child response is returned, annotated with routing metadata.
    expect(result.response).toMatchObject({
      choices: [{ message: { content: 'child answer' } }],
    });
    expect(result.routing?.decision).toBe('rule');
    expect(result.routing?.chosenModelKey).toBe('big');

    // A router decision row was logged on the 'chat.completions.router' route.
    const routerLog = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[2]?.route === 'chat.completions.router',
    );
    expect(routerLog).toBeTruthy();
    expect(routerLog?.[2]?.routing?.chosenModelKey).toBe('big');
  });

  it('rule-based: falls back to the default model when no rule matches', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'small',
      rules: [
        {
          label: 'huge',
          targetModelKey: 'big',
          matchType: 'all',
          conditions: [{ signal: 'inputTokensEst', operator: 'gt', value: 100000 }],
        },
      ],
    });
    wireModels(router);

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'short' }] },
    });

    expect(result.routing?.decision).toBe('default');
    expect(result.routing?.chosenModelKey).toBe('small');
  });

  it('uses the fallback model when the chosen model errors', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'big',
      fallbackModelKey: 'small',
      rules: [
        {
          label: 'always',
          targetModelKey: 'big',
          matchType: 'all',
          conditions: [{ signal: 'messageCount', operator: 'gte', value: 1 }],
        },
      ],
    });
    wireModels(router);

    // 'big' (providerKey p-big, API key p-big) fails; 'small' succeeds.
    const runtimes = new Map<string, ModelProviderRuntime>();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(
      async (_db: string, _tid: string, providerKey: string) => {
        if (!runtimes.has(providerKey)) runtimes.set(providerKey, await openAiRuntime({}, providerKey));
        return { runtime: runtimes.get(providerKey) };
      },
    );
    stubUpstream((call) => call.headers.authorization === 'Bearer p-big'
      ? json({ error: { message: 'primary down', type: 'invalid_request_error' } }, 400)
      : json(completion({ content: 'ok' })));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(result.routing?.decision).toBe('fallback');
    expect(result.routing?.chosenModelKey).toBe('small');
  });

  const priced = (key: string, input: number, output: number, extra: object = {}) =>
    makeLlmModel({
      _id: `${key}-id`,
      key,
      providerKey: `p-${key}`,
      pricing: { inputTokenPer1M: input, outputTokenPer1M: output },
      ...extra,
    });

  const wireAll = (models: Record<string, object>) => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockImplementation(
      async (_db: string, key: string) => models[key] ?? null,
    );
  };

  const childRows = () =>
    (logModelUsage as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[2])
      .filter((payload) => payload?.routing?.role === 'child');

  it('pool + best-under-cap: picks the highest tier that fits the cap and attributes the child row', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'large',
      guards: { maxCostPerRequestUsd: 0.001 },
      rules: [
        {
          label: 'any',
          target: {
            pool: [
              { modelKey: 'small', tier: 1 },
              { modelKey: 'medium', tier: 2 },
              { modelKey: 'large', tier: 3 },
            ],
            policy: 'best-under-cap',
          },
          conditions: [{ signal: 'messageCount', operator: 'gte', value: 1 }],
        },
      ],
    });
    wireAll({
      router,
      small: priced('small', 0.1, 0.4),
      medium: priced('medium', 1, 2),
      large: priced('large', 10, 30),
    });

    // ~250 input tokens + 100 capped output: medium ≈ $0.00045, large ≈ $0.0055.
    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'x'.repeat(1000) }], max_tokens: 100 },
    });

    expect(result.routing?.chosenModelKey).toBe('medium');
    expect(result.routing?.policy).toBe('best-under-cap');
    expect(result.routing?.pool?.map((e) => e.modelKey)).toEqual(['small', 'medium', 'large']);

    const [child] = childRows();
    expect(child.routing).toMatchObject({ role: 'child', routerKey: 'router', chosenModelKey: 'medium', matchedRuleLabel: 'any' });
    expect(child.routing.estimatedCostUsd).toBeGreaterThan(0);
    // Savings are measured against the default model's pricing.
    expect(child.routingBaselinePricing).toEqual({ inputTokenPer1M: 10, outputTokenPer1M: 30 });
  });

  it('pool: skips candidates that cannot serve the request (tool calling)', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'big',
      defaultTarget: { pool: [{ modelKey: 'notools' }, { modelKey: 'tools' }], policy: 'cheapest' },
      rules: [{ label: 'never', targetModelKey: 'big', conditions: [{ signal: 'messageCount', operator: 'gt', value: 99 }] }],
    });
    wireAll({
      router,
      big,
      notools: priced('notools', 0.01, 0.01, { metadata: { capabilities: { supportsToolCalls: false } } }),
      tools: priced('tools', 1, 1),
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: {
        messages: [{ role: 'user', content: 'call a tool' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      },
    });

    expect(result.routing?.chosenModelKey).toBe('tools');
    expect(result.routing?.pool?.find((e) => e.modelKey === 'notools')?.skipped).toBe('no tool calling');
  });

  it('token-profile: keeps the conversation on its previous model inside the switch margin', async () => {
    (getConversationState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ lastModelKey: 'b', ioRatio: 0.5 });
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'a',
      defaultTarget: { pool: [{ modelKey: 'a' }, { modelKey: 'b' }], policy: 'token-profile' },
      rules: [{ label: 'never', targetModelKey: 'a', conditions: [{ signal: 'messageCount', operator: 'gt', value: 99 }] }],
    });
    wireAll({ router, a: priced('a', 0.95, 0.95), b: priced('b', 1, 1) });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'y'.repeat(800) }] },
    });

    expect(result.routing?.chosenModelKey).toBe('b');
    expect(result.routing?.reason).toMatch(/Kept conversation on b/);
  });

  it('shadow mode: serves the primary model and records what the pool would have chosen', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'big',
      mode: 'shadow',
      defaultTarget: { pool: [{ modelKey: 'big' }, { modelKey: 'small' }], policy: 'cheapest' },
      rules: [{ label: 'never', targetModelKey: 'big', conditions: [{ signal: 'messageCount', operator: 'gt', value: 99 }] }],
    });
    wireAll({ router, big: priced('big', 10, 30), small: priced('small', 0.1, 0.4) });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(result.routing?.chosenModelKey).toBe('big');
    expect(result.routing?.mode).toBe('shadow');
    expect(result.routing?.shadow?.chosenModelKey).toBe('small');
    expect(childRows()[0].routing.shadow?.chosenModelKey).toBe('small');
  });

  it('budget guard: rejects with 429 once the budget is exhausted (onExceeded: reject)', async () => {
    (getRouterSpendUsd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(12);
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'small',
      guards: { budget: { windowHours: 24, limitUsd: 10, onExceeded: 'reject' } },
      rules: [{ label: 'never', targetModelKey: 'big', conditions: [{ signal: 'messageCount', operator: 'gt', value: 99 }] }],
    });
    wireAll({ router, small: priced('small', 0.1, 0.4) });

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, modelKey: 'router', body: { messages: [{ role: 'user', content: 'hi' }] } }),
    ).rejects.toMatchObject({ status: 429, code: 'router_budget_exceeded' });
    expect(childRows()).toHaveLength(0);
  });

  it('budget guard: downgrades a fixed target to the economy model', async () => {
    (getRouterSpendUsd as ReturnType<typeof vi.fn>).mockResolvedValueOnce(9);
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'big',
      guards: { budget: { windowHours: 24, limitUsd: 10, downgradeAtPct: 80 }, economyModelKey: 'small' },
      rules: [{ label: 'never', targetModelKey: 'big', conditions: [{ signal: 'messageCount', operator: 'gt', value: 99 }] }],
    });
    wireAll({ router, big: priced('big', 10, 30), small: priced('small', 0.1, 0.4) });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(result.routing?.chosenModelKey).toBe('small');
    expect(result.routing?.guard).toBe('budget');
  });

  const decisionOutcome = (answers: Record<string, unknown>) => ({
    result: { answers, backend: { kind: 'structured', provider: 'openai' } },
    cost: { totalCost: 0.0001 },
    usage: { inputTokens: 10, outputTokens: 5 },
    latencyMs: 5,
    requestId: 'dec-1',
  });

  it('complexityScore is scored by the decision model and drives a rule', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'small',
      complexity: { modelKey: 'scorer', levels: ['easy', 'medium', 'hard'] },
      rules: [
        {
          label: 'hard',
          targetModelKey: 'big',
          conditions: [{ signal: 'complexityScore', operator: 'gte', value: 1.5 }],
        },
      ],
    });
    wireAll({
      router,
      big: priced('big', 10, 30),
      small: priced('small', 0.1, 0.4),
      scorer: makeLlmModel({ _id: 'scorer-id', key: 'scorer', category: 'decision' }),
    });
    (handleDecisionRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      decisionOutcome({ complexity: { type: 'score', score: 1.8, probabilities: {} } }),
    );
    const onUsageSettled = vi.fn();

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'prove fermat' }] },
      onUsageSettled,
    });

    expect(result.routing?.decision).toBe('rule');
    expect(result.routing?.chosenModelKey).toBe('big');
    expect(onUsageSettled).toHaveBeenCalledTimes(2); // scorer + child
    expect(handleDecisionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: expect.objectContaining({ role: 'decider', chosenModelKey: 'scorer' }),
      }),
    );
    // The scoring delayed the request before the child call, so the router row carries its time.
    expect(result.routing?.deciderModelKey).toBe('scorer');
    expect(typeof result.routing?.deciderLatencyMs).toBe('number');
  });

  it('records the scorer latency even when the scoring fails', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'small',
      complexity: { modelKey: 'scorer', levels: ['easy', 'hard'] },
      rules: [
        {
          label: 'hard',
          targetModelKey: 'big',
          conditions: [{ signal: 'complexityScore', operator: 'gte', value: 1 }],
        },
      ],
    });
    wireAll({
      router,
      big: priced('big', 10, 30),
      small: priced('small', 0.1, 0.4),
      scorer: makeLlmModel({ _id: 'scorer-id', key: 'scorer', category: 'decision' }),
    });
    (handleDecisionRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('scorer down'));

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'prove fermat' }] },
    });

    expect(result.routing?.decision).toBe('default');
    expect(result.routing?.deciderModelKey).toBe('scorer');
    expect(typeof result.routing?.deciderLatencyMs).toBe('number');
  });

  it('complexityScore is not scored when no rule references it', async () => {
    const router = makeRouter({
      strategy: 'rule-based',
      defaultModelKey: 'small',
      complexity: { modelKey: 'scorer', levels: ['easy', 'hard'] },
      rules: [{ label: 'tools', targetModelKey: 'big', conditions: [{ signal: 'hasTools', operator: 'isTrue' }] }],
    });
    wireAll({ router, big: priced('big', 10, 30), small: priced('small', 0.1, 0.4) });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(handleDecisionRequest).not.toHaveBeenCalled();
    expect(result.routing?.deciderLatencyMs).toBeUndefined();
  });

  describe('decision-model decider', () => {
    const deciderRouter = (decider: object) =>
      makeRouter({
        strategy: 'model-based',
        defaultModelKey: 'small',
        decider: {
          modelKey: 'decider',
          labels: [
            { label: 'hard', description: 'hard', targetModelKey: 'big' },
            { label: 'easy', description: 'easy', targetModelKey: 'small' },
          ],
          ...decider,
        },
      });
    const wire = (router: object) =>
      wireAll({
        router,
        big: priced('big', 10, 30),
        small: priced('small', 0.1, 0.4),
        decider: makeLlmModel({ _id: 'decider-id', key: 'decider', category: 'decision' }),
      });
    const answer = (choice: string, hard: number, extra: object = {}) =>
      decisionOutcome({
        route: { type: 'choice', choice, probabilities: { hard, easy: 1 - hard }, ...extra },
      });

    it('routes by the winning label, bills the call and records probability + margin', async () => {
      wire(deciderRouter({}));
      (handleDecisionRequest as ReturnType<typeof vi.fn>).mockResolvedValue(answer('hard', 0.9));
      const onUsageSettled = vi.fn();

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        modelKey: 'router',
        body: { messages: [{ role: 'user', content: 'prove fermat' }] },
        onUsageSettled,
      });

      expect(result.routing?.chosenModelKey).toBe('big');
      expect(result.routing?.decision).toBe('model');
      expect(result.routing?.deciderProbability).toBeCloseTo(0.9);
      expect(result.routing?.deciderMargin).toBeCloseTo(0.8);
      expect(onUsageSettled).toHaveBeenCalledTimes(2); // decision + child
      // No chat call goes to the decider model.
      expect(handleDecisionRequest).toHaveBeenCalledTimes(1);
    });

    it('below minConfidence it uses the default target', async () => {
      wire(deciderRouter({ minConfidence: 0.8 }));
      (handleDecisionRequest as ReturnType<typeof vi.fn>).mockResolvedValue(answer('hard', 0.6));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        modelKey: 'router',
        body: { messages: [{ role: 'user', content: 'maybe hard' }] },
      });

      expect(result.routing?.chosenModelKey).toBe('small');
      expect(result.routing?.reason).toContain('below minConfidence');
    });

    it('below minConfidence it uses belowConfidence when set', async () => {
      wire(deciderRouter({ minConfidence: 0.8, belowConfidence: { modelKey: 'big' } }));
      (handleDecisionRequest as ReturnType<typeof vi.fn>).mockResolvedValue(answer('easy', 0.4));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        modelKey: 'router',
        body: { messages: [{ role: 'user', content: 'unsure' }] },
      });

      expect(result.routing?.chosenModelKey).toBe('big');
    });

    it('prefers the reported confidence over the label probability', async () => {
      wire(deciderRouter({ minConfidence: 0.8 }));
      (handleDecisionRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
        answer('hard', 0.95, { confidence: 0.5, confidence_source: 'native' }),
      );

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        modelKey: 'router',
        body: { messages: [{ role: 'user', content: 'x' }] },
      });

      expect(result.routing?.chosenModelKey).toBe('small');
      expect(result.routing?.deciderConfidence).toBe(0.5);
    });

    it('a failing decision call falls back to the default', async () => {
      wire(deciderRouter({}));
      (handleDecisionRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        modelKey: 'router',
        body: { messages: [{ role: 'user', content: 'x' }] },
      });

      expect(result.routing?.chosenModelKey).toBe('small');
      expect(result.routing?.reason).toContain('Decider failed');
    });
  });

  it('model-based: the decider call is billed to the caller and attributed to the router', async () => {
    const router = makeRouter({
      strategy: 'model-based',
      defaultModelKey: 'small',
      decider: { modelKey: 'decider', labels: [{ label: 'hard', description: 'hard', targetModelKey: 'big' }] },
    });
    wireAll({
      router,
      big: priced('big', 10, 30),
      small: priced('small', 0.1, 0.4),
      decider: priced('decider', 0.1, 0.1),
    });
    stubUpstream(() => json(completion({ content: 'hard' })));
    const onUsageSettled = vi.fn();

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'prove fermat' }] },
      onUsageSettled,
    });

    expect(result.routing?.chosenModelKey).toBe('big');
    // Decider + child both settle against the caller's budget.
    expect(onUsageSettled).toHaveBeenCalledTimes(2);
    const deciderRow = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[2])
      .find((payload) => payload?.routing?.role === 'decider');
    expect(deciderRow?.routing).toMatchObject({ routerKey: 'router', chosenModelKey: 'decider' });
  });
});

// ---- handleEmbeddingRequest ----
describe('handleEmbeddingRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (logModelUsage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('throws when input is missing', async () => {
    await expect(
      handleEmbeddingRequest({
        tenantDbName: 'tenant_acme',
        modelKey: 'emb-model',
        projectId: 'proj-1',
        body: {},
      }),
    ).rejects.toThrow('`input` is required');
  });

  it('throws when model is not found', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      handleEmbeddingRequest({
        tenantDbName: 'tenant_acme',
        modelKey: 'emb-model',
        projectId: 'proj-1',
        body: { input: 'hello' },
      }),
    ).rejects.toThrow('Model with key emb-model not found');
  });

  it('throws when model category is not embedding', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(),
    });

    await expect(
      handleEmbeddingRequest({
        tenantDbName: 'tenant_acme',
        modelKey: 'gpt-4o',
        projectId: 'proj-1',
        body: { input: 'hello' },
      }),
    ).rejects.toThrow('Model is not configured for embeddings');
  });

  it('throws when runtime has no createEmbeddingModel', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeEmbeddingModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {},
    });

    await expect(
      handleEmbeddingRequest({
        tenantDbName: 'tenant_acme',
        modelKey: 'emb-model',
        projectId: 'proj-1',
        body: { input: 'hello' },
      }),
    ).rejects.toThrow('Model provider does not support embeddings');
  });

  it('throws when runtime returns invalid embedding model', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeEmbeddingModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createEmbeddingModel: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(
      handleEmbeddingRequest({
        tenantDbName: 'tenant_acme',
        modelKey: 'emb-model',
        projectId: 'proj-1',
        body: { input: 'hello' },
      }),
    ).rejects.toThrow('Model provider returned an invalid embedding runtime.');
  });

  it('throws when input array contains non-string values', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeEmbeddingModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(),
    });

    await expect(
      handleEmbeddingRequest({
        tenantDbName: 'tenant_acme',
        modelKey: 'emb-model',
        projectId: 'proj-1',
        body: { input: [42, 'valid'] as unknown as string[] },
      }),
    ).rejects.toThrow('`input` must be a string or an array of strings');
  });

  it('returns embeddings for a single string input', async () => {
    const model = makeEmbeddingModel();
    const vectors = [[0.1, 0.2, 0.3]];
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(vectors),
    });

    const result = await handleEmbeddingRequest({
      tenantDbName: 'tenant_acme',
      modelKey: 'emb-model',
      projectId: 'proj-1',
      body: { input: 'hello world' },
    });

    expect(result.response).toMatchObject({
      object: 'list',
      data: [
        { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
      ],
      model: 'text-embedding-3-small',
    });
    expect(result.requestId).toEqual(expect.any(String));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('handles array input and returns multiple embeddings', async () => {
    const model = makeEmbeddingModel();
    const vectors = [[0.1, 0.2], [0.3, 0.4]];
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(vectors),
    });

    const result = await handleEmbeddingRequest({
      tenantDbName: 'tenant_acme',
      modelKey: 'emb-model',
      projectId: 'proj-1',
      body: { input: ['foo', 'bar'] },
    });

    expect(result.response.data).toHaveLength(2);
    expect(result.response.data[1].index).toBe(1);
  });

  it('logs usage with correct route and token counts', async () => {
    const model = makeEmbeddingModel();
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(),
    });

    await handleEmbeddingRequest({
      tenantDbName: 'tenant_acme',
      modelKey: 'emb-model',
      projectId: 'proj-1',
      body: { input: 'hello', input_tokens: 5 },
    });

    expect(logModelUsage).toHaveBeenCalledWith(
      'tenant_acme',
      model,
      expect.objectContaining({
        route: 'embeddings',
        status: 'success',
      }),
    );
  });

  it('uses provided request_id', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeEmbeddingModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(),
    });

    const result = await handleEmbeddingRequest({
      tenantDbName: 'tenant_acme',
      modelKey: 'emb-model',
      projectId: 'proj-1',
      body: { input: 'hello', request_id: 'custom-req-id' },
    });

    expect(result.requestId).toBe('custom-req-id');
  });
});
