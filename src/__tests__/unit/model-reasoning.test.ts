import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import {
  normalizeReasoning,
  readRequestReasoning,
  resolveGatewayReasoning,
  shouldReturnReasoning,
  translateAnthropicThinking,
  translateVertexThinking,
  reasoningControlForDriver,
  describeEffectiveReasoning,
} from '@/lib/services/models/reasoning';
import {
  reasoningFormFromSettings,
  reasoningSettingsPatch,
  EMPTY_REASONING_FORM,
} from '@/components/models/reasoningForm';
import {
  AnthropicModelProviderContract,
  BedrockModelProviderContract,
  VertexModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import { toOpenAIChatResponse, toOpenAIStreamChunk } from '@/lib/services/models/openaiAdapter';
import {
  anthropicRequestToOpenAi,
  openAiResponseToAnthropic,
  openAiStreamToAnthropic,
} from '@/lib/services/models/anthropicWire';
import { normalizeModelSettings } from '@/lib/services/models/modelSettings';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';

vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('k'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...original, logModelUsage: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({ action: 'allow', findings: [] }),
  createStreamGate: vi.fn().mockReturnValue(undefined),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';

describe('reasoning: normalization', () => {
  it('reads the typed shape, the legacy shape, request shapes and bare strings', () => {
    expect(normalizeReasoning({ effort: 'high', budgetTokens: 4000, includeThoughts: false }))
      .toEqual({ effort: 'high', budgetTokens: 4000, includeThoughts: false });
    expect(normalizeReasoning({ effort: 'low', summary: 'auto' })).toEqual({ effort: 'low', summary: 'auto' });
    expect(normalizeReasoning({ effort: 'medium', max_tokens: 3000 })).toEqual({ effort: 'medium', budgetTokens: 3000 });
    expect(normalizeReasoning('minimal')).toEqual({ effort: 'minimal' });
    expect(normalizeReasoning({ effort: 'bogus' })).toBeUndefined();
    expect(normalizeReasoning({})).toBeUndefined();
    expect(normalizeReasoning(null)).toBeUndefined();
  });

  it('reads a request: reasoning object beats reasoning_effort; anthropic thinking is understood', () => {
    expect(readRequestReasoning({ reasoning_effort: 'low' })).toEqual({ effort: 'low' });
    expect(readRequestReasoning({ reasoning_effort: 'low', reasoning: { effort: 'high' } })).toEqual({ effort: 'high' });
    expect(readRequestReasoning({ thinking: { type: 'enabled', budget_tokens: 5000 } })).toEqual({ budgetTokens: 5000 });
    expect(readRequestReasoning({ thinking: { type: 'disabled' } })).toEqual({ effort: 'none' });
    expect(readRequestReasoning({})).toBeUndefined();
  });
});

describe('reasoning: precedence for direct model calls', () => {
  const cases: Array<[string, unknown, unknown, string, unknown]> = [
    ['model default wins over the request', { reasoning: { effort: 'high' } }, { reasoning_effort: 'low' }, 'model', { effort: 'high' }],
    ['model default wins over a reasoning object', { reasoning: { effort: 'low' } }, { reasoning: { effort: 'high' } }, 'model', { effort: 'low' }],
    ['request used when the model has none', {}, { reasoning_effort: 'low' }, 'request', { effort: 'low' }],
    ['request object used when the model has none', { temperature: 1 }, { reasoning: { effort: 'medium' } }, 'request', { effort: 'medium' }],
    ['nothing when neither', {}, {}, 'none', undefined],
    ['legacy model shape counts as set', { reasoning: { effort: 'medium', summary: 'auto' } }, { reasoning_effort: 'high' }, 'model', { effort: 'medium', summary: 'auto' }],
    ['an empty model value counts as unset', { reasoning: {} }, { reasoning_effort: 'high' }, 'request', { effort: 'high' }],
    ['model none is a real setting', { reasoning: { effort: 'none' } }, { reasoning_effort: 'high' }, 'model', { effort: 'none' }],
  ];
  it.each(cases)('%s', (_name, settings, body, source, expected) => {
    const resolved = resolveGatewayReasoning(settings, body);
    expect(resolved.source).toBe(source);
    expect(resolved.reasoning).toEqual(expected);
  });
});

describe('reasoning: visibility', () => {
  it('model switch is the ceiling; a request can only narrow it', () => {
    expect(shouldReturnReasoning({}, {})).toBe(true);
    expect(shouldReturnReasoning({ returnReasoning: true }, {})).toBe(true);
    expect(shouldReturnReasoning({ returnReasoning: false }, {})).toBe(false);
    expect(shouldReturnReasoning({ returnReasoning: false }, { include_reasoning: true })).toBe(false);
    expect(shouldReturnReasoning({}, { include_reasoning: false })).toBe(false);
    expect(shouldReturnReasoning({}, { reasoning: { exclude: true } })).toBe(false);
  });
});

describe('reasoning: translation helpers', () => {
  it('anthropic: levels become budgets, max_tokens rises above the budget, sampling is dropped', () => {
    expect(translateAnthropicThinking({ effort: 'high' }, 2000)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 16384 },
      maxTokens: 16384 + 4096,
      dropSampling: true,
    });
    // A cap already above the budget is kept.
    expect(translateAnthropicThinking({ budgetTokens: 3000 }, 9000)?.maxTokens).toBe(9000);
    // Anthropic's minimum budget is 1024.
    expect(translateAnthropicThinking({ budgetTokens: 200 }, undefined)?.thinking)
      .toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(translateAnthropicThinking({ effort: 'none' }, 500))
      .toEqual({ thinking: { type: 'disabled' }, maxTokens: 500, dropSampling: false });
    expect(translateAnthropicThinking(undefined, 500)).toBeUndefined();
  });

  it('vertex: thinkingConfig, budget 0 turns thinking off', () => {
    expect(translateVertexThinking({ effort: 'low' })).toEqual({
      thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
    });
    expect(translateVertexThinking({ effort: 'none' })).toEqual({
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    });
    expect(translateVertexThinking({ budgetTokens: 5000, includeThoughts: false })?.thinkingConfig)
      .toEqual({ thinkingBudget: 5000, includeThoughts: false });
    expect(translateVertexThinking(undefined)).toBeUndefined();
  });

  it('driver controls: effort levels, budgets, on/off', () => {
    expect(reasoningControlForDriver('openai').kind).toBe('effort');
    expect(reasoningControlForDriver('azure').efforts).toContain('minimal');
    expect(reasoningControlForDriver('anthropic')).toMatchObject({ kind: 'budget', budget: true });
    expect(reasoningControlForDriver('bedrock').budget).toBe(true);
    expect(reasoningControlForDriver('vertex').kind).toBe('budget');
    expect(reasoningControlForDriver('openai-compatible')).toMatchObject({ kind: 'toggle', efforts: ['none', 'medium'] });
    expect(reasoningControlForDriver('mystery').kind).toBe('none');
  });

  it('model page description: effective value, visibility and the gpt-5 + tools rule', () => {
    expect(describeEffectiveReasoning({ settings: { reasoning: { effort: 'high' }, returnReasoning: false }, forcedNoneWithTools: true }))
      .toEqual({ reasoning: { effort: 'high' }, returned: false, forcedNoneWithTools: true });
    expect(describeEffectiveReasoning({ settings: {} }))
      .toEqual({ reasoning: undefined, returned: true, forcedNoneWithTools: false });
  });
});

