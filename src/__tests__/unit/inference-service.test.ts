import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChatCompletion, handleEmbeddingRequest } from '@/lib/services/models/inferenceService';

// ---- mocks ----
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: vi.fn(),
}));

vi.mock('@/lib/services/models/semanticCacheService', () => ({
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/models/usageLogger', () => ({
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/models/openaiAdapter', () => ({
  toLangChainMessages: vi.fn().mockReturnValue([{ role: 'user', content: 'hello' }]),
  toOpenAIChatResponse: vi.fn().mockReturnValue({ id: 'chatcmpl-1', choices: [] }),
  toOpenAIStreamChunk: vi.fn().mockReturnValue({ id: 'chatcmpl-1', choices: [] }),
  summarizeUsage: vi.fn().mockReturnValue({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { isSemanticCacheEnabled, lookupCache, storeInCache } from '@/lib/services/models/semanticCacheService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { toOpenAIChatResponse, summarizeUsage } from '@/lib/services/models/openaiAdapter';

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
    bind: vi.fn().mockReturnThis(),
    invoke: vi.fn().mockResolvedValue(invokeResult ?? { content: 'Hi there!', tool_calls: [] }),
  }),
});

const makeEmbeddingRuntime = (embedResult?: number[][]) => ({
  createEmbeddingModel: vi.fn().mockResolvedValue({
    embedDocuments: vi.fn().mockResolvedValue(embedResult ?? [[0.1, 0.2, 0.3]]),
  }),
});

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
      bind: vi.fn().mockReturnThis(),
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

  it('throws when streaming is requested but runtime does not support it', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeLlmModel());

    const chatModel = {
      bind: vi.fn().mockReturnThis(),
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

  it('applies body overrides to the chat model via bind', async () => {
    const model = makeLlmModel();
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(model);

    const chatModel = {
      bind: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue({ content: 'Hi', tool_calls: [] }),
    };
    const createChatModel = vi.fn().mockResolvedValue(chatModel);

    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: { createChatModel },
    });

    await handleChatCompletion({
      ...BASE_PARAMS,
      body: { messages: [], temperature: 0.7, max_tokens: 256 },
    });

    expect(chatModel.bind).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.7, max_tokens: 256 }),
    );
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
