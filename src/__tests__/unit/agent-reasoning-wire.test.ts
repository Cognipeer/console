/**
 * The reasoning precedence on the wire. An agent model is built exactly
 * as a run builds it and the request body it sends is read back:
 *   agent pick > Model Hub default > API request > nothing sent.
 * Also: the title is forced to "none" above every rung, and a Dynamic LLM
 * carries the agent / request value to the model it routes to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import { completion as completionBody, json, stubUpstream, type Upstream } from '../helpers/nativeGateway';

const hoisted = vi.hoisted(() => ({
  getModelByKey: vi.fn(),
  logModelUsage: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/models/usageLogger')>()),
  logModelUsage: hoisted.logModelUsage,
}));
vi.mock('@/lib/services/models/dynamicRoutingState', () => ({
  getConversationState: vi.fn().mockResolvedValue({}),
  getConversationCostUsd: vi.fn().mockResolvedValue(0),
  getRouterSpendUsd: vi.fn().mockResolvedValue(0),
  getSegmentIoRatio: vi.fn().mockReturnValue(undefined),
  getModelProfiles: vi.fn().mockResolvedValue(new Map()),
  recordRoutedUsage: vi.fn().mockResolvedValue(undefined),
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

import { buildAgentChatModel } from '@/lib/services/agents/agentService';
import { generateConversationTitle } from '@/lib/services/agents/conversationTitle';

// `modelId` is the upstream id, `key` the console's: a caller's own effort only reaches a model that reasons.
const model = (key: string, settings: Record<string, unknown> = {}, modelId = 'o3') => ({
  _id: key, tenantId: 't', projectId: 'p', name: key, key, providerKey: 'prov', providerDriver: 'openai',
  category: 'llm', modelId, settings, pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
});

let upstream: Upstream;
const serve = () => { upstream = stubUpstream(() => json(completionBody({ content: 'ok', usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }))); };
const lastBody = () => upstream.calls.at(-1)!.body;

/** Builds the model the way a run does and returns the `reasoning_effort` that went out. */
async function sentEffort(input: { hub?: string; agent?: string; request?: string }) {
  hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(
    key, input.hub ? { reasoning: { effort: input.hub } } : {},
  ));
  const { chatModel } = await buildAgentChatModel(
    'tenant_x', 't', 'p', 'gpt-4o', {},
    input.agent ? { effort: input.agent as 'low' } : undefined,
    input.request ? { effort: input.request as 'low' } : undefined,
  );
  await chatModel.invoke([{ role: 'user', content: 'hi' }]);
  return lastBody().reasoning_effort as string | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.logModelUsage.mockResolvedValue(undefined);
  serve();
});
afterEach(() => vi.unstubAllGlobals());

describe('reasoning_effort on the wire', () => {
  it.each([
    ['agent + Model Hub + request: the agent wins', { agent: 'low', hub: 'high', request: 'minimal' }, 'low'],
    ['Model Hub + request: Model Hub wins', { hub: 'high', request: 'minimal' }, 'high'],
    ['request only: the request is used', { request: 'minimal' }, 'minimal'],
    ['agent over request', { agent: 'medium', request: 'low' }, 'medium'],
    ['agent over Model Hub', { agent: 'low', hub: 'high' }, 'low'],
    ['Model Hub only', { hub: 'medium' }, 'medium'],
    ['nothing set: nothing is sent', {}, undefined],
  ] as const)('%s', async (_name, input, expected) => {
    expect(await sentEffort(input)).toBe(expected);
  });

  it('an agent "none" is sent (it is a value, not an absence)', async () => {
    expect(await sentEffort({ agent: 'none', hub: 'high' })).toBe('none');
  });
});

describe('title generation', () => {
  it('forces reasoning off above the agent pick, the Model Hub default and the request', async () => {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => model(key, { reasoning: { effort: 'high' } }, 'gpt-5.2'));
    await generateConversationTitle({
      tenantDbName: 'tenant_x', tenantId: 't', projectId: 'p', modelKey: 'gpt-4o', agentKey: 'a1',
      exchange: { user: 'plan my trip', assistant: 'sure' },
    });
    expect(upstream.calls[0].body.reasoning_effort).toBe('none');
  });
});

describe('Dynamic LLM', () => {
  const router = (key: string) => ({
    ...model(key, { dynamic: { strategy: 'rule-based', defaultModelKey: 'small', rules: [] } }),
    providerKey: 'dynamic', providerDriver: 'dynamic',
  });
  /** The agent / request reasoning goes to whichever model the call is routed to, and is read there. */
  async function routedEffort(input: { hub?: string; agent?: string; request?: string }) {
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) =>
      key === 'router' ? router(key) : model(key, input.hub ? { reasoning: { effort: input.hub } } : {}, 'o3-mini'));
    const { chatModel } = await buildAgentChatModel(
      'tenant_x', 't', 'p', 'router', {},
      input.agent ? { effort: input.agent as 'low' } : undefined,
      input.request ? { effort: input.request as 'low' } : undefined,
    );
    await chatModel.invoke([{ role: 'user', content: 'hi' }]);
    expect(upstream.calls.at(-1)!.body.model).toBe('o3-mini');
    return lastBody().reasoning_effort as string | undefined;
  }

  it.each([
    ['the agent pick outranks the routed model\'s Model Hub default', { agent: 'low', hub: 'high', request: 'minimal' }, 'low'],
    ['without an agent pick the routed model\'s Model Hub default wins', { hub: 'high', request: 'minimal' }, 'high'],
    ['the request value is used when nothing else is set', { request: 'high' }, 'high'],
    ['nothing set: nothing is sent', {}, undefined],
  ] as const)('%s', async (_name, input, expected) => {
    expect(await routedEffort(input)).toBe(expected);
  });
});