describe('reasoning: form <-> settings', () => {
  it('round-trips and omits "Not set"', () => {
    expect(reasoningFormFromSettings({})).toEqual(EMPTY_REASONING_FORM);
    const form = reasoningFormFromSettings({ reasoning: { effort: 'low', budgetTokens: 3000 }, returnReasoning: false });
    expect(form).toMatchObject({ effort: 'low', budgetTokens: 3000, returnReasoning: false });
    expect(reasoningSettingsPatch(form, undefined)).toEqual({
      reasoning: { effort: 'low', budgetTokens: 3000 },
      returnReasoning: false,
    });
    // Not set: a create omits the keys, an edit sends null so the server removes them.
    expect(reasoningSettingsPatch(EMPTY_REASONING_FORM, undefined)).toEqual({ reasoning: undefined, returnReasoning: undefined });
    expect(reasoningSettingsPatch(EMPTY_REASONING_FORM, null)).toEqual({ reasoning: null, returnReasoning: null });
  });

  it('keeps the legacy summary and drops a budget next to effort none', () => {
    const patch = reasoningSettingsPatch(
      { effort: 'none', budgetTokens: 4000, includeThoughts: true, returnReasoning: true },
      null,
      { reasoning: { effort: 'low', summary: 'auto' } },
    );
    expect(patch.reasoning).toEqual({ effort: 'none', summary: 'auto' });
  });

  it('settings normalisation heals a stringified returnReasoning', () => {
    expect(normalizeModelSettings({ returnReasoning: 'false' }).returnReasoning).toBe(false);
  });
});

