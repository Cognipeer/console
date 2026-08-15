/**
 * Unit tests — evaluation SDK invoker (sdkInvoker.ts) + adapter wiring.
 * Covers: OpenAI-wire → UnifiedMessage conversion (system/user/assistant
 * tool_calls/tool linkage), eval-tool → SDK ToolDefinition conversion,
 * SDK toolCall normalization (object args / JSON-string args / invalid JSON),
 * TokenUsage → EvalUsage mapping (+ pricing via calculateCost), the
 * driver→ProviderConfig mapping table (incl. together→openai-compatible),
 * the typed unmappable-provider error, and the adapter's path selection:
 * SDK-first, gateway on EVALUATION_INVOKER=gateway or mapping failure, and
 * NO fallback on runtime provider errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// TRAP: factories must be synchronous — async vi.mock factories silently
// fail to intercept. Shared fns via vi.hoisted so tests can steer them.
const h = vi.hoisted(() => ({
  createProvider: vi.fn(),
  complete: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
  getModelByKey: vi.fn(),
  getDynamicRoutingConfig: vi.fn((): unknown => null),
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: vi.fn(),
  calculateCost: vi.fn(() => ({ totalCost: 0.42 })),
  getDatabase: vi.fn(),
}));

vi.mock('@cognipeer/agent-sdk', () => ({
  createProvider: h.createProvider,
}));
vi.mock('@/lib/services/providers/providerService', () => ({
  loadProviderRuntimeData: h.loadProviderRuntimeData,
}));
vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: h.getModelByKey,
}));
vi.mock('@/lib/services/models/dynamicRouting', () => ({
  getDynamicRoutingConfig: h.getDynamicRoutingConfig,
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: h.handleChatCompletion,
  handleEmbeddingRequest: h.handleEmbeddingRequest,
}));
vi.mock('@/lib/services/models/usageLogger', () => ({
  calculateCost: h.calculateCost,
}));
vi.mock('@/lib/database', () => ({
  getDatabase: h.getDatabase,
}));

import {
  invokeChatViaSdk,
  normalizeSdkToolCalls,
  resolveSdkProviderConfig,
  SdkProviderMappingError,
  toSdkTools,
  toUnifiedMessages,
} from '@/lib/services/evaluation/sdkInvoker';
import { buildJudgeInvoker, buildTargetInvoker } from '@/lib/services/evaluation/adapters';
import type { EvaluationModelContext } from '@/lib/services/evaluation/adapters';
import type { IEvaluationTarget, IModel } from '@/lib/database';
import type { DatasetItem } from '@/lib/services/evaluation/types';

const CTX: EvaluationModelContext = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };

function makeModel(overrides: Partial<IModel> = {}): IModel {
  return {
    tenantId: 't1',
    projectId: 'p1',
    name: 'GPT-4o',
    key: 'gpt-4o',
    providerKey: 'openai-main',
    providerDriver: 'openai',
    category: 'llm',
    modelId: 'gpt-4o',
    settings: {},
    pricing: { inputTokenPer1M: 5, outputTokenPer1M: 15 },
    ...overrides,
  } as IModel;
}

function providerRecord(driver: string, settings: Record<string, unknown> = {}) {
  return {
    record: { key: 'prov', type: 'model', driver, settings, tenantId: 't1' },
    credentials: { apiKey: 'sk-test' },
  };
}

const SDK_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cachedInputTokens: 2,
  cachedWriteTokens: 0,
  cachedOutputTokens: 0,
  reasoningTokens: 0,
};

function sdkResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    model: 'gpt-4o',
    content: 'hello',
    toolCalls: [],
    usage: SDK_USAGE,
    finishReason: 'stop',
    raw: { provider: 'raw-payload' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EVALUATION_INVOKER;
  h.getDynamicRoutingConfig.mockReturnValue(null);
  h.createProvider.mockReturnValue({ complete: h.complete });
  h.complete.mockResolvedValue(sdkResponse());
  h.calculateCost.mockReturnValue({ totalCost: 0.42 });
  // Pricing resolver: listModels must find the target model's pricing.
  h.getDatabase.mockResolvedValue({
    switchToTenant: vi.fn(),
    listModels: vi.fn().mockResolvedValue([
      { key: 'gpt-4o', pricing: { inputTokenPer1M: 5, outputTokenPer1M: 15 } },
    ]),
  });
});

afterEach(() => {
  delete process.env.EVALUATION_INVOKER;
});

describe('toUnifiedMessages', () => {
  it('converts system/user/assistant tool_calls/tool wire rows with id linkage', () => {
    const wire = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Ankara"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '22C', name: 'get_weather' },
      { role: 'assistant', content: 'It is 22C.' },
    ];
    expect(toUnifiedMessages(wire)).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Ankara"}' }],
      },
      { role: 'tool', content: '22C', toolCallId: 'call_1', name: 'get_weather' },
      { role: 'assistant', content: 'It is 22C.' },
    ]);
  });

  it('stringifies object arguments and synthesizes missing call ids', () => {
    const wire = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', function: { name: 'f', arguments: { a: 1 } } }],
      },
    ];
    expect(toUnifiedMessages(wire)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'f', arguments: '{"a":1}' }] },
    ]);
  });
});

describe('toSdkTools', () => {
  it('maps eval tool definitions, defaulting description and parameters', () => {
    expect(
      toSdkTools([
        { name: 'search', description: 'find things', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
        { name: 'noop' },
      ]),
    ).toEqual([
      { name: 'search', description: 'find things', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'noop', description: '', parameters: { type: 'object', properties: {} } },
    ]);
  });

  it('returns undefined for absent/empty tool lists', () => {
    expect(toSdkTools(undefined)).toBeUndefined();
    expect(toSdkTools([])).toBeUndefined();
  });
});

describe('normalizeSdkToolCalls', () => {
  it('accepts object args, parses JSON-string args, wraps invalid JSON as __raw', () => {
    expect(
      normalizeSdkToolCalls([
        { id: '1', name: 'obj', arguments: { a: 1 } },
        { id: '2', name: 'str', arguments: '{"b":2}' },
        { id: '3', name: 'bad', arguments: '{not json' },
        { id: '4', name: 'empty', arguments: '' },
        { id: '5', name: '', arguments: '{}' },
      ]),
    ).toEqual([
      { name: 'obj', args: { a: 1 } },
      { name: 'str', args: { b: 2 } },
      { name: 'bad', args: { __raw: '{not json' } },
      { name: 'empty', args: {} },
    ]);
  });
});

describe('resolveSdkProviderConfig — driver mapping table', () => {
  it('maps openai (with optional organization)', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai', { organization: 'org-1' }));
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.toEqual({
      provider: 'openai',
      apiKey: 'sk-test',
      organization: 'org-1',
    });
  });

  it('maps openai-compatible with the record baseUrl', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(
      providerRecord('openai-compatible', { baseUrl: 'https://my-vllm.local/v1' }),
    );
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.toEqual({
      provider: 'openai-compatible',
      apiKey: 'sk-test',
      baseURL: 'https://my-vllm.local/v1',
    });
  });

  it('maps together onto openai-compatible with the Together base URL', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('together'));
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.toEqual({
      provider: 'openai-compatible',
      apiKey: 'sk-test',
      baseURL: 'https://api.together.xyz/v1',
    });
  });

  it('maps azure (endpoint derived from instanceName + deployment/apiVersion)', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(
      providerRecord('azure', { instanceName: 'my-res', deploymentName: 'gpt4o-dep', apiVersion: '2024-08-01-preview' }),
    );
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.toEqual({
      provider: 'azure',
      apiKey: 'sk-test',
      endpoint: 'https://my-res.openai.azure.com',
      deploymentName: 'gpt4o-dep',
      apiVersion: '2024-08-01-preview',
    });
  });

  it('maps bedrock (region from settings, keys from credentials)', async () => {
    h.loadProviderRuntimeData.mockResolvedValue({
      record: { key: 'prov', type: 'model', driver: 'bedrock', settings: { region: 'us-east-1' } },
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'shh', sessionToken: 'tok' },
    });
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.toEqual({
      provider: 'bedrock',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
      sessionToken: 'tok',
    });
  });

  it('maps vertex (projectId/location from settings, serviceAccountJson from credentials)', async () => {
    h.loadProviderRuntimeData.mockResolvedValue({
      record: { key: 'prov', type: 'model', driver: 'vertex', settings: { projectId: 'gcp-proj', location: 'us-central1' } },
      credentials: { serviceAccountKey: '{"type":"service_account"}' },
    });
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.toEqual({
      provider: 'vertex',
      projectId: 'gcp-proj',
      location: 'us-central1',
      serviceAccountJson: '{"type":"service_account"}',
    });
  });

  it('throws the typed mapping error for unmappable drivers', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('cohere'));
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).rejects.toBeInstanceOf(SdkProviderMappingError);
  });

  it('throws the typed mapping error for dynamic-routing models (before provider load)', async () => {
    h.getDynamicRoutingConfig.mockReturnValue({ strategy: 'rule-based' });
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).rejects.toBeInstanceOf(SdkProviderMappingError);
    expect(h.loadProviderRuntimeData).not.toHaveBeenCalled();
  });

  it('throws the typed mapping error when a required field is missing', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai-compatible', {}));
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).rejects.toBeInstanceOf(SdkProviderMappingError);
  });
});

describe('invokeChatViaSdk', () => {
  it('completes with model id, converted messages/tools, and maps usage + toolCalls', async () => {
    h.complete.mockResolvedValue(
      sdkResponse({
        content: null,
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Ankara"}' }],
        finishReason: 'tool_calls',
      }),
    );
    const result = await invokeChatViaSdk(
      { tenantDbName: 'tenant_db', projectId: 'p1' },
      makeModel({ settings: { temperature: 0.2, maxTokens: 512 } }),
      [{ role: 'user', content: 'weather?' }],
      {
        tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
        config: { provider: 'openai', apiKey: 'sk-test' },
      },
    );

    expect(h.createProvider).toHaveBeenCalledWith({ provider: 'openai', apiKey: 'sk-test' });
    expect(h.complete).toHaveBeenCalledWith({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'weather?' }],
      temperature: 0.2,
      maxTokens: 512,
      tools: [{ name: 'get_weather', description: '', parameters: { type: 'object' } }],
      toolChoice: 'auto',
    });
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ name: 'get_weather', args: { city: 'Ankara' } }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
    expect(result.raw).toEqual({ provider: 'raw-payload' });
    expect(typeof result.latencyMs).toBe('number');
  });

  it('forwards settings.requestDefaults/extraBody via extra', async () => {
    await invokeChatViaSdk(
      { tenantDbName: 'tenant_db', projectId: 'p1' },
      makeModel({ settings: { requestDefaults: { top_k: 40 }, extraBody: { repetition_penalty: 1.1 } } }),
      [{ role: 'user', content: 'hi' }],
      { config: { provider: 'openai', apiKey: 'sk-test' } },
    );
    expect(h.complete).toHaveBeenCalledWith(
      expect.objectContaining({ extra: { top_k: 40, repetition_penalty: 1.1 } }),
    );
  });
});

describe('adapter wiring — buildTargetInvoker (model targets)', () => {
  const target = { key: 'tgt', kind: 'model', modelKey: 'gpt-4o' } as IEvaluationTarget;
  const item: DatasetItem = {
    id: 'i1',
    input: [{ role: 'user', content: 'weather?' }],
    tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
  };

  it('uses the SDK path by default and prices usage with hub pricing', async () => {
    h.getModelByKey.mockResolvedValue(makeModel());
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai'));
    h.complete.mockResolvedValue(
      sdkResponse({ toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{}' }] }),
    );

    const output = await buildTargetInvoker(target, CTX)(item);

    expect(h.handleChatCompletion).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        toolChoice: 'auto',
        tools: [{ name: 'get_weather', description: '', parameters: { type: 'object' } }],
      }),
    );
    expect(output.text).toBe('hello');
    expect(output.toolCalls).toEqual([{ name: 'get_weather', args: {} }]);
    expect(output.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, costUsd: 0.42 });
    expect(h.calculateCost).toHaveBeenCalledWith(
      { inputTokenPer1M: 5, outputTokenPer1M: 15 },
      { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
    );
  });

  it('falls back to the gateway when EVALUATION_INVOKER=gateway', async () => {
    process.env.EVALUATION_INVOKER = 'gateway';
    h.handleChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: 'from-gateway' } }] },
      latencyMs: 12,
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    const output = await buildTargetInvoker(target, CTX)(item);

    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.handleChatCompletion).toHaveBeenCalledTimes(1);
    expect(output.text).toBe('from-gateway');
  });

  it('falls back to the gateway on a typed mapping failure (unmappable driver)', async () => {
    h.getModelByKey.mockResolvedValue(makeModel({ providerDriver: 'cohere' }));
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('cohere'));
    h.handleChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: 'gateway-cohere' } }] },
      latencyMs: 9,
    });

    const output = await buildTargetInvoker(target, CTX)(item);

    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.handleChatCompletion).toHaveBeenCalledTimes(1);
    expect(output.text).toBe('gateway-cohere');
  });

  it('does NOT fall back on runtime provider errors — they surface as the item error', async () => {
    h.getModelByKey.mockResolvedValue(makeModel());
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai'));
    h.complete.mockRejectedValue(new Error('OpenAI API error 401: bad key'));

    await expect(buildTargetInvoker(target, CTX)(item)).rejects.toThrow('OpenAI API error 401');
    expect(h.handleChatCompletion).not.toHaveBeenCalled();
  });
});

describe('adapter wiring — buildJudgeInvoker', () => {
  const judgeMessages = [
    { role: 'system' as const, content: 'You are a judge.' },
    { role: 'user' as const, content: 'Grade this.' },
  ];

  it('uses the SDK path by default (no tools) and returns the text', async () => {
    h.getModelByKey.mockResolvedValue(makeModel({ key: 'judge', modelId: 'gpt-4o-mini' }));
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai'));
    h.complete.mockResolvedValue(sdkResponse({ content: 'verdict: pass' }));

    const text = await buildJudgeInvoker('judge', CTX)(judgeMessages);

    expect(text).toBe('verdict: pass');
    expect(h.handleChatCompletion).not.toHaveBeenCalled();
    const request = h.complete.mock.calls[0][0];
    expect(request.tools).toBeUndefined();
    expect(request.messages).toEqual([
      { role: 'system', content: 'You are a judge.' },
      { role: 'user', content: 'Grade this.' },
    ]);
  });

  it('falls back to the gateway when EVALUATION_INVOKER=gateway', async () => {
    process.env.EVALUATION_INVOKER = 'gateway';
    h.handleChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: 'gateway-verdict' } }] },
    });

    const text = await buildJudgeInvoker('judge', CTX)(judgeMessages);

    expect(text).toBe('gateway-verdict');
    expect(h.createProvider).not.toHaveBeenCalled();
  });
});
