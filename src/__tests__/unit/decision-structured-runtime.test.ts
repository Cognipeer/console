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
  const invoke = vi.fn().mockResolvedValue(message);
  const createChatModel = vi.fn().mockReturnValue({ invoke });
  const runtime: ModelProviderRuntime = { createChatModel };
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
    const [messages, callOptions] = invoke.mock.calls[0];
    expect(callOptions.response_format.type).toBe('json_schema');
    expect(callOptions.response_format.json_schema.strict).toBe(true);
    expect(Object.keys(callOptions.response_format.json_schema.schema.properties.answers.properties)).toEqual(['sentiment', 'urgent']);
    expect(JSON.stringify(messages)).toContain('Great service, thanks!');

    expect(result.answers.sentiment).toMatchObject({ type: 'choice', choice: 'pos', confidence_source: 'self_reported' });
    expect(result.answers.urgent).toEqual({ type: 'boolean', probability: 0.05 });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 18 });
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

  it('sends image parts as image_url content', async () => {
    const { runtime, invoke } = fakeRuntime({ content: '{"answers":{}}' });
    await createStructuredDecisionRuntime(runtime, config, 'openai').decide({
      ...request,
      input: [{ type: 'text', text: 'look' }, { type: 'image', data_url: 'data:image/png;base64,AAAA' }],
    });
    expect(JSON.stringify(invoke.mock.calls[0][0])).toContain('image_url');
  });

  it('tolerates a fenced / prefixed JSON answer', async () => {
    const { runtime } = fakeRuntime({
      content: 'Sure!\n{"answers":{"sentiment":{"pos":0.2,"neg":0.8},"urgent":0.5}}',
    });
    const result = await createStructuredDecisionRuntime(runtime, config, 'openai').decide(request);
    expect(result.answers.sentiment).toMatchObject({ choice: 'neg' });
  });

  it('turns an upstream refusal into refusal answers, keeping usage', async () => {
    const { runtime } = fakeRuntime({
      content: '',
      additional_kwargs: { refusal: 'I cannot help with that.' },
      usage_metadata: { input_tokens: 10, output_tokens: 4 },
    });
    const result = await createStructuredDecisionRuntime(runtime, config, 'openai').decide(request);
    expect(result.answers).toEqual({ sentiment: { type: 'refusal' }, urgent: { type: 'refusal' } });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
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
    const plain = await openai.createChatModel!({ modelId: 'gpt-4o', category: 'llm', modelSettings: { temperature: 0 } }) as { temperature?: number };
    const reasoning = await openai.createChatModel!({ modelId: 'gpt-5.6-terra', category: 'llm', modelSettings: { temperature: 0 } }) as { temperature?: number };
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
      expect(contract.capabilities?.['decision.native']).toBe(false);
      expect(contract.domains).toContain('decision');
    }
    expect(AnthropicModelProviderContract.capabilities?.['model.categories'] ?? []).not.toContain('decision');
  });
});
