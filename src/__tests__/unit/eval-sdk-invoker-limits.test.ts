/**
 * Unit tests — evaluation output limits on the SDK path and the gateway fallback.
 *
 * Covers: the finish reason / sent limit returned by `invokeChatViaSdk`; the output limit resolved like a gateway
 * call (caller cap > model limit > default, thinking headroom, a caller cap never raised); the hub model's reasoning
 * default (and where it is withheld); `response_format` as the SDK's native `responseFormat`; the pinned upstream
 * API; and the adapter's verdicts on a call cut off at its limit (error when there is nothing to show, `truncated`
 * flag otherwise) for model targets and the llm-judge, on both paths, plus the `evaluation` route.
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
  assertProviderEnabled: () => undefined,
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

import { invokeChatViaSdk, resolveSdkProviderConfig } from '@/lib/services/evaluation/sdkInvoker';
import { buildJudgeInvoker, buildTargetInvoker } from '@/lib/services/evaluation/adapters';
import type { EvaluationModelContext } from '@/lib/services/evaluation/adapters';
import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { ADAPTIVE_MIN_OUTPUT_TOKENS } from '@/lib/services/models/outputLimits';
import { SDK_THINKING_MIN_MAX_TOKENS, SDK_THINKING_OUTPUT_RESERVE } from '@/lib/services/models/reasoning';
import type { IEvaluationTarget, IModel } from '@/lib/database';
import type { DatasetItem } from '@/lib/services/evaluation/types';

const CTX: EvaluationModelContext = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1' };
const INVOKE_CTX = { tenantDbName: 'tenant_db', projectId: 'p1' };
const OPENAI = { provider: 'openai', apiKey: 'sk-test' } as const;
const BEDROCK = { provider: 'bedrock', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'shh' } as const;
const MESSAGES = [{ role: 'user', content: 'hi' }];

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

/** The request the (mocked) provider received on its first call. */
function sentRequest(): Record<string, unknown> {
  return h.complete.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.EVALUATION_INVOKER;
  h.getDynamicRoutingConfig.mockReturnValue(null);
  h.createProvider.mockReturnValue({ complete: h.complete });
  h.complete.mockResolvedValue(sdkResponse());
  h.calculateCost.mockReturnValue({ totalCost: 0.42 });
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

describe('invokeChatViaSdk — result', () => {
  it('returns the finish reason, the provider stop reason and the limit the call was sent with', async () => {
    h.complete.mockResolvedValue(sdkResponse({ finishReason: 'length', rawFinishReason: 'max_tokens' }));
    const result = await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({ settings: { maxTokens: 512 } }),
      MESSAGES,
      { config: OPENAI },
    );
    expect(result.finishReason).toBe('length');
    expect(result.rawFinishReason).toBe('max_tokens');
    expect(result.outputTokenLimit).toBe(512);
  });

  it('leaves out what the provider did not say and the limit when none was sent', async () => {
    h.complete.mockResolvedValue(sdkResponse({ finishReason: undefined }));
    const result = await invokeChatViaSdk(INVOKE_CTX, makeModel(), MESSAGES, { config: OPENAI });
    expect(result).not.toHaveProperty('finishReason');
    expect(result).not.toHaveProperty('rawFinishReason');
    expect(result).not.toHaveProperty('outputTokenLimit');
    const request = sentRequest();
    expect(request).not.toHaveProperty('maxTokens');
    expect(request).not.toHaveProperty('reasoning');
    expect(request).not.toHaveProperty('responseFormat');
  });
});

