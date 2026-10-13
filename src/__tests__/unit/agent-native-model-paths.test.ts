/**
 * The agent entry points that build a chat model - conversation titles, the
 * Configure page's model check, sub-agent overrides and the Dynamic LLM branch
 * of `buildAgentChatModel` - all call the gateway core in process: the request
 * leaves through the gateway's native provider client, and the core writes the
 * usage row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import { completion as completionBody, json, stubUpstream, flush, type Upstream } from '../helpers/nativeGateway';

const hoisted = vi.hoisted(() => ({
  getModelByKey: vi.fn(),
  logModelUsage: vi.fn(),
}));

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return {
    ...actual,
    getConfig: () => {
      const config = actual.getConfig();
      return { ...config, gateway: { ...config.gateway, retryEnabled: true, retryMaxAttempts: 2, retryInitialDelayMs: 1, circuitBreakerEnabled: false } };
    },
  };
});
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: hoisted.logModelUsage,
}));
vi.mock('@/lib/services/agents/agentSpendLimits', () => ({
  resolveAgentSpendScope: vi.fn().mockResolvedValue(undefined),
  assertAgentSpendAllowed: vi.fn().mockResolvedValue(undefined),
  agentSpendSettler: vi.fn().mockReturnValue(vi.fn()),
}));
vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: async () => ({
    runtime: await (OpenAiModelProviderContract.createRuntime as (ctx: unknown) => unknown)({
      tenantId: 't', projectId: 'p', providerKey: 'prov', credentials: { apiKey: 'sk-live' }, settings: {}, metadata: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }),
    record: { key: 'prov', driver: 'openai' },
  }),
}));

import { buildAgentChatModel, checkAgentModel, extractAgentReasoning } from '@/lib/services/agents/agentService';
import { generateConversationTitle } from '@/lib/services/agents/conversationTitle';

const model = (modelId: string, extra: Record<string, unknown> = {}) => ({
  _id: modelId, tenantId: 't', projectId: 'p', name: modelId, key: modelId, providerKey: 'prov', providerDriver: 'openai',
  category: 'llm', modelId, settings: {}, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 }, ...extra,
});

const answer = (content: string) => json(completionBody({ content, usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }));

let upstream: Upstream;
beforeEach(() => {
  vi.clearAllMocks();
  hoisted.logModelUsage.mockResolvedValue(undefined);
  upstream = stubUpstream(() => answer('Trip planning help'));
  hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => (key === 'missing' ? null : model(key)));
});
afterEach(() => vi.unstubAllGlobals());

describe('conversation titles', () => {
  const input = { tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', modelKey: 'gpt-4o', agentKey: 'a1', exchange: { user: 'plan my trip', assistant: 'sure, where to?' } };

  it('asks the model through the gateway with a tight budget, and the gateway records ONE title usage row', async () => {
    const title = await generateConversationTitle(input);
    expect(title).toBe('Trip planning help');

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(upstream.calls[0].body).toMatchObject({ model: 'gpt-4o', max_tokens: 40, temperature: 0.2 });

    await vi.waitFor(() => expect(hoisted.logModelUsage).toHaveBeenCalled());
    await flush();
    expect(hoisted.logModelUsage).toHaveBeenCalledTimes(1);
    expect(hoisted.logModelUsage.mock.calls[0][2]).toMatchObject({
      route: 'agent.title', status: 'success', usage: { inputTokens: 20, outputTokens: 4 },
      providerRequest: { purpose: 'title', agentKey: 'a1' },
    });
  });

  it('a reasoning model gets max_completion_tokens and no temperature', async () => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key));
    await generateConversationTitle({ ...input, modelKey: 'gpt-5.2' });
    const body = upstream.calls[0].body;
    expect(body.max_completion_tokens).toBe(40);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('is null (never a thrown error) when the provider fails', async () => {
    upstream = stubUpstream(() => new Response('nope', { status: 500 }));
    expect(await generateConversationTitle(input)).toBeNull();
  });
});

describe('model check', () => {
  it('passes when the model answers', async () => {
    const result = await checkAgentModel('tenant_x', 't', 'p', 'gpt-4o');
    expect(result.ok).toBe(true);
    expect(upstream.calls[0].body.messages).toEqual([{ role: 'user', content: 'Reply with the single word OK.' }]);
  });

  it('reports a rejected key with its type, not a stack', async () => {
    upstream = stubUpstream(() => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }));
    const result = await checkAgentModel('tenant_x', 't', 'p', 'gpt-4o');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBeTruthy();
  });

  it('fails for a model that does not exist', async () => {
    const result = await checkAgentModel('tenant_x', 't', 'p', 'missing');
    expect(result).toMatchObject({ ok: false });
  });
});

describe('buildAgentChatModel', () => {
  it('builds a gateway model for a provider-backed model, whose settings reach the upstream', async () => {
    const { model: record, chatModel } = await buildAgentChatModel('tenant_x', 't', 'p', 'gpt-4o', { temperature: 0.7 });
    expect(record.key).toBe('gpt-4o');
    await chatModel.invoke([{ role: 'user', content: 'hi' }]);
    expect(upstream.calls[0].body).toMatchObject({ model: 'gpt-4o', temperature: 0.7 });
  });

  it('builds the same gateway model for a Dynamic LLM: nothing leaves until a call is routed', async () => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key, {
      providerKey: 'dynamic', providerDriver: 'dynamic',
      settings: { dynamic: { strategy: 'rule-based', defaultModelKey: 'small', rules: [] } },
    }));
    const { chatModel } = await buildAgentChatModel('tenant_x', 't', 'p', 'router', {}, { effort: 'low' });
    expect((chatModel as unknown as Record<string, unknown>).__gatewayModel).toBe(true);
    expect(upstream.fetch).not.toHaveBeenCalled();
  });

  it('refuses a model that is not a chat model', async () => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key, { category: 'embedding' }));
    await expect(buildAgentChatModel('tenant_x', 't', 'p', 'emb')).rejects.toThrow(/not compatible with chat/);
  });
});

describe('reasoning trace reading', () => {
  it('reads reasoning.summary off the last assistant message of a native turn', () => {
    expect(extractAgentReasoning({ messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', reasoning: { summary: 'because', blocks: [] } },
    ] } as never)).toBe('because');
  });

  it('still reads a turn saved before native providers (additional_kwargs.reasoning_content)', () => {
    expect(extractAgentReasoning({ messages: [
      { role: 'assistant', content: 'a', additional_kwargs: { reasoning_content: 'old way' } },
    ] } as never)).toBe('old way');
  });

  it('does not reach back past the final assistant message, and is undefined when there is none', () => {
    expect(extractAgentReasoning({ messages: [
      { role: 'assistant', content: 'earlier', reasoning: { summary: 'old turn' } },
      { role: 'tool', content: 'r', tool_call_id: 'c' },
      { role: 'assistant', content: 'final' },
    ] } as never)).toBeUndefined();
    expect(extractAgentReasoning({ messages: [] } as never)).toBeUndefined();
  });
});
