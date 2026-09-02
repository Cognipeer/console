import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import {
  handleChatCompletion,
  handleEmbeddingRequest,
  OutputTokenLimitError,
} from '@/lib/services/models/inferenceService';

// ---- mocks ----
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
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

vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({ action: 'allow', findings: [] }),
  // The gate's own behaviour (hold-back windows, overlap scanning, mutation
  // rebasing) is covered by guardrail-stream-gate.test.ts against the real
  // implementation. What is under test HERE is the wiring: which frames the
  // inference service writes, in what order, and what it logs — so the gate is
  // a stub whose emissions the test dictates. The real one resolves guardrail
  // records from the database, which this unit test has no business reaching.
  createStreamGate: vi.fn(),
}));

vi.mock('@/lib/services/models/openaiAdapter', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/openaiAdapter')>();
  return {
    ...original,
    toOpenAIChatResponse: vi.fn().mockReturnValue({ id: 'chatcmpl-1', choices: [] }),
    toOpenAIStreamChunk: vi.fn().mockReturnValue({ id: 'chatcmpl-1', choices: [] }),
    summarizeUsage: vi.fn().mockReturnValue({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
  };
});

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { isSemanticCacheEnabled, lookupCache, storeInCache } from '@/lib/services/models/semanticCacheService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { createStreamGate, evaluateGuardrail } from '@/lib/services/guardrail';
import {
  toOpenAIChatResponse,
  toOpenAIStreamChunk,
  summarizeUsage,
} from '@/lib/services/models/openaiAdapter';

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

const makeChatRuntime = (invokeResult?: object) => ({
  createChatModel: vi.fn().mockResolvedValue({
    invoke: vi.fn().mockResolvedValue(invokeResult ?? { content: 'Hi there!', tool_calls: [] }),
  }),
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
    push: vi.fn(async (chunk: unknown) => {
      const next = pushes.shift() ?? 'passthrough';
      return next === 'passthrough' ? { emit: [chunk], blocked: false } : next;
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

// ---- tests ----
describe('handleChatCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
    (storeInCache as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (logModelUsage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (createStreamGate as ReturnType<typeof vi.fn>).mockImplementation(() => makeGateStub());
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
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeEmbeddingModel(),
    );
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeEmbeddingRuntime(),
    });

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: [] } }),
    ).rejects.toThrow('Model is not configured for chat completions');
  });

  it('throws when runtime has no createChatModel', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {},
    });

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: [] } }),
    ).rejects.toThrow('Model provider does not support chat completions');
  });

  it('throws when runtime returns invalid chat model', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(
      handleChatCompletion({ ...BASE_PARAMS, body: { messages: [] } }),
    ).rejects.toThrow('Model provider returned an invalid chat runtime.');
  });

  it('returns response on successful non-streaming completion', async () => {
    const model = makeLlmModel();
    const chatRuntime = makeChatRuntime();
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: chatRuntime,
    });
    (toOpenAIChatResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'chatcmpl-abc',
      choices: [{ message: { content: 'Hi!' } }],
    });
    (summarizeUsage as ReturnType<typeof vi.fn>).mockReturnValue({
      inputTokens: 5,
      outputTokens: 10,
      totalTokens: 15,
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Hello' }] },
    });

    expect(result).toMatchObject({
      cacheHit: false,
      requestId: expect.any(String),
      latencyMs: expect.any(Number),
    });
    expect(result.response).toMatchObject({ id: 'chatcmpl-abc' });
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

  it('forwards finishReason and reasoningTokens to logModelUsage without perturbing totalTokens', async () => {
    // reasoningTokens is a SUBSET of outputTokens — it must reach logModelUsage
    // as its own field, and totalTokens must stay exactly what summarizeUsage
    // reported (inputTokens + outputTokens), never inflated by reasoningTokens.
    const model = makeLlmModel();
    const chatRuntime = makeChatRuntime({
      content: 'Hi!',
      tool_calls: [],
      response_metadata: { finish_reason: 'stop' },
    });
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: chatRuntime,
    });
    (summarizeUsage as ReturnType<typeof vi.fn>).mockReturnValue({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      reasoningTokens: 8,
    });

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [{ role: 'user', content: 'Hello' }] },
    });

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

  it('passes canonical OpenAI vision content to the provider runnable', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const chatModel = {
      invoke: vi.fn().mockResolvedValue({ content: 'A small image', tool_calls: [] }),
    };
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { createChatModel: vi.fn().mockResolvedValue(chatModel) },
    });
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

    const messages = chatModel.invoke.mock.calls[0][0];
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ]);
  });

  it('uses provided request_id in response', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeChatRuntime(),
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], request_id: 'my-custom-id' },
    });

    expect(result.requestId).toBe('my-custom-id');
  });

  it('generates a UUID when request_id is not provided', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeChatRuntime(),
    });

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
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
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
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeChatRuntime(),
    });

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
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);
    (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (lookupCache as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cache timeout'));
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeChatRuntime(),
    });

    // Should not throw — cache error is swallowed with a warning
    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
    });

    expect(result.cacheHit).toBe(false);
    expect(buildModelRuntime).toHaveBeenCalled();
  });

  it('returns a ReadableStream for streaming requests', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());

    const fakeChunks = [{ content: 'Hello' }, { content: ' World' }];
    const asyncIterator = (async function* () {
      for (const chunk of fakeChunks) yield chunk;
    })();

    const chatModel = {
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue(asyncIterator),
    };

    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue(chatModel),
      },
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
      stream: true,
    });

    expect(result).toHaveProperty('stream');
    expect(result).toHaveProperty('requestId');
    expect(result.stream).toBeInstanceOf(ReadableStream);
  });

  it('emits requested stream usage as a final usage-only chunk', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const asyncIterator = (async function* () {
      yield { content: 'Hello' };
    })();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke: vi.fn(),
          stream: vi.fn().mockResolvedValue(asyncIterator),
        }),
      },
    });
    (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        cached_tokens: 0,
        total_tokens: 7,
      },
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        stream_options: { include_usage: true },
      },
      stream: true,
    });
    const body = await new Response(result.stream).text();
    const chunks = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));

    expect(chunks[0].usage).toBeUndefined();
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  });

  it('logs the terminal finish_reason and reasoningTokens from the final stream usage frame, without perturbing totalTokens', async () => {
    // reasoningTokens is a SUBSET of completion_tokens (outputTokens) — it must
    // reach logModelUsage as its own field, and totalTokens must stay exactly
    // what the final usage frame reported, never inflated by reasoningTokens.
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const asyncIterator = (async function* () {
      yield { content: 'Hello' };
    })();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke: vi.fn(),
          stream: vi.fn().mockResolvedValue(asyncIterator),
        }),
      },
    });
    (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 12,
        cached_tokens: 0,
        total_tokens: 17,
        completion_tokens_details: { reasoning_tokens: 9 },
      },
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        stream_options: { include_usage: true },
      },
      stream: true,
    });
    // Draining the stream runs the fire-and-forget logging call synchronously
    // within the stream's `start()`, so it has landed by the time we check.
    await new Response(result.stream).text();

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
    // trailing choices-less frame. We were attaching it to whichever content
    // chunk the provider happened to hang it on.
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke: vi.fn(),
          stream: vi.fn().mockResolvedValue((async function* () {
            yield { content: 'Hello' };
          })()),
        }),
      },
    });
    (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
      stream: true,
    });
    const body = await new Response(result.stream).text();
    const chunks = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));

    expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true);
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // The opening role frame carries the id the whole completion reuses. It
    // used to be built inline as `chatcmpl_<dashed uuid>`, long after the
    // OpenAI-shaped `chatcmpl-<opaque>` was adopted everywhere else.
    expect(chunks[0].id).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
  });

  it('streams a tool-carrying request frame by frame rather than in one shot', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const invoke = vi.fn();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke,
          stream: vi.fn().mockResolvedValue((async function* () {
            // Real chunks: the streaming path aggregates with `.concat()`, so
            // plain objects would abort the stream after the first frame and
            // the assertion below would pass for the wrong reason.
            yield new AIMessageChunk({ content: 'one' });
            yield new AIMessageChunk({ content: 'two' });
            yield new AIMessageChunk({ content: 'three' });
          })()),
        }),
      },
    });
    (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockImplementation((chunk: {
      content: string;
    }) => ({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
    }));

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
    const body = await new Response(result.stream).text();
    const contents = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk.choices?.[0]?.delta?.content)
      .filter((content) => typeof content === 'string' && content.length > 0);

    expect(contents).toEqual(['one', 'two', 'three']);
    expect(invoke).not.toHaveBeenCalled();
  });

  describe('client disconnects mid-stream', () => {
    const startCancellableStream = async (modelOverrides = {}) => {
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel(modelOverrides));
      let aborted = false;
      (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
        runtime: {
          createChatModel: vi.fn().mockResolvedValue({
            invoke: vi.fn(),
            stream: vi.fn().mockImplementation((_messages, options) => {
              options?.signal?.addEventListener('abort', () => { aborted = true; });
              return Promise.resolve((async function* () {
                yield new AIMessageChunk({ content: 'partial answer' });
                // Stay open so the consumer's cancel lands mid-stream, then
                // surface the abort the way a provider SDK does.
                await new Promise((resolve) => { setTimeout(resolve, 30); });
                if (aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
                yield new AIMessageChunk({ content: ' never delivered' });
              })());
            }),
          }),
        },
      });
      (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockImplementation((chunk: {
        content: string;
      }) => ({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
      }));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
      });

      const reader = result.stream!.getReader();
      await reader.read();
      await reader.read();
      await reader.cancel('client gone');
      // Let the aborted iterator unwind and the fire-and-forget log settle.
      await new Promise((resolve) => { setTimeout(resolve, 80); });
      return (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    };

    it('records the call as cancelled, not as a provider error', async () => {
      // Pressing stop is not an outage. Logging it as one drove the error rate
      // and its alerting off user behaviour rather than provider health.
      const call = await startCancellableStream();

      expect(call?.[2]).toMatchObject({ status: 'cancelled', route: 'chat.completions' });
      expect(call?.[2].errorMessage).toBeUndefined();
    });

    it('still bills the output the provider generated before the client left', async () => {
      // The provider charges for what it produced; recording zero wrote it off.
      const call = await startCancellableStream();

      expect(call?.[2].usage.outputTokens).toBeGreaterThan(0);
      expect(call?.[2].providerResponse).toMatchObject({
        cancelled: 'client_disconnected',
        output_tokens_estimated: true,
      });
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
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeLlmModel({ outputGuardrailKey: 'no-pii', ...modelOverrides }),
      );
      const upstream = { aborted: false };
      (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
        runtime: {
          createChatModel: vi.fn().mockResolvedValue({
            invoke: vi.fn(),
            stream: vi.fn().mockImplementation((_messages, options) => {
              options?.signal?.addEventListener('abort', () => {
                upstream.aborted = true;
              });
              return Promise.resolve((async function* () {
                for (const content of chunks) {
                  yield new AIMessageChunk({ content });
                }
              })());
            }),
          }),
        },
      });
      (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockImplementation((chunk: {
        content: string;
      }) => ({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
      }));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
      });
      const body = await new Response(result.stream!).text();
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

    it('closes the stream on a block before it aborts the upstream, so the block is not filed as a hang-up', async () => {
      // THE regression this whole path exists to avoid: aborting first makes
      // the provider iterator throw into the catch, which sees an aborted
      // signal, logs `status: 'cancelled'` and returns — leaving the client
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
      expect(upstream.aborted).toBe(true);
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
      // half-rendered answer — telling the client to discard a prefix it never
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
      // only evaluation row — and it covers the withheld text too, because it
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
      // chance for a violation to be caught — and it has to take the same exit.
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
      expect(upstream.aborted).toBe(true);
      expect(
        (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2],
      ).toMatchObject({ status: 'error', finishReason: 'content_filter' });
    });
  });

  it('forwards each frame as the provider produces it, without collecting the answer first', async () => {
    // The distinction that matters to a caller: do we relay the provider's
    // chunks as they land, or wait for the completion and replay it? Assert the
    // first content frame is readable *before* the provider has finished
    // producing — a buffered implementation cannot satisfy that.
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const GAP_MS = 40;
    const CHUNKS = 5;
    let producerFinishedAt = Number.POSITIVE_INFINITY;

    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke: vi.fn(),
          stream: vi.fn().mockResolvedValue((async function* () {
            for (let i = 0; i < CHUNKS; i += 1) {
              await new Promise((resolve) => { setTimeout(resolve, GAP_MS); });
              yield new AIMessageChunk({ content: `tok${i}` });
            }
            producerFinishedAt = Date.now();
          })()),
        }),
      },
    });
    (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockImplementation((chunk: {
      content: string;
    }) => ({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
    }));

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
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLlmModel({ settings: { maxTokens: 512 } }),
    );
    const asyncIterator = (async function* () {
      yield { content: '', response_metadata: { finish_reason: 'length' } };
    })();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke: vi.fn(),
          stream: vi.fn().mockResolvedValue(asyncIterator),
        }),
      },
    });
    (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'chatcmpl-limit',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 512,
        cached_tokens: 0,
        total_tokens: 612,
      },
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], stream_options: { include_usage: true } },
      stream: true,
    });
    const streamBody = await new Response(result.stream).text();
    const errorLine = streamBody
      .split('\n')
      .find((line) => line.startsWith('data: {') && line.includes('"error"'));
    const payload = JSON.parse(errorLine!.slice(6));

    expect(payload.error).toMatchObject({
      type: 'output_token_limit_exceeded',
      code: 'output_token_limit_exceeded',
      param: 'max_completion_tokens',
    });
    expect(payload.error.message).toContain('512 tokens');
    expect(streamBody).not.toContain('"finish_reason":"length"');
    // The error frame is still terminated: a client reading until the sentinel
    // must be released, not left waiting on the socket.
    expect(streamBody.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('emits a normalized SSE error when a provider stream fails', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const providerError = Object.assign(new Error('Provider rate limit reached'), {
      status: 429,
      code: 'rate_limit_exceeded',
    });
    const asyncIterator = (async function* () {
      yield { content: 'Partial' };
      throw providerError;
    })();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke: vi.fn(),
          stream: vi.fn().mockResolvedValue(asyncIterator),
        }),
      },
    });
    (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: 'chatcmpl-rate-limit',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }],
    });

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
      stream: true,
    });
    const streamBody = await new Response(result.stream).text();
    const errorLine = streamBody
      .split('\n')
      .find((line) => line.startsWith('data: {') && line.includes('"error"'));
    const payload = JSON.parse(errorLine!.slice(6));

    expect(payload.error).toMatchObject({
      message: 'Provider rate limit reached',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    });
    expect(payload.request_id).toBe(result.requestId);
    expect(streamBody.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('throws an output token limit error for an empty non-streaming length result', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLlmModel({ settings: { maxTokens: 512 } }),
    );
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: makeChatRuntime({
        content: '',
        tool_calls: [],
        response_metadata: { finish_reason: 'length' },
      }),
    });

    await expect(handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [] },
    })).rejects.toMatchObject({
      name: 'OutputTokenLimitError',
      limit: 512,
      message: expect.stringContaining('Reasoning models'),
    } satisfies Partial<OutputTokenLimitError>);
  });

  it('throws when streaming is requested but runtime does not support it', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());

    const chatModel = {
      invoke: vi.fn(),
      // no stream method
    };

    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue(chatModel),
      },
    });

    await expect(
      handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
      }),
    ).rejects.toThrow('Model provider does not support streaming responses');
  });

  it('applies body overrides when creating and invoking the chat model', async () => {
    const model = makeLlmModel();
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);

    const chatModel = {
      invoke: vi.fn().mockResolvedValue({ content: 'Hi', tool_calls: [] }),
    };
    const createChatModel = vi.fn().mockResolvedValue(chatModel);

    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { createChatModel },
    });

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: {
        messages: [],
        temperature: 0.7,
        max_tokens: 256,
        stop: ['DONE'],
      },
    });

    expect(createChatModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSettings: expect.objectContaining({
          temperature: 0.7,
          maxTokens: 256,
        }),
      }),
    );
    expect(chatModel.invoke).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ stop: ['DONE'] }),
    );
  });

  it('forwards parallel tool options and normalizes strict nested schemas', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const chatModel = {
      invoke: vi.fn().mockResolvedValue({ content: '', tool_calls: [] }),
    };
    const createChatModel = vi.fn().mockResolvedValue(chatModel);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { createChatModel },
    });

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

    expect(chatModel.invoke).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        strict: true,
        parallel_tool_calls: true,
        tools: [expect.objectContaining({
          function: expect.objectContaining({
            strict: true,
            parameters: expect.objectContaining({
              additionalProperties: false,
              properties: {
                filters: expect.objectContaining({
                  items: expect.objectContaining({
                    additionalProperties: false,
                  }),
                }),
              },
            }),
          }),
        })],
      }),
    );
  });

  it('keeps provider streaming on when a request carries tools', async () => {
    // Open WebUI (native function calling by default) and Onyx send `tools` on
    // essentially every chat request. Turning provider streaming off for them
    // collapsed the whole answer into one SSE frame — "streaming is broken".
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());
    const createChatModel = vi.fn().mockResolvedValue({
      invoke: vi.fn(),
      stream: vi.fn().mockResolvedValue((async function* () {
        yield { content: 'hi' };
      })()),
    });
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { createChatModel },
    });

    await handleChatCompletion({
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

    expect(createChatModel).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { streaming: true, disableStreaming: false, maxRetries: 0 },
      }),
    );
  });

  it('disables provider streaming for tool calls only when the model opts in', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLlmModel({ settings: { disableStreamingWithTools: true } }),
    );
    const createChatModel = vi.fn().mockResolvedValue({
      invoke: vi.fn().mockResolvedValue({
        content: '',
        tool_calls: [{
          id: 'call_lookup',
          name: 'lookup',
          args: {},
          type: 'tool_call',
        }],
        response_metadata: { finish_reason: 'tool_calls' },
      }),
      stream: vi.fn().mockResolvedValue((async function* () {
        yield { content: '' };
      })()),
    });
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { createChatModel },
    });

    await handleChatCompletion({
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

    expect(createChatModel).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { streaming: true, disableStreaming: true, maxRetries: 0 },
      }),
    );
  });

  it('emits an explanatory SSE error for an empty eager tool result', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeLlmModel({ settings: { maxTokens: 512, disableStreamingWithTools: true } }),
    );
    const stream = vi.fn();
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          invoke: vi.fn().mockResolvedValue({
            content: '',
            tool_calls: [],
            response_metadata: { finish_reason: 'length' },
          }),
          stream,
        }),
      },
    });

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
    const streamBody = await new Response(result.stream).text();

    expect(streamBody).toContain('"code":"output_token_limit_exceeded"');
    expect(streamBody).toContain('512 tokens');
    expect(streamBody).not.toContain('"finish_reason":"length"');
    expect(stream).not.toHaveBeenCalled();
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
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeLlmModel(modelOverrides),
      );
      (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
        runtime: makeChatRuntime(),
      });
      (toOpenAIChatResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'chatcmpl-1',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'the answer' }, finish_reason: 'stop' },
        ],
      });
      return handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [{ role: 'user', content: userText }] },
      });
    };

    const runStream = async (modelOverrides: object) => {
      (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeLlmModel(modelOverrides),
      );
      (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
        runtime: {
          createChatModel: vi.fn().mockResolvedValue({
            invoke: vi.fn(),
            stream: vi.fn().mockResolvedValue((async function* () {
              yield new AIMessageChunk({ content: 'the answer' });
            })()),
          }),
        },
      });
      (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockImplementation((chunk: {
        content: string;
      }) => ({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
      }));

      const result = await handleChatCompletion({
        ...BASE_PARAMS,
        body: { messages: [] },
        stream: true,
      });
      await new Response(result.stream!).text();
      // Let the fire-and-forget audit settle.
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    };

    // These mocks are shared with every other test in the file and
    // `vi.clearAllMocks()` clears CALLS, not implementations — so a scripted
    // guardrail or a per-chunk adapter left behind here would silently rewrite
    // the tests that run after this block.
    afterEach(() => {
      (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
        action: 'allow',
        findings: [],
      });
      (toOpenAIChatResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'chatcmpl-1',
        choices: [],
      });
      (toOpenAIStreamChunk as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 'chatcmpl-1',
        choices: [],
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
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: makeChatRuntime() });
    (toOpenAIChatResponse as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'chatcmpl-child',
      choices: [{ message: { content: 'child answer' } }],
    });
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
    expect(result.response).toMatchObject({ id: 'chatcmpl-child' });
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

    // 'big' (providerKey p-big) fails to invoke; 'small' succeeds.
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(
      async (_db: string, _tid: string, providerKey: string) => ({
        runtime: {
          createChatModel: vi.fn().mockResolvedValue({
            invoke:
              providerKey === 'p-big'
                ? vi.fn().mockRejectedValue(new Error('primary down'))
                : vi.fn().mockResolvedValue({ content: 'ok', tool_calls: [] }),
          }),
        },
      }),
    );

    const result = await handleChatCompletion({
      ...BASE_PARAMS,
      modelKey: 'router',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(result.routing?.decision).toBe('fallback');
    expect(result.routing?.chosenModelKey).toBe('small');
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