describe('invokeChatViaSdk — output limit', () => {
  it('the caller cap beats the model limit', async () => {
    await invokeChatViaSdk(INVOKE_CTX, makeModel({ settings: { maxTokens: 512 } }), MESSAGES, {
      config: OPENAI,
      maxTokens: 100,
    });
    expect(sentRequest().maxTokens).toBe(100);
  });

  it("the model's Default max tokens beats the default of the call; maxCompletionTokens beats maxTokens", async () => {
    await invokeChatViaSdk(INVOKE_CTX, makeModel({ settings: { maxTokens: 1000 } }), MESSAGES, {
      config: OPENAI,
      defaultMaxTokens: 4096,
    });
    expect(sentRequest().maxTokens).toBe(1000);

    h.complete.mockClear();
    await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({ settings: { maxTokens: 1000, maxCompletionTokens: 2000 } }),
      MESSAGES,
      { config: OPENAI },
    );
    expect(sentRequest().maxTokens).toBe(2000);
  });

  it("the default of the call applies when neither the caller nor the model's record sets a limit", async () => {
    const result = await invokeChatViaSdk(INVOKE_CTX, makeModel(), MESSAGES, { config: OPENAI, defaultMaxTokens: 4096 });
    expect(sentRequest().maxTokens).toBe(4096);
    expect(result.outputTokenLimit).toBe(4096);
  });

  it("an openai reasoning model's small limit is raised to the table value of its effort (a model-configured limit)", async () => {
    const result = await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({ modelId: 'gpt-5.2', settings: { maxTokens: 400, reasoning: { effort: 'high' } } }),
      MESSAGES,
      { config: OPENAI },
    );
    expect(sentRequest().maxTokens).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.high);
    expect(result.outputTokenLimit).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.high);
  });

  it("but never a caller's own cap", async () => {
    await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({ modelId: 'gpt-5.2', settings: { maxTokens: 400, reasoning: { effort: 'high' } } }),
      MESSAGES,
      { config: OPENAI, maxTokens: 300 },
    );
    expect(sentRequest().maxTokens).toBe(300);
  });

  it('bedrock Claude: the limit gets the adaptive-thinking headroom of the configured effort', async () => {
    await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({
        providerDriver: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-5-5-v1:0',
        settings: { maxTokens: 2000, reasoning: { effort: 'high' } },
      }),
      MESSAGES,
      { config: BEDROCK },
    );
    expect(sentRequest().maxTokens).toBe(ADAPTIVE_MIN_OUTPUT_TOKENS.high);
    expect(sentRequest().reasoning).toEqual({ effort: 'high' });
  });

  it('a caller cap leaves a thinking budget no room: the budget is fitted under it, or thinking is dropped', async () => {
    const model = makeModel({
      providerDriver: 'bedrock',
      modelId: 'eu.anthropic.claude-sonnet-4-5-v1:0',
      settings: { reasoning: { budgetTokens: 5000 } },
    });

    // Below the floor the SDK needs to think at all: the call runs without thinking, at the caller's limit.
    await invokeChatViaSdk(INVOKE_CTX, model, MESSAGES, { config: BEDROCK, maxTokens: SDK_THINKING_MIN_MAX_TOKENS - 1 });
    expect(sentRequest().maxTokens).toBe(SDK_THINKING_MIN_MAX_TOKENS - 1);
    expect(sentRequest()).not.toHaveProperty('reasoning');

    // A cap the budget does not fit under: the budget shrinks to what fits, the cap stays.
    h.complete.mockClear();
    await invokeChatViaSdk(INVOKE_CTX, model, MESSAGES, { config: BEDROCK, maxTokens: 5000 });
    expect(sentRequest().maxTokens).toBe(5000);
    expect(sentRequest().reasoning).toEqual({ budgetTokens: 5000 - SDK_THINKING_OUTPUT_RESERVE });
  });
});

describe('invokeChatViaSdk — reasoning default of the hub model', () => {
  it('sends the model reasoning default on the request', async () => {
    await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({ settings: { reasoning: { effort: 'low', summary: 'auto' } } }),
      MESSAGES,
      { config: OPENAI },
    );
    // Normalized like the native client does: the legacy summary key is not carried.
    expect(sentRequest().reasoning).toEqual({ effort: 'low' });
  });

  it('sends nothing when the model has none', async () => {
    await invokeChatViaSdk(INVOKE_CTX, makeModel(), MESSAGES, { config: OPENAI });
    expect(sentRequest()).not.toHaveProperty('reasoning');
  });

  it('bedrock non-Claude families keep their own envelope: no reasoning, no raised limit', async () => {
    await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({
        providerDriver: 'bedrock',
        modelId: 'amazon.nova-pro-v1:0',
        settings: { maxTokens: 700, reasoning: { effort: 'high' } },
      }),
      MESSAGES,
      { config: BEDROCK },
    );
    expect(sentRequest()).not.toHaveProperty('reasoning');
    expect(sentRequest().maxTokens).toBe(700);
  });

  it('a thinking block the operator put in the extra body is the whole instruction on bedrock Claude', async () => {
    await invokeChatViaSdk(
      INVOKE_CTX,
      makeModel({
        providerDriver: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-5-5-v1:0',
        settings: {
          maxTokens: 2000,
          reasoning: { effort: 'high' },
          extraBody: { thinking: { type: 'enabled', budget_tokens: 1024 } },
        },
      }),
      MESSAGES,
      { config: BEDROCK },
    );
    const request = sentRequest();
    expect(request).not.toHaveProperty('reasoning');
    expect(request.maxTokens).toBe(2000);
    expect(request.extra).toEqual({ thinking: { type: 'enabled', budget_tokens: 1024 } });
  });
});

