/**
 * The per-model "Upstream API" setting: Chat Completions (default) or Responses,
 * chosen explicitly, never inferred. Plus the Claude thought-text request that
 * follows the reasoning-visibility rule.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeModelCall, handleChatCompletion } from '@/lib/services/models/inferenceService';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { anthropicRuntime, completion, json, openAiRuntime, stubUpstream } from '../helpers/nativeGateway';
import { validateUpstreamApi, resolveUpstreamApi } from '@/lib/services/models/upstreamApi';
import { withReasoningVisibility } from '@/lib/services/models/reasoning';

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return {
        ...config,
        gateway: {
          ...config.gateway,
          retryEnabled: true,
          retryMaxAttempts: 3,
          retryInitialDelayMs: 1,
          circuitBreakerEnabled: false,
        },
      };
    },
  };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('variant-key'),
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
vi.mock('@/lib/services/guardrail/hooks/recordCache', () => ({ getCachedGuardrail: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/services/guardrail', () => ({
  evaluateGuardrail: vi.fn().mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  }),
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { isSemanticCacheEnabled, lookupCache, storeInCache } from '@/lib/services/models/semanticCacheService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import { createStreamGate, evaluateGuardrail } from '@/lib/services/guardrail';


const model = (overrides: object = {}) => ({
  _id: 'm1', tenantId: 'tenant-1', projectId: 'proj-1', name: 'M', key: 'm', providerKey: 'prov',
  providerDriver: 'openai', category: 'llm' as const, modelId: 'gpt-4o', settings: {},
  pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 }, ...overrides,
});
const BASE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', modelKey: 'm' };
const ASK = { messages: [{ role: 'user' as const, content: 'hello' }] };
const stubModel = (m: object) => (getModelByKey as ReturnType<typeof vi.fn>).mockResolvedValue(m);

const responsesAnswer = () => json({
  id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-5',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking it over' }] },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
  ],
  usage: { input_tokens: 5, output_tokens: 20, total_tokens: 25, output_tokens_details: { reasoning_tokens: 12 } },
});

let openai: ModelProviderRuntime;
let anthropic: ModelProviderRuntime;
beforeAll(async () => {
  openai = await openAiRuntime({});
  anthropic = await anthropicRuntime();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  (isSemanticCacheEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (lookupCache as ReturnType<typeof vi.fn>).mockResolvedValue({ hit: false, response: null });
  (evaluateGuardrail as ReturnType<typeof vi.fn>).mockResolvedValue({
    passed: true, blocked: false, action: 'allow', findings: [], guardrailKey: 'g', guardrailName: 'g',
  });
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: openai });
});
afterEach(() => vi.unstubAllGlobals());

describe('upstreamApi setting', () => {
  it('defaults to chat and only knows chat and responses', () => {
    expect(resolveUpstreamApi({})).toBe('chat');
    expect(resolveUpstreamApi(undefined)).toBe('chat');
    expect(resolveUpstreamApi({ upstreamApi: 'Responses' })).toBe('responses');
    expect(resolveUpstreamApi({ upstreamApi: 'banana' })).toBe('chat');
  });

  it('validates: responses only for the OpenAI-schema drivers, and only known values', () => {
    for (const driver of ['openai', 'azure', 'openai-compatible', 'together']) {
      expect(validateUpstreamApi({ upstreamApi: 'responses' }, driver)).toBeUndefined();
    }
    for (const driver of ['anthropic', 'bedrock', 'vertex']) {
      expect(validateUpstreamApi({ upstreamApi: 'responses' }, driver)).toMatch(/only available/);
      expect(validateUpstreamApi({ upstreamApi: 'chat' }, driver)).toBeUndefined();
    }
    expect(validateUpstreamApi({ upstreamApi: 'banana' }, 'openai')).toMatch(/must be one of/);
    expect(validateUpstreamApi({}, 'anthropic')).toBeUndefined();
  });

  it('is handed to the native provider as `api`, and never picked from the model id', () => {
    const spec = (modelId: string, modelSettings: Record<string, unknown>) =>
      openai.createNativeProviderSpec!({ modelId, category: 'llm', modelSettings } as never).provider as { api?: string };
    expect(spec('gpt-5-codex', {}).api).toBe('chat');
    expect(spec('gpt-4o', { upstreamApi: 'responses' }).api).toBe('responses');
  });
});

describe('a chat-completions request over a Responses upstream', () => {
  it('goes to /responses and the client still receives a chat.completion, with reasoning when allowed', async () => {
    stubModel(model({ modelId: 'gpt-5', settings: { upstreamApi: 'responses' } }));
    const upstream = stubUpstream(() => responsesAnswer());
    const result = await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'hello' }] } });
    expect(upstream.calls[0].url).toMatch(/\/responses$/);
    const body = (result as { response: any }).response ?? result;
    const choice = body.choices[0];
    expect(body.object).toBe('chat.completion');
    expect(choice.message.content).toBe('hi there');
    expect(choice.message.reasoning_content).toBe('thinking it over');
    expect(body.usage.completion_tokens_details?.reasoning_tokens ?? body.usage.reasoning_tokens).toBe(12);
  });

  it('asks the Responses upstream for a reasoning summary when the caller sets reasoning_effort (openai-compatible)', async () => {
    stubModel(model({ providerDriver: 'openai-compatible', modelId: 'gpt-5.6-luna', settings: { upstreamApi: 'responses' } }));
    const upstream = stubUpstream(() => responsesAnswer());
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'high' } });
    expect(upstream.calls[0].url).toMatch(/\/responses$/);
    expect(upstream.calls[0].body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('keeps the reasoning text out when the Model Hub hides it', async () => {
    stubModel(model({ modelId: 'gpt-5', settings: { upstreamApi: 'responses', returnReasoning: false } }));
    stubUpstream(() => responsesAnswer());
    const result = await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'hello' }] } });
    const body = (result as { response: any }).response ?? result;
    expect(body.choices[0].message.reasoning_content).toBeUndefined();
  });

  it('calls /chat/completions when the setting is unset, even for a model id that is Responses-first', async () => {
    stubModel(model({ modelId: 'gpt-5-codex', settings: {} }));
    const upstream = stubUpstream(() => json(completion()));
    await executeModelCall({ ...BASE, request: ASK });
    expect(upstream.calls[0].url).toMatch(/\/chat\/completions$/);
  });
});

describe('Claude thought text follows the visibility rule', () => {
  const claude = (settings: object = {}) => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    stubModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-5-5', settings: { maxTokens: 9000, reasoning: { effort: 'low' }, ...settings } }));
    return stubUpstream(() => json({
      id: 'msg_1', model: 'claude', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 },
    }));
  };

  it('asks for summarized thinking when the reasoning is visible', async () => {
    const upstream = claude();
    await executeModelCall({ ...BASE, request: ASK });
    expect(upstream.calls[0].body.thinking?.display).toBe('summarized');
  });

  it('does not ask for it when the Model Hub hides the reasoning', async () => {
    const upstream = claude({ returnReasoning: false });
    await executeModelCall({ ...BASE, request: ASK });
    expect(upstream.calls[0].body.thinking).toBeDefined();
    expect(upstream.calls[0].body.thinking.display).toBeUndefined();
  });

  it('does not ask for it when the agent hides its reasoning', async () => {
    const upstream = claude();
    await executeModelCall({ ...BASE, request: ASK, context: { showReasoning: false } });
    expect(upstream.calls[0].body.thinking.display).toBeUndefined();
  });

  it('does not ask for it when the request opts out', async () => {
    const upstream = claude();
    await handleChatCompletion({ ...BASE, body: { messages: [{ role: 'user', content: 'x' }], include_reasoning: false } });
    expect(upstream.calls[0].body.thinking.display).toBeUndefined();
  });

  it('withReasoningVisibility leaves a call without reasoning alone', () => {
    expect(withReasoningVisibility(undefined, false)).toBeUndefined();
    expect(withReasoningVisibility<{ effort?: string; includeThoughts?: boolean }>({ effort: 'low' }, true, 'openai')).toEqual({ effort: 'low' });
    expect(withReasoningVisibility<{ effort?: string; includeThoughts?: boolean }>({ effort: 'low' }, false, 'openai')).toEqual({ effort: 'low', includeThoughts: false });
  });
});

describe('reasoning tokens reach the usage row', () => {
  it('records the thinking tokens the upstream reports', async () => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({ runtime: anthropic });
    stubModel(model({ providerDriver: 'anthropic', modelId: 'claude-sonnet-5-5', settings: { maxTokens: 9000, reasoning: { effort: 'low' } } }));
    stubUpstream(() => json({
      id: 'msg_1', model: 'claude', type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 40, output_tokens_details: { thinking_tokens: 31 } },
    }));
    await executeModelCall({ ...BASE, request: ASK });
    const row = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2];
    expect(JSON.stringify(row)).toMatch(/31/);
    expect(row.usage?.reasoningTokens ?? row.reasoningTokens).toBe(31);
  });
});
