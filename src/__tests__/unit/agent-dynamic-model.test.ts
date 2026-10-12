/**
 * An agent whose model is a Dynamic LLM routes every model call through the routing engine
 * (dynamicChatModel.ts): the rules - caller conditions included - decide per call, the child's
 * answer, tool calls and usage come back in the shape the agent loop reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';

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
import { createDynamicChatModel, toOpenAiMessages } from '@/lib/services/agents/dynamicChatModel';
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
    expect(portal.tool_calls?.[0]).toMatchObject({ name: 'lookup', args: { q: 'x' } });
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

  it('converts LangChain and SDK-shaped messages to OpenAI messages', () => {
    expect(toOpenAiMessages([
      { role: 'system', content: 's' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'lookup', args: { q: 1 } }] },
      { role: 'tool', content: 'r', tool_call_id: 'c1' },
    ])).toEqual([
      { role: 'system', content: 's' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
      { role: 'tool', content: 'r', tool_call_id: 'c1' },
    ]);
  });
});