describe('reasoning: provider wire bodies (real LangChain clients)', () => {
  const anthropic = (modelSettings: Record<string, unknown>, modelId = 'claude-sonnet-4-5') => {
    const runtime: any = AnthropicModelProviderContract.createRuntime({ credentials: { apiKey: 'k' }, settings: {} } as any);
    return runtime.createChatModel({ modelId, modelSettings });
  };

  it('anthropic: thinking enabled, max_tokens above the budget, temperature and top_p dropped', async () => {
    const model: any = await anthropic({ temperature: 0.5, topP: 0.9, maxTokens: 2000, reasoning: { effort: 'high' } });
    const body = model.invocationParams({});
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(body.max_tokens).toBe(16384 + 4096);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('anthropic: an exact budget beats the level; a roomy cap is kept', async () => {
    const model: any = await anthropic({ maxTokens: 30000, reasoning: { effort: 'low', budgetTokens: 6000 } });
    const body = model.invocationParams({});
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 6000 });
    expect(body.max_tokens).toBe(30000);
  });

  it('anthropic: none disables thinking and keeps sampling; unset sends nothing', async () => {
    const off: any = (await anthropic({ temperature: 0.3, reasoning: { effort: 'none' } })).invocationParams({});
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.temperature).toBe(0.3);
    const unset: any = (await anthropic({ temperature: 0.3 })).invocationParams({});
    // Nothing of ours: whatever ChatAnthropic does by default, never an enabled budget.
    expect(unset.thinking?.type).not.toBe('enabled');
    expect(unset.temperature).toBe(0.3);
  });

  it('anthropic: an explicit thinking in the operator extra body wins', async () => {
    const body = (await anthropic({
      reasoning: { effort: 'high' },
      requestDefaults: { thinking: { type: 'enabled', budget_tokens: 1500 } },
    })).invocationParams({});
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1500 });
  });

  it('bedrock (Claude): thinking rides additionalModelRequestFields, cap raised, sampling dropped', async () => {
    const runtime: any = BedrockModelProviderContract.createRuntime({
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      settings: { region: 'us-east-1' },
    } as any);
    const model: any = await runtime.createChatModel({
      modelId: 'eu.anthropic.claude-sonnet-4-5',
      modelSettings: { temperature: 0.7, topP: 0.8, reasoning: { effort: 'medium' } },
    });
    const body = model.invocationParams({});
    expect(body.additionalModelRequestFields).toEqual({ thinking: { type: 'enabled', budget_tokens: 8192 } });
    expect(body.inferenceConfig.maxTokens).toBe(8192 + 4096);
    expect(body.inferenceConfig.temperature).toBeUndefined();
    expect(body.inferenceConfig.topP).toBeUndefined();
  });

  it('bedrock (non-Claude): nothing is injected', async () => {
    const runtime: any = BedrockModelProviderContract.createRuntime({
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      settings: { region: 'us-east-1' },
    } as any);
    const model: any = await runtime.createChatModel({
      modelId: 'amazon.nova-pro-v1:0',
      modelSettings: { reasoning: { effort: 'high' } },
    });
    expect(model.invocationParams({}).additionalModelRequestFields).toBeUndefined();
  });

  it('vertex: the thinking budget reaches the client (thinkingConfig is built from it)', async () => {
    const runtime: any = VertexModelProviderContract.createRuntime({
      credentials: { serviceAccountKey: JSON.stringify({ client_email: 'a@b.c', private_key: 'k' }) },
      settings: { projectId: 'p', location: 'us-central1' },
    } as any);
    const model: any = await runtime.createChatModel({ modelId: 'gemini-2.5-pro', modelSettings: { reasoning: { effort: 'low' } } });
    expect(model.invocationParams({}).maxReasoningTokens).toBe(2048);
    const off: any = await runtime.createChatModel({ modelId: 'gemini-2.5-pro', modelSettings: { reasoning: { effort: 'none' } } });
    expect(off.invocationParams({}).maxReasoningTokens).toBe(0);
    const unset: any = await runtime.createChatModel({ modelId: 'gemini-2.5-pro', modelSettings: {} });
    expect(unset.invocationParams({}).maxReasoningTokens).toBeUndefined();
  });

  it('vertex: a cap at or under the budget is raised so the client does not throw', async () => {
    const runtime: any = VertexModelProviderContract.createRuntime({
      credentials: { serviceAccountKey: JSON.stringify({ client_email: 'a@b.c', private_key: 'k' }) },
      settings: { projectId: 'p', location: 'us-central1' },
    } as any);
    const model: any = await runtime.createChatModel({
      modelId: 'gemini-2.5-pro',
      modelSettings: { maxTokens: 1000, reasoning: { effort: 'high' } },
    });
    expect(model.maxOutputTokens).toBeGreaterThan(16384);
  });
});