describe('invokeChatViaSdk — response format', () => {
  it("sends the OpenAI-shaped response_format as the SDK's native responseFormat, not through extra", async () => {
    await invokeChatViaSdk(INVOKE_CTX, makeModel(), MESSAGES, {
      config: OPENAI,
      responseFormat: { type: 'json_schema', json_schema: { name: 'verdict', schema: { type: 'object' } } },
    });
    const request = sentRequest();
    expect(request.responseFormat).toEqual({ type: 'json_schema', name: 'verdict', schema: { type: 'object' } });
    expect(request).not.toHaveProperty('extra');
  });

  it('keeps the operator extra body apart from it', async () => {
    await invokeChatViaSdk(INVOKE_CTX, makeModel({ settings: { extraBody: { top_k: 40 } } }), MESSAGES, {
      config: OPENAI,
      responseFormat: { type: 'json_object' },
    });
    const request = sentRequest();
    expect(request.responseFormat).toEqual({ type: 'json_object' });
    expect(request.extra).toEqual({ top_k: 40 });
  });
});

describe('resolveSdkProviderConfig — upstream API pin', () => {
  it('pins openai to the model upstream API (Chat Completions unless the operator chose Responses)', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai'));
    await expect(resolveSdkProviderConfig('tenant_db', makeModel({ settings: { upstreamApi: 'responses' } })))
      .resolves.toMatchObject({ provider: 'openai', api: 'responses' });
    await expect(resolveSdkProviderConfig('tenant_db', makeModel()))
      .resolves.toMatchObject({ provider: 'openai', api: 'chat' });
  });

  it('pins azure the same way: a Responses model on an older provider api-version is upgraded like the gateway does, and never pinned to Responses when its own api-version override predates the route', async () => {
    const azure = (apiVersion: string) =>
      providerRecord('azure', { instanceName: 'my-res', deploymentName: 'dep', apiVersion });
    const responses = makeModel({ settings: { upstreamApi: 'responses' } });

    h.loadProviderRuntimeData.mockResolvedValue(azure('2025-04-01-preview'));
    await expect(resolveSdkProviderConfig('tenant_db', responses)).resolves.toMatchObject({ api: 'responses' });

    // The gateway upgrades a Responses model's older provider api-version; the evaluation path now does the same.
    h.loadProviderRuntimeData.mockResolvedValue(azure('2024-10-21'));
    await expect(resolveSdkProviderConfig('tenant_db', responses)).resolves.toMatchObject({
      api: 'responses', apiVersion: '2025-04-01-preview',
    });

    // A model-level api-version override older than the route is kept, so Responses is not pinned.
    const pinnedOld = makeModel({ settings: { upstreamApi: 'responses', azureApiVersion: '2024-10-21' } });
    await expect(resolveSdkProviderConfig('tenant_db', pinnedOld)).resolves.toMatchObject({
      api: 'chat', apiVersion: '2024-10-21',
    });

    h.loadProviderRuntimeData.mockResolvedValue(azure('2025-04-01-preview'));
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.toMatchObject({ api: 'chat' });
  });

  it('leaves the other drivers alone', async () => {
    h.loadProviderRuntimeData.mockResolvedValue(
      providerRecord('openai-compatible', { baseUrl: 'https://my-vllm.local/v1' }),
    );
    await expect(resolveSdkProviderConfig('tenant_db', makeModel())).resolves.not.toHaveProperty('api');
  });
});

describe('model targets — a call cut off at its output limit (SDK path)', () => {
  const target = { key: 'tgt', kind: 'model', modelKey: 'gpt-4o' } as IEvaluationTarget;
  const item: DatasetItem = { id: 'i1', input: [{ role: 'user', content: 'tell me a lot' }] };
  const toolItem: DatasetItem = {
    ...item,
    tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
  };

  beforeEach(() => {
    h.getModelByKey.mockResolvedValue(makeModel({ settings: { maxTokens: 512 } }));
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai'));
  });

  it('returns a partial answer flagged truncated', async () => {
    h.complete.mockResolvedValue(sdkResponse({ content: 'It was a dark and', finishReason: 'length' }));
    const output = await buildTargetInvoker(target, CTX)(item);
    expect(output.text).toBe('It was a dark and');
    expect(output).toMatchObject({ truncated: true });
  });

  it('does not flag a finished answer', async () => {
    const output = await buildTargetInvoker(target, CTX)(item);
    expect(output).not.toHaveProperty('truncated');
  });

  it('fails the item, naming the limit and carrying what the call burned, when there is nothing to show', async () => {
    h.complete.mockResolvedValue(sdkResponse({ content: '', finishReason: 'length', rawFinishReason: 'max_tokens' }));
    const error = await buildTargetInvoker(target, CTX)(item).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutputTokenLimitError);
    const limitError = error as OutputTokenLimitError;
    expect(limitError.limit).toBe(512);
    expect(limitError.rawFinishReason).toBe('max_tokens');
    expect(limitError.usage).toMatchObject({ outputTokens: 5 });
    expect(limitError.message).toMatch(/output token limit \(512 tokens\)/);
  });

  it('an unterminated reasoning block is not an answer either', async () => {
    h.complete.mockResolvedValue(sdkResponse({ content: '<think>let me think about', finishReason: 'length' }));
    await expect(buildTargetInvoker(target, CTX)(item)).rejects.toBeInstanceOf(OutputTokenLimitError);
  });

  it('a cut-off tool call is captured and flagged, not an error', async () => {
    h.complete.mockResolvedValue(
      sdkResponse({
        content: '',
        toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":' }],
        finishReason: 'length',
      }),
    );
    const output = await buildTargetInvoker(target, CTX)(toolItem);
    expect(output.toolCalls).toEqual([{ name: 'get_weather', args: { __raw: '{"city":' } }]);
    expect(output).toMatchObject({ truncated: true });
  });

  it("an explicit target.maxTokens is the caller's cap", async () => {
    await buildTargetInvoker({ ...target, maxTokens: 64 } as IEvaluationTarget, CTX)(item);
    expect(sentRequest().maxTokens).toBe(64);
  });
});

