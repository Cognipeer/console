import { describe, expect, it, vi } from 'vitest';
import {
  DecisionBackendError,
  createStructuredDecisionRuntime,
} from '@/lib/providers/contracts/structuredDecisionRuntime';
import {
  AnthropicModelProviderContract,
  AzureModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  OpenAiModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import { detectUnsupportedParams } from '@/lib/providers/unsupportedParams';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import type { DecisionRequest } from '@/lib/providers/domains/decision';

const request: DecisionRequest = {
  input: [{ type: 'text', text: 'Great service, thanks!' }],
  questions: {
    sentiment: { type: 'choice', choices: { pos: 'positive', neg: 'negative' } },
    urgent: { type: 'boolean' },
  },
};

function fakeRuntime(message: Record<string, unknown>) {
  const { content, usage_metadata: meta, additional_kwargs: kwargs, ...rest } = message as {
    content?: string; usage_metadata?: { input_tokens: number; output_tokens: number }; additional_kwargs?: { refusal?: string };
  };
  const invoke = vi.fn().mockResolvedValue({
    id: 'r1',
    model: 'gpt-4o',
    content: content ?? null,
    toolCalls: [],
    usage: {
      inputTokens: meta?.input_tokens ?? 0, outputTokens: meta?.output_tokens ?? 0,
      totalTokens: (meta?.input_tokens ?? 0) + (meta?.output_tokens ?? 0),
      cachedInputTokens: 0, cachedWriteTokens: 0, cachedOutputTokens: 0, reasoningTokens: 0,
    },
    finishReason: 'stop',
    ...(kwargs?.refusal ? { providerFields: { refusal: kwargs.refusal } } : {}),
    ...rest,
    raw: {},
  });
  const createChatModel = vi.fn().mockResolvedValue({ complete: invoke });
  const runtime: ModelProviderRuntime = { createNativeChatClient: createChatModel };
  return { runtime, invoke, createChatModel };
}

const config = { modelId: 'gpt-4o', category: 'decision' as const, modelSettings: { temperature: 0.9, decision: { mode: 'structured' } } };

describe('createStructuredDecisionRuntime', () => {
  it('makes ONE chat call with a strict json_schema and derives the answers', async () => {
    const { runtime, invoke, createChatModel } = fakeRuntime({
      content: JSON.stringify({ answers: { sentiment: { pos: 0.9, neg: 0.1 }, urgent: 0.05 } }),
      usage_metadata: { input_tokens: 120, output_tokens: 18 },
    });

    const result = await createStructuredDecisionRuntime(runtime, config, 'openai').decide(request);

    expect(createChatModel).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [{ messages, responseFormat }] = invoke.mock.calls[0];
    expect(responseFormat.type).toBe('json_schema');
    expect(Object.keys(responseFormat.schema.properties.answers.properties)).toEqual(['sentiment', 'urgent']);
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(JSON.stringify(messages)).toContain('Great service, thanks!');

    expect(result.answers.sentiment).toMatchObject({ type: 'choice', choice: 'pos', confidence_source: 'self_reported' });
    expect(result.answers.urgent).toEqual({ type: 'boolean', probability: 0.05 });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 18, totalTokens: 138 });
    expect(result.backend).toEqual({ kind: 'structured', provider: 'openai' });
  });

  it('builds the chat model with temperature 0 as a model setting, so unsupportedParams can still strip it', async () => {
    const { runtime, createChatModel } = fakeRuntime({ content: '{"answers":{}}' });
    await createStructuredDecisionRuntime(runtime, config, 'openai').decide(request);

    const built = createChatModel.mock.calls[0][0];
    expect(built.category).toBe('llm');
    expect(built.modelSettings.temperature).toBe(0);
    expect(built.options.maxRetries).toBe(0);

    // The gpt-5 family's registry rule is what drops temperature on the wire;
    // that stripping lives in createChatModel and is reused, not re-done here.
    expect(detectUnsupportedParams('openai', 'gpt-5.6-terra').params).toContain('temperature');
  });

  it('sends image parts as native image content', async () => {
    const { runtime, invoke } = fakeRuntime({ content: '{"answers":{}}' });
    await createStructuredDecisionRuntime(runtime, config, 'openai').decide({
      ...request,
      input: [{ type: 'text', text: 'look' }, { type: 'image', data_url: 'data:image/png;base64,AAAA' }],
    });
    const user = invoke.mock.calls[0][0].messages[1].content as Array<Record<string, unknown>>;
    expect(user).toContainEqual({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } });
  });

  it('tolerates a fenced / prefixed JSON answer', async () => {
    const { runtime } = fakeRuntime({
      content: 'Sure!\n{"answers":{"sentiment":{"pos":0.2,"neg":0.8},"urgent":0.5}}',
    });
    const result = await createStructuredDecisionRuntime(runtime, config, 'openai').decide(request);
    expect(result.answers.sentiment).toMatchObject({ choice: 'neg' });
  });

  it('returns canonical usage: driver fold plus cache/reasoning subsets', async () => {
    const { invoke } = fakeRuntime({
      content: JSON.stringify({ answers: { sentiment: { pos: 0.9, neg: 0.1 }, urgent: 0.05 } }),
    });
    invoke.mockResolvedValue({
      id: 'r1', model: 'm', toolCalls: [], finishReason: 'stop', raw: {},
      content: JSON.stringify({ answers: { sentiment: { pos: 0.9, neg: 0.1 }, urgent: 0.05 } }),
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 90, cachedWriteTokens: 5, cachedOutputTokens: 0, reasoningTokens: 2 },
    });
    // Rebuild the client so it advertises the anthropic driver.
    const driverRuntime: ModelProviderRuntime = {
      createNativeChatClient: vi.fn().mockResolvedValue({ complete: invoke, driver: 'anthropic' }),
    };
    const result = await createStructuredDecisionRuntime(driverRuntime, config, 'anthropic').decide(request);
    expect(result.usage).toEqual({
      inputTokens: 105, outputTokens: 4, totalTokens: 109, cachedInputTokens: 90, cachedWriteTokens: 5, reasoningTokens: 2,
    });
  });

  it('turns an upstream refusal into refusal answers, keeping usage', async () => {
    const { runtime } = fakeRuntime({
      content: '',
      additional_kwargs: { refusal: 'I cannot help with that.' },
      usage_metadata: { input_tokens: 10, output_tokens: 4 },
    });
    const result = await createStructuredDecisionRuntime(runtime, config, 'openai').decide(request);
    expect(result.answers).toEqual({ sentiment: { type: 'refusal' }, urgent: { type: 'refusal' } });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  });

  it('omits usage it was not given and includes the rationale only when asked', async () => {
    const { runtime } = fakeRuntime({
      content: JSON.stringify({ rationale: 'polite tone', answers: { sentiment: { pos: 1, neg: 0 }, urgent: 0 } }),
    });
    const withRationale = await createStructuredDecisionRuntime(runtime, config, 'openai')
      .decide({ ...request, includeRationale: true });
    expect(withRationale.rationale).toBe('polite tone');
    expect(withRationale.usage).toBeUndefined();

    const without = await createStructuredDecisionRuntime(runtime, config, 'openai').decide(request);
    expect(without.rationale).toBeUndefined();
  });

  it('raises a backend error on empty or non-JSON content', async () => {
    const empty = fakeRuntime({ content: '' });
    await expect(createStructuredDecisionRuntime(empty.runtime, config, 'openai').decide(request))
      .rejects.toBeInstanceOf(DecisionBackendError);
    const prose = fakeRuntime({ content: 'I think it is positive.' });
    await expect(createStructuredDecisionRuntime(prose.runtime, config, 'openai').decide(request))
      .rejects.toBeInstanceOf(DecisionBackendError);
  });

  it('raises a backend error when the provider has no chat runtime', async () => {
    await expect(createStructuredDecisionRuntime({}, config, 'openai').decide(request))
      .rejects.toBeInstanceOf(DecisionBackendError);
  });
});