describe('reasoning: hiding on the chat-completions adapter', () => {
  const message = () => new AIMessage({
    content: 'The answer is 4.',
    additional_kwargs: { reasoning_content: 'two plus two' },
  });

  it('non-stream: shown by default, removed with includeReasoning:false', () => {
    const shown = toOpenAIChatResponse(message(), { model: 'm' }) as any;
    expect(shown.choices[0].message.reasoning_content).toBe('two plus two');
    const hidden = toOpenAIChatResponse(message(), { model: 'm', includeReasoning: false }) as any;
    expect(hidden.choices[0].message).not.toHaveProperty('reasoning_content');
    expect(hidden.choices[0].message).not.toHaveProperty('reasoning');
    expect(hidden.choices[0].message.content).toBe('The answer is 4.');
  });

  it('non-stream: leaked inline <reasoning> is stripped from content and hidden too', () => {
    const leaky = new AIMessage({ content: '<reasoning>secret plan</reasoning>done' });
    const hidden = toOpenAIChatResponse(leaky, { model: 'm', includeReasoning: false }) as any;
    expect(hidden.choices[0].message.content).toBe('done');
    expect(JSON.stringify(hidden)).not.toContain('secret plan');
  });

  it('stream: reasoning deltas disappear, content stays', () => {
    const chunk = new AIMessageChunk({ content: 'Hi', additional_kwargs: { reasoning_content: 'thinking...' } });
    const shown = toOpenAIStreamChunk(chunk, { model: 'm', stream: true }) as any;
    expect(shown.choices[0].delta.reasoning_content).toBe('thinking...');
    const hidden = toOpenAIStreamChunk(chunk, { model: 'm', stream: true, includeReasoning: false }) as any;
    expect(hidden.choices[0].delta).toEqual({ content: 'Hi' });
  });
});

describe('reasoning: hiding and precedence through handleChatCompletion', () => {
  const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', modelKey: 'm', projectId: 'proj-1' };
  const makeModel = (settings: Record<string, unknown>) => ({
    _id: 'id', tenantId: 'tenant-1', projectId: 'proj-1', name: 'M', key: 'm',
    providerKey: 'p', providerDriver: 'openai', category: 'llm' as const, modelId: 'gpt-4o',
    settings, pricing: { inputPer1k: 0, outputPer1k: 0 },
  });
  const useRuntime = (chat: Record<string, unknown>) => {
    const createChatModel = vi.fn().mockResolvedValue(chat);
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: { createChatModel } });
    return createChatModel;
  };
  const replyMessage = () => new AIMessage({
    content: 'Answer',
    additional_kwargs: { reasoning_content: 'chain of thought' },
    usage_metadata: { input_tokens: 3, output_tokens: 9, total_tokens: 12 },
  });
  const sse = async (stream: ReadableStream) => {
    const text = await new Response(stream).text();
    return text.split('\n').filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(5)));
  };

  beforeEach(() => vi.clearAllMocks());

  it('model default reaches the client constructor ahead of the request value', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel({ reasoning: { effort: 'high' } }));
    const create = useRuntime({ invoke: vi.fn().mockResolvedValue(replyMessage()) });
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'low' } });
    expect(create.mock.calls[0][0].modelSettings.reasoning).toEqual({ effort: 'high' });
  });

  it('request value is used when the model has none; nothing is sent when neither', async () => {
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel({}));
    const create = useRuntime({ invoke: vi.fn().mockResolvedValue(replyMessage()) });
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'low' } });
    expect(create.mock.calls[0][0].modelSettings.reasoning).toEqual({ effort: 'low' });

    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }] } });
    expect(create.mock.calls[1][0].modelSettings.reasoning).toBeUndefined();
  });

  it('non-stream: returned by default, hidden by the model switch, hidden by include_reasoning:false', async () => {
    const body = { messages: [{ role: 'user', content: 'x' }] };
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel({}));
    useRuntime({ invoke: vi.fn().mockResolvedValue(replyMessage()) });
    let res: any = await handleChatCompletion({ ...BASE, body });
    expect(res.response.choices[0].message.reasoning_content).toBe('chain of thought');

    res = await handleChatCompletion({ ...BASE, body: { ...body, include_reasoning: false } });
    expect(res.response.choices[0].message).not.toHaveProperty('reasoning_content');

    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel({ returnReasoning: false }));
    res = await handleChatCompletion({ ...BASE, body });
    expect(res.response.choices[0].message).not.toHaveProperty('reasoning_content');
    // A request cannot re-enable what the Model Hub hid.
    res = await handleChatCompletion({ ...BASE, body: { ...body, include_reasoning: true } });
    expect(res.response.choices[0].message).not.toHaveProperty('reasoning_content');
    // Tokens are still accounted for.
    expect(res.response.usage.completion_tokens).toBe(9);
  });

  const streamChunks = () => (async function* () {
    yield new AIMessageChunk({ content: '', additional_kwargs: { reasoning_content: 'chain of thought' } });
    yield new AIMessageChunk({ content: 'Answer' });
  })();

  it('stream: reasoning frames appear by default and are absent when hidden', async () => {
    const body = { messages: [{ role: 'user', content: 'x' }] };
    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel({}));
    useRuntime({ invoke: vi.fn(), stream: vi.fn().mockImplementation(async () => streamChunks()) });
    let res: any = await handleChatCompletion({ ...BASE, body, stream: true });
    let frames = await sse(res.stream);
    expect(frames.some((f) => f.choices?.[0]?.delta?.reasoning_content === 'chain of thought')).toBe(true);

    res = await handleChatCompletion({ ...BASE, body: { ...body, include_reasoning: false }, stream: true });
    frames = await sse(res.stream);
    expect(JSON.stringify(frames)).not.toContain('chain of thought');
    expect(frames.map((f) => f.choices?.[0]?.delta?.content).join('')).toContain('Answer');

    (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(makeModel({ returnReasoning: false }));
    res = await handleChatCompletion({ ...BASE, body, stream: true });
    frames = await sse(res.stream);
    expect(JSON.stringify(frames)).not.toContain('chain of thought');
  });
});