describe('llm-judge — output limit', () => {
  const judgeMessages = [
    { role: 'system' as const, content: 'You are a judge.' },
    { role: 'user' as const, content: 'Grade this.' },
  ];

  beforeEach(() => {
    h.getModelByKey.mockResolvedValue(makeModel({ key: 'judge', modelId: 'gpt-4o-mini' }));
    h.loadProviderRuntimeData.mockResolvedValue(providerRecord('openai'));
  });

  it('is sent an explicit limit when the judge model has none', async () => {
    await buildJudgeInvoker('judge', CTX)(judgeMessages);
    expect(sentRequest().maxTokens).toBe(4096);
  });

  it("the judge model's own Default max tokens wins over it", async () => {
    h.getModelByKey.mockResolvedValue(makeModel({ key: 'judge', settings: { maxTokens: 1500 } }));
    await buildJudgeInvoker('judge', CTX)(judgeMessages);
    expect(sentRequest().maxTokens).toBe(1500);
  });

  it('fails with the output limit when a reasoning judge answered nothing', async () => {
    h.complete.mockResolvedValue(sdkResponse({ content: '', finishReason: 'length' }));
    await expect(buildJudgeInvoker('judge', CTX)(judgeMessages)).rejects.toThrow(/output token limit \(4096 tokens\)/);
  });

  it('hands a cut-off verdict with text to the scorer (which cannot parse it, and says so)', async () => {
    h.complete.mockResolvedValue(sdkResponse({ content: '{"score": 0.', finishReason: 'length' }));
    await expect(buildJudgeInvoker('judge', CTX)(judgeMessages)).resolves.toBe('{"score": 0.');
  });
});

describe('gateway fallback — route and truncation', () => {
  beforeEach(() => {
    process.env.EVALUATION_INVOKER = 'gateway';
  });

  const target = { key: 'tgt', kind: 'model', modelKey: 'gpt-4o', maxTokens: 256 } as IEvaluationTarget;
  const item: DatasetItem = { id: 'i1', input: [{ role: 'user', content: 'hi' }] };

  it("runs model targets on the 'evaluation' route and flags a reply cut off at the limit", async () => {
    h.handleChatCompletion.mockResolvedValue({
      response: { choices: [{ finish_reason: 'length', message: { content: 'partial answer' } }] },
      latencyMs: 12,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    const output = await buildTargetInvoker(target, CTX)(item);

    const call = h.handleChatCompletion.mock.calls[0][0];
    expect(call.route).toBe('evaluation');
    expect(call.body.max_tokens).toBe(256);
    expect(output.text).toBe('partial answer');
    expect(output).toMatchObject({ truncated: true });
  });

  it('does not flag a finished reply (the gateway itself fails a cut-off one with nothing to show)', async () => {
    h.handleChatCompletion.mockResolvedValue({
      response: { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] },
      latencyMs: 12,
    });
    const output = await buildTargetInvoker(target, CTX)(item);
    expect(output).not.toHaveProperty('truncated');
  });

  it("runs the judge on the 'evaluation' route and leaves its limit to the gateway", async () => {
    h.handleChatCompletion.mockResolvedValue({
      response: { choices: [{ finish_reason: 'stop', message: { content: 'verdict' } }] },
    });
    await expect(buildJudgeInvoker('judge', CTX)([{ role: 'user', content: 'Grade.' }])).resolves.toBe('verdict');

    const call = h.handleChatCompletion.mock.calls[0][0];
    expect(call.route).toBe('evaluation');
    expect(call.body).not.toHaveProperty('max_tokens');
  });
});