describe('driver wiring', () => {
  it('temperature 0 reaches a normal model but is stripped for the gpt-5 family (real driver)', async () => {
    const openai = await OpenAiModelProviderContract.createRuntime({ credentials: { apiKey: 'sk-test' }, settings: {} } as never);
    const plainClient = await openai.createNativeChatClient!({ modelId: 'gpt-4o', category: 'llm', modelSettings: { temperature: 0 } });
    const reasoningClient = await openai.createNativeChatClient!({ modelId: 'gpt-5.6-terra', category: 'llm', modelSettings: { temperature: 0 } });
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const plain = await plainClient.prepare({ messages });
    const reasoning = await reasoningClient.prepare({ messages });
    expect(plain.temperature).toBe(0);
    expect(reasoning.temperature).toBeUndefined();
  });

  it('the OpenAI-schema drivers serve decisions; other families do not (yet)', async () => {
    const openai = await OpenAiModelProviderContract.createRuntime({ credentials: { apiKey: 'sk-test' }, settings: {} } as never);
    const compat = await OpenAiCompatibleModelProviderContract.createRuntime({
      credentials: { apiKey: 'k' }, settings: { baseUrl: 'https://llm.example.com/v1' },
    } as never);
    const azure = await AzureModelProviderContract.createRuntime({
      credentials: { apiKey: 'k' },
      settings: { instanceName: 'res', deploymentName: 'dep', apiVersion: '2024-10-21' },
    } as never);
    const anthropic = await AnthropicModelProviderContract.createRuntime({ credentials: { apiKey: 'k' }, settings: {} } as never);

    expect(typeof openai.createDecisionRuntime).toBe('function');
    expect(typeof compat.createDecisionRuntime).toBe('function');
    expect(typeof azure.createDecisionRuntime).toBe('function');
    expect(anthropic.createDecisionRuntime).toBeUndefined();

    for (const contract of [OpenAiModelProviderContract, OpenAiCompatibleModelProviderContract, AzureModelProviderContract]) {
      expect(contract.capabilities?.['model.categories']).toContain('decision');
      expect(contract.capabilities?.['decision.question_types']).toEqual(['choice', 'boolean', 'score']);
      // Only api.openai.com has a native decisions endpoint.
      expect(contract.capabilities?.['decision.native']).toBe(contract === OpenAiModelProviderContract);
      expect(contract.domains).toContain('decision');
    }
    expect(AnthropicModelProviderContract.capabilities?.['model.categories'] ?? []).not.toContain('decision');
  });
});