describe('reasoning: /messages (Anthropic dialect)', () => {
  it('request thinking is translated into the gateway reasoning fields', () => {
    const base = { model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
    expect(anthropicRequestToOpenAi({ ...base, thinking: { type: 'enabled', budget_tokens: 2000 } }).reasoning)
      .toEqual({ budget_tokens: 2000 });
    expect(anthropicRequestToOpenAi({ ...base, thinking: { type: 'disabled' } }).reasoning_effort).toBe('none');
    expect(anthropicRequestToOpenAi(base)).not.toHaveProperty('reasoning');
  });

  it('non-stream: a thinking block is emitted when reasoning_content is present, none when hidden', () => {
    const shown = openAiResponseToAnthropic({
      id: 'c1', model: 'm',
      choices: [{ message: { content: 'Answer', reasoning_content: 'because' }, finish_reason: 'stop' }],
    }, 'm') as any;
    expect(shown.content[0]).toEqual({ type: 'thinking', thinking: 'because', signature: '' });
    expect(shown.content[1]).toEqual({ type: 'text', text: 'Answer' });

    const hidden = openAiResponseToAnthropic({
      id: 'c1', model: 'm',
      choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }],
    }, 'm') as any;
    expect(hidden.content.map((b: any) => b.type)).toEqual(['text']);
  });

  const toSse = (frames: unknown[]) => new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  const blockTypes = async (frames: unknown[]) => {
    const text = await new Response(openAiStreamToAnthropic(toSse(frames), 'm')).text();
    return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  };

  it('stream: thinking block opens before the text block and closes first; absent when hidden', async () => {
    const withReasoning = await blockTypes([
      { id: 'c', model: 'm', choices: [{ delta: { reasoning_content: 'hm' } }] },
      { id: 'c', model: 'm', choices: [{ delta: { content: 'Hi' } }] },
      { id: 'c', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const starts = withReasoning.filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type);
    expect(starts).toEqual(['thinking', 'text']);
    expect(withReasoning.some((e) => e.delta?.type === 'thinking_delta' && e.delta.thinking === 'hm')).toBe(true);
    const thinkingStop = withReasoning.findIndex((e) => e.type === 'content_block_stop' && e.index === 0);
    const textStart = withReasoning.findIndex((e) => e.type === 'content_block_start' && e.index === 1);
    expect(thinkingStop).toBeGreaterThan(-1);
    expect(thinkingStop).toBeLessThan(textStart);

    // The gateway removed reasoning_content, so no thinking block exists.
    const hidden = await blockTypes([
      { id: 'c', model: 'm', choices: [{ delta: { content: 'Hi' } }] },
      { id: 'c', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    expect(hidden.filter((e) => e.type === 'content_block_start').map((e) => e.content_block.type)).toEqual(['text']);
  });
});
