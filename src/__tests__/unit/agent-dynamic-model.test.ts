/**
 * An agent whose model is a Dynamic LLM routes every model call through the routing engine
 * (dynamicChatModel.ts): the rules - caller conditions included - decide per call, the child's
 * answer, tool calls and usage come back in the shape the agent loop reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';

vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: vi.fn() }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: vi.fn() }));
vi.mock('@/lib/services/models/semanticCacheService', () => ({
  buildCacheVariantKey: vi.fn().mockReturnValue('v'),
  isSemanticCacheEnabled: vi.fn().mockReturnValue(false),
  lookupCache: vi.fn().mockResolvedValue({ hit: false, response: null }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: vi.fn().mockResolvedValue(undefined),
}));
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
  createStreamGate: vi.fn(),
}));

import { getModelByKey } from '@/lib/services/models/modelService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
import { runWithRoutingCaller } from '@/lib/services/models/routingCallerContext';
import { createDynamicChatModel } from '@/lib/services/agents/dynamicChatModel';
import { withModelUsageLogging } from '@/lib/services/agents/modelUsageTap';
import { logModelUsage } from '@/lib/services/models/usageLogger';

const llm = (key: string, extra: object = {}) => ({
  _id: `${key}-id`, tenantId: 't', projectId: 'p', name: key, key, providerKey: `prov-${key}`, providerDriver: 'openai',
  category: 'llm' as const, modelId: key, settings: {}, pricing: { inputTokenPer1M: 10, outputTokenPer1M: 30 }, ...extra,
});
const router = llm('router', {
  providerKey: 'dynamic', providerDriver: 'dynamic',
  settings: {
    dynamic: {
      strategy: 'rule-based',
      defaultModelKey: 'small',
      rules: [{ label: 'portal', targetModelKey: 'big', matchType: 'all', conditions: [{ signal: 'channel', operator: 'in', value: ['portal'] }] }],
    },
  },
});
const models: Record<string, unknown> = { router, big: llm('big'), small: llm('small') };
const deps = { tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', modelKey: 'router' };

beforeEach(() => {
  vi.clearAllMocks();
  (getModelByKey as ReturnType<typeof vi.fn>).mockImplementation(async (_db: string, key: string) => models[key] ?? null);
  (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(async (_db: string, _t: string, providerKey: string) => ({
    runtime: {
      createChatModel: vi.fn().mockResolvedValue({
        invoke: vi.fn().mockResolvedValue(new AIMessage({
          content: `answered by ${providerKey}`,
          tool_calls: [{ id: 'c1', name: 'lookup', args: { q: 'x' }, type: 'tool_call' }],
          usage_metadata: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
        })),
      }),
    },
  }));
});

describe('agent run on a Dynamic LLM', () => {
  it('a rule on the caller channel picks the target per call; the answer and tool calls come back', async () => {
    const model = createDynamicChatModel(deps);
    const portal = await runWithRoutingCaller({ channel: 'portal' }, () => model.invoke([{ role: 'user', content: 'hi' }]));
    expect(portal.content).toBe('answered by prov-big');
    expect(portal.tool_calls?.[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } });
    expect(portal.usage).toMatchObject({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
    expect(portal.response_metadata).toMatchObject({ routedModel: 'big', routedBy: 'router' });

    const api = await runWithRoutingCaller({ channel: 'api' }, () => model.invoke([{ role: 'user', content: 'hi' }]));
    expect(api.content).toBe('answered by prov-small');
    expect(api.response_metadata).toMatchObject({ routedModel: 'small' });
  });

  it('the usage tap prices the call at the child, reports the routed model and leaves logging to the gateway', async () => {
    const onCost = vi.fn();
    const onRouted = vi.fn();
    const tapped = withModelUsageLogging(createDynamicChatModel(deps), {
      tenantDbName: 'tenant_x', model: router as never, route: 'agent.chat', onCost, onRouted,
    });
    await runWithRoutingCaller({ channel: 'portal' }, () => tapped.invoke([{ role: 'user', content: 'hi' }]));
    expect(onRouted).toHaveBeenCalledWith('big');
    expect(onCost).toHaveBeenCalledTimes(1);
    expect(onCost.mock.calls[0][0].totalCost).toBeGreaterThan(0);
    const routes = (logModelUsage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]?.route);
    expect(routes).not.toContain('agent.chat');
    expect(routes).toContain('chat.completions.router');
  });
});

describe('Dynamic LLM model as a native agent model', () => {
  const chatConfigs: Array<Record<string, unknown>> = [];
  const invokeArgs: unknown[][] = [];

  beforeEach(() => {
    chatConfigs.length = 0;
    invokeArgs.length = 0;
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(async (_db: string, _t: string, providerKey: string) => ({
      runtime: {
        createChatModel: vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
          chatConfigs.push(config);
          return {
            bindTools() { return this; },
            invoke: vi.fn().mockImplementation(async (...args: unknown[]) => {
              invokeArgs.push(args);
              return new AIMessage({ content: `answered by ${providerKey}`, usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
            }),
            async *stream() {
              yield new AIMessageChunk({ content: 'Hel' });
              yield new AIMessageChunk({ content: 'lo' });
              yield new AIMessageChunk({
                content: '',
                tool_call_chunks: [{ index: 0, id: 'call_1', name: 'lookup', args: '{"q":', type: 'tool_call_chunk' }],
              });
              yield new AIMessageChunk({
                content: '',
                tool_call_chunks: [{ index: 0, args: '"x"}', type: 'tool_call_chunk' }],
                usage_metadata: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
              });
            },
          };
        }),
      },
    }));
  });

  it('streams: text deltas, then ONE assembled message with the tool call, usage and routing', async () => {
    const model = createDynamicChatModel(deps);
    const chunks: unknown[] = [];
    await runWithRoutingCaller({ channel: 'portal' }, async () => {
      for await (const chunk of model.stream([{ role: 'user', content: 'hi' }])) chunks.push(chunk);
    });
    expect(chunks.filter((c) => typeof c === 'string').join('')).toBe('Hello');
    const finals = chunks.filter((c) => typeof c === 'object' && (c as { role?: string }).role);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      role: 'assistant',
      content: 'Hello',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      response_metadata: { routedModel: 'big', routedBy: 'router' },
    });
    expect((finals[0] as { response_metadata: { routedCost: { totalCost: number } } }).response_metadata.routedCost.totalCost).toBeGreaterThan(0);
  });

  it('binds SDK tools into the gateway body as OpenAI function tools', async () => {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');
    const lookup = createTool({ name: 'lookup', description: 'Find a thing', schema: z.object({ q: z.string() }), func: async () => 'ok' });
    const bound = createDynamicChatModel(deps).bindTools([lookup]);
    await runWithRoutingCaller({ channel: 'api' }, () => bound.invoke([{ role: 'user', content: 'hi' }]));
    // The routed child received the tool through the gateway's own request handling.
    const child = chatConfigs[0];
    expect(child).toBeDefined();
    const callOptions = invokeArgs[0]?.[1] as { tools?: Array<{ function?: { name?: string } }> } | undefined;
    expect(JSON.stringify(callOptions?.tools ?? invokeArgs[0])).toContain('lookup');
  });

  it('carries the agent reasoning to the routed model', async () => {
    const model = createDynamicChatModel({ ...deps, reasoning: { effort: 'high' } });
    await runWithRoutingCaller({ channel: 'api' }, () => model.invoke([{ role: 'user', content: 'hi' }]));
    expect(chatConfigs[0]).toMatchObject({ modelSettings: { reasoning: { effort: 'high' } } });
  });

  it('applies the agent sampling overrides to the routed call', async () => {
    const model = createDynamicChatModel({ ...deps, overrides: { temperature: 0.3, max_tokens: 77 } });
    await runWithRoutingCaller({ channel: 'api' }, () => model.invoke([{ role: 'user', content: 'hi' }]));
    expect(chatConfigs[0]).toMatchObject({ modelSettings: { temperature: 0.3, maxTokens: 77 } });
  });

  it('a call made while another is in flight keeps its own routing facts', async () => {
    const model = createDynamicChatModel(deps);
    const pa = runWithRoutingCaller({ channel: 'portal' }, () => model.invoke([{ role: 'user', content: 'a' }]));
    const pb = runWithRoutingCaller({ channel: 'api' }, () => model.invoke([{ role: 'user', content: 'b' }]));
    const [a, b] = await Promise.all([pa, pb]);
    expect(a.response_metadata).toMatchObject({ routedModel: 'big' });
    expect(b.response_metadata).toMatchObject({ routedModel: 'small' });
  });

  it('a stream that fails midway rejects the call instead of ending quietly', async () => {
    (buildModelRuntime as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      runtime: {
        createChatModel: vi.fn().mockResolvedValue({
          async *stream() {
            yield new AIMessageChunk({ content: 'par' });
            throw new Error('upstream exploded');
          },
        }),
      },
    }));
    const model = createDynamicChatModel(deps);
    const run = async () => {
      for await (const chunk of model.stream([{ role: 'user', content: 'hi' }])) void chunk;
    };
    await expect(runWithRoutingCaller({ channel: 'api' }, run)).rejects.toThrow(/invalid|failed|exploded/i);
  });

  it('is marked as a routed model and exposes the key as its name', () => {
    const model = createDynamicChatModel(deps) as unknown as Record<string, unknown>;
    expect(model.__dynamicRouted).toBe(true);
    expect(model.modelName).toBe('router');
  });
});
